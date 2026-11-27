import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { get, record, release } from './ownership.ts';
import { packageRoot } from './kitto-home.ts';
import { meetsBaseline, readVersion } from './version-order.ts';

export const LAUNCHER_NAME = 'kitto-node';
const MISE_KEPT = ['MISE_DATA_DIR', 'MISE_CONFIG_DIR', 'MISE_CACHE_DIR', 'MISE_STATE_DIR'];
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function engineFloor() {
  const range = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).engines?.node;
  const floor = typeof range === 'string' ? /^>=\s*(\d+\.\d+\.\d+)$/.exec(range)?.[1] : undefined;
  if (!floor) throw new Error(`Cannot read the Node floor from package.json engines.node (${JSON.stringify(range)}).`);
  return floor;
}

export function nodeVersionAt(path, env = process.env) {
  const result = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 15_000, env });
  return result.status === 0 ? readVersion(result.stdout) : null;
}

function miseEnv(env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) if (!key.startsWith('MISE_') || MISE_KEPT.includes(key)) clean[key] = value;
  return clean;
}

async function stableInstall(path) {
  const installDir = dirname(dirname(path));
  const parent = dirname(installDir);
  let target;
  try { target = await realpath(installDir); } catch { return path; }
  const names = await readdir(parent).catch(() => []);
  for (const name of names.filter(entry => /^\d+$/.test(entry)).sort()) {
    const candidate = join(parent, name);
    if (!(await lstat(candidate).catch(() => null))?.isSymbolicLink()) continue;
    if (await realpath(candidate).catch(() => null) !== target) continue;
    const stable = join(candidate, 'bin', basename(path));
    if (existsSync(stable)) return stable;
  }
  return path;
}

async function miseGlobalNode(env, home) {
  const result = spawnSync('mise', ['which', 'node'], { encoding: 'utf8', timeout: 15_000, cwd: home, env: miseEnv(env) });
  const found = result.status === 0 ? result.stdout.trim().split('\n').pop() : '';
  return found && found.startsWith('/') ? stableInstall(found) : undefined;
}

export async function resolveToolNode({ env = process.env, home = homedir(), execPath = process.execPath, floor = engineFloor() } = {}) {
  const rejected = [];
  const candidates = [];
  const mise = await miseGlobalNode(env, home);
  if (mise) candidates.push({ path: mise, source: 'mise' });
  candidates.push({ path: execPath, source: 'execPath' });
  for (const { path, source } of candidates) {
    const version = nodeVersionAt(path, env);
    if (version && meetsBaseline(version, floor)) return { path, version, source };
    rejected.push(`${path} (${version ? `v${version}` : 'does not run'}, from ${source})`);
  }
  throw new Error(`No Node >=${floor} found for Kitto's tool Node. Tried ${rejected.join('; ')}. Install a global Node >=${floor} (for example \`mise use --global node@26\`) and rerun kitto setup.`);
}

export const launcherPath = agentsHome => join(agentsHome, 'bin', LAUNCHER_NAME);

export function launcherContent(nodePath) {
  return [
    '#!/bin/sh',
    `KITTO_TOOL_NODE=${shellQuote(nodePath)}`,
    'if [ ! -x "$KITTO_TOOL_NODE" ]; then',
    '  echo "kitto-node: the Node recorded by Kitto is missing: $KITTO_TOOL_NODE. Rerun kitto setup." >&2',
    '  exit 127',
    'fi',
    'exec "$KITTO_TOOL_NODE" "$@"',
    '',
  ].join('\n');
}

const hashOf = content => createHash('sha256').update(content).digest('hex');

async function liveLauncher(state, target) {
  const stat = await lstat(target).catch(() => null);
  if (!stat) return { stat: null };
  const live = stat.isFile() ? await readFile(target, 'utf8') : undefined;
  const owned = live !== undefined && get(state, 'launcher', 'shared', LAUNCHER_NAME)?.hash === hashOf(live);
  return { stat, live, owned };
}

export async function planToolNode(state, resolved = undefined) {
  const toolNode = resolved ?? await resolveToolNode();
  const target = launcherPath(state.agentsHome);
  const content = launcherContent(toolNode.path);
  let action = 'write';
  const { stat, live, owned } = await liveLauncher(state, target);
  if (stat && !owned) action = 'keep';
  else if (stat && live === content && (stat.mode & 0o777) === 0o755) action = 'same';
  return { toolNode, target, content, hash: hashOf(content), action };
}

export function describeToolNode(plan) {
  const { toolNode, target, action } = plan;
  console.log(`tool node: ${toolNode.path} (v${toolNode.version}, ${toolNode.source})`);
  console.log(`launcher ${action}: ${target}`);
  if (action === 'keep') console.warn(`Warning: ${target} exists and is not an unmodified Kitto launcher. Preserved; commands that use it will not follow Kitto's tool Node.`);
}

export async function applyToolNode(state, plan) {
  state.toolNode = { ...plan.toolNode };
  if (plan.action === 'keep') return;
  await mkdir(dirname(plan.target), { recursive: true });
  await writeFile(plan.target, plan.content, { mode: 0o755 });
  await chmod(plan.target, 0o755);
  record(state, 'launcher', 'shared', LAUNCHER_NAME, plan.hash);
}

export async function planLauncherRemoval(state) {
  const target = launcherPath(state.agentsHome);
  const { stat, owned } = await liveLauncher(state, target);
  return { target, action: !stat ? 'absent' : owned ? 'remove' : 'keep' };
}

export async function applyLauncherRemoval(state, plan) {
  if (plan.action === 'remove') await rm(plan.target, { force: true });
  if (plan.action !== 'keep') release(state, 'launcher', 'shared', LAUNCHER_NAME);
  delete state.toolNode;
}
