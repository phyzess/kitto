import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, lstat, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyInstructions, hostSkillRoots, instructionPlan } from './host-config.mjs';
import { dependencyPlan, installDependencies } from './dependencies.mjs';
import { reportCodeGraphIndexes } from './codegraph.mjs';
import { applyCodexMcp, planCodexMcp, removeCodexMcp, sourceServers as codexMcpSource } from './codex-mcp.mjs';
import { printMcpParity } from './parity.mjs';
import { removeDshMcp, syncDshMcp } from './mcp-sync.mjs';
import { versionReport } from './versions.mjs';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const hosts = {
  pi: { package: '@earendil-works/pi-coding-agent', version: '1.5.2', node: '22.19.0' },
  codex: { package: '@openai/codex', version: '0.170.0' },
  dsh: { package: '@deepseek-ai/dsh', version: '0.2.2-rc.1', node: '24.9.0' },
};
export const pnpmVersion = '12.21.0'; // Required by the native DSH plugin manager.
const defaultSource = 'https://github.com/phyzess/kitto.git';
export const kittoHome = () => {
  // Native hosts do not need to inherit the shell used during setup.
  const installedHome = dirname(resolve(packageRoot));
  return resolve(process.env.KITTO_HOME || (existsSync(join(installedHome, 'state.json')) && resolve(packageRoot) === join(installedHome, 'runtime')
    ? installedHome : join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'kitto')));
};
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const present = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

/** Replace a skill directory without leaving a half-copied tree behind. */
export async function replaceDirectory(source, target) {
  const temporary = `${target}.kitto-tmp-${process.pid}`;
  const backup = `${target}.kitto-old-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  await cp(source, temporary, { recursive: true });
  const existed = await present(target);
  if (existed) await rename(target, backup);
  try {
    await rename(temporary, target);
  } catch (error) {
    if (existed) await rename(backup, target);
    throw error;
  }
  if (existed) await rm(backup, { recursive: true, force: true });
}
function sameLocation(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const canonical = path => {
    try { return realpathSync(path); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return resolve(path);
      throw error;
    }
  };
  return canonical(a) === canonical(b);
}

function run(command, args, { capture = false, ...options } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 600_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  return result.stdout?.trim() || '';
}
const git = (source, args) => run('git', ['-C', source, ...args], { capture: true, timeout: 30_000 });
const available = name => spawnSync(name, ['--version'], { stdio: 'ignore', timeout: 8000 }).status === 0;

export function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--dry-run', '--install-agents', '--recover', '--global'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--agents', '--source', '--ref', '--dsh-profile', '--workspace', '--workspace-parent', '--dsh-service'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('-')) options[arg.slice(2)] = args[++i];
    else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  if (options.agents) {
    options.agents = [...new Set(options.agents.split(','))];
    if (options.agents.some(name => !hosts[name])) throw new Error('Agents must be pi,codex,dsh.');
  }
  if (options.recover && Object.keys(options).some(key => !['recover', 'dry-run'].includes(key))) throw new Error('--recover only accepts --dry-run; it uses the saved installation.');
  return options;
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function locked(home, callback) {
  await mkdir(home, { recursive: true });
  const lock = join(home, '.lock');
  try { await mkdir(lock); } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`Another Kitto operation holds ${lock}. Remove it only after verifying that process has stopped.`);
    throw e;
  }
  try { return await callback(); } finally { await rm(lock, { recursive: true }); }
}

async function validateSource({ source, agents }) {
  if (git(source, ['rev-parse', '--show-toplevel']) !== await realpath(source)) throw new Error('Source must be the root of a Git checkout.');
  if (agents.includes('codex')) {
    try {
      await codexMcpSource(source);
    } catch (error) {
      throw new Error(`Codex MCP sync requires a readable Pi MCP source: ${error.message}`);
    }
  }
  if (!agents.includes('pi')) return;
  const settings = await json(join(source, 'config/pi/settings.json'));
  if (!Array.isArray(settings.packages)) throw new Error('Source lacks config/pi/settings.json packages.');
  await json(join(source, 'config/pi/mcp.json'));
  await readFile(join(source, 'config/pi/AGENTS.md'));
}

function checkHost(name) {
  const version = run(name, ['--version'], { capture: true, timeout: 8000 });
  const actual = version.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0];
  const expected = hosts[name].version;
  const numbers = value => value.split(/[.-]/).slice(0, 3).map(Number);
  const a = actual && numbers(actual), b = numbers(expected);
  if (!a || a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) {
    throw new Error(`${name}: found ${version}; validated baseline is ${expected}. Upgrade with its native manager first.`);
  }
  if (name === 'codex') {
    run(name, ['plugin', 'add', '--help'], { capture: true, timeout: 8000 });
    run(name, ['mcp', '--help'], { capture: true, timeout: 8000 });
  }
  if (name === 'dsh') run(name, ['plugin', '--help'], { capture: true, timeout: 8000 });
  console.log(`${name}: ${actual} (tested baseline ${expected})`);
}

export function checkSelectedHosts(agents, installAgents) {
  for (const name of agents) {
    if (!available(name)) {
      if (!installAgents) throw new Error(`${name} is missing. Install it natively or add --install-agents (pins ${hosts[name].version}).`);
      const requiredNode = hosts[name].node;
      if (requiredNode && requiredNode.localeCompare(process.versions.node, 'en', { numeric: true }) > 0) {
        throw new Error(`Installing ${name} through npm requires Node >=${requiredNode}.`);
      }
      console.log(`Install missing CLI: ${hosts[name].package}@${hosts[name].version}${name === 'dsh' ? ' (prerelease)' : ''}`);
    } else checkHost(name);
  }
}

export function installMissingHosts(agents) {
  for (const name of agents) if (!available(name)) {
    run('npm', ['install', '--global', `${hosts[name].package}@${hosts[name].version}`]);
    checkHost(name);
  }
}

async function replaceRuntime(home, next) {
  const runtime = join(home, 'runtime'), replacing = join(home, 'runtime.replacing');
  // Repair a directory switch interrupted before the new runtime was in place.
  if (!await present(runtime) && await present(replacing)) await rename(replacing, runtime);
  await rm(replacing, { recursive: true, force: true });
  if (await present(runtime)) await rename(runtime, replacing);
  try { await rename(next, runtime); } catch (error) {
    if (await present(replacing)) await rename(replacing, runtime);
    throw error;
  }
  await rm(replacing, { recursive: true, force: true });
}

async function installRuntime(home, old) {
  // A whitelist, shared with npm's files list. Never copy personal configuration.
  const next = join(home, 'runtime.next');
  const runtime = join(home, 'runtime');
  const previous = join(home, 'runtime.previous');
  if (resolve(packageRoot) === runtime) return runtime;
  await rm(next, { recursive: true, force: true });
  await mkdir(next);
  for (const name of ['package.json', 'bin', 'lib', 'integration', 'sync.sh', 'CHANGELOG.md']) {
    await cp(join(packageRoot, name), join(next, name), {
      recursive: true, filter: path => !path.includes('__pycache__') && !path.endsWith('.pyc'),
    });
  }
  const skillPath = join(next, 'integration/skills/kitto/SKILL.md');
  await writeFile(skillPath, (await readFile(skillPath, 'utf8')).replaceAll('KITTO_RUNNER', shellQuote(join(runtime, 'bin/maintain.mjs'))));
  const hash = await treeHash(next, true);
  if (await present(runtime) && await treeHash(runtime, true) === hash) {
    await rm(next, { recursive: true });
    return runtime;
  }
  // A retry after failure must not replace the last known-good checkpoint.
  const currentIsVerified = await present(runtime) && (old.runtimeHash
    ? await treeHash(runtime, true) === old.runtimeHash
    : (await json(join(runtime, 'package.json'))).version === old.version);
  if (old.ready && !old.detached && currentIsVerified) {
    const staging = join(home, 'checkpoint.next');
    await rm(staging, { recursive: true, force: true });
    await cp(runtime, staging, { recursive: true });
    await rm(previous, { recursive: true, force: true });
    await rename(staging, previous);
    await atomicJson(join(home, 'runtime.previous.json'), {
      version: (await json(join(previous, 'package.json'))).version, dshProfile: old.dshProfile || 'web', hash: await treeHash(previous, true),
    });
  }
  await replaceRuntime(home, next);
  return runtime;
}

export async function treeHash(path, ignorePythonCache = false) {
  const hash = createHash('sha256');
  async function walk(directory, relative = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignorePythonCache && (entry.name === '__pycache__' || entry.name.endsWith('.pyc'))) continue;
      const name = join(relative, entry.name), full = join(directory, entry.name);
      if (entry.isDirectory()) { hash.update(`dir:${name}\0`); await walk(full, name); }
      else if (entry.isFile()) { hash.update(`file:${name}\0`); hash.update(await readFile(full)); }
      else throw Object.assign(new Error(`Unsupported symlink or special file in skill: ${full}`), {
        code: 'KITTO_UNSUPPORTED_SKILL_ENTRY',
      });
    }
  }
  await walk(path);
  return hash.digest('hex');
}

async function existingSkillAction(target, source, nextHash, previous, keepUnowned) {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) {
    if (sameLocation(resolve(dirname(target), await readlink(target)), source)) return 'linked';
    if (keepUnowned) return 'keep';
    throw new Error(`Skill conflict: ${target} links elsewhere. Preserved.`);
  }
  if (keepUnowned && !stat.isDirectory()) return 'keep';
  const current = await treeHash(target).catch(error => {
    if (keepUnowned && error.code === 'KITTO_UNSUPPORTED_SKILL_ENTRY') return null;
    throw error;
  });
  if (current === nextHash) return 'same';
  if (current === previous) return 'copy';
  if (keepUnowned) return 'keep';
  throw new Error(`Skill conflict: ${target} differs from the source and last deployment. Preserved.`);
}

async function skillPlan(root, destination, owned = {}, keepExisting = false, kept = []) {
  const plans = [];
  const entries = await present(root) ? await readdir(root, { withFileTypes: true }) : [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !existsSync(join(root, entry.name, 'SKILL.md'))) continue;
    const source = join(root, entry.name), target = join(destination, entry.name);
    const nextHash = await treeHash(source);
    let action = 'copy';
    if (await present(target)) {
      const keepUnowned = keepExisting && !Object.hasOwn(owned, entry.name);
      action = keepUnowned && kept.includes(entry.name) ? 'keep'
        : await existingSkillAction(target, source, nextHash, owned[entry.name], keepUnowned);
    }
    plans.push({ name: entry.name, source, target, hash: nextHash, action });
  }
  for (const name of Object.keys(owned)) {
    if (plans.some(plan => plan.name === name)) continue;
    const target = join(destination, name);
    if (await present(target)) {
      if ((await lstat(target)).isSymbolicLink() || await treeHash(target) !== owned[name]) throw new Error(`Removed skill has local changes: ${target}. Preserved.`);
      plans.push({ name, target, action: 'remove' });
    }
  }
  for (const name of kept) {
    if (plans.some(plan => plan.name === name)) continue;
    const target = join(destination, name);
    if (await present(target)) plans.push({ name, target, action: 'keep' });
  }
  return plans;
}

function checkPiTools() {
  for (const name of ['bash', 'python3']) if (!available(name)) throw new Error(`Pi configuration requires ${name}.`);
  run('python3', ['-c', 'import sys; assert sys.version_info >= (3,10), "Python >=3.10 required for Pi"'], { capture: true });
}

function syncCommand(state, command, apply = false, codeRoot = join(kittoHome(), 'runtime')) {
  checkPiTools();
  return run('bash', [join(codeRoot, 'sync.sh'), command, ...(!apply && command !== 'status' ? ['--dry-run'] : [])], {
    env: { ...process.env, KITTO_CONFIG_ROOT: state.source, KITTO_SHARED_SKILLS_MANAGED: '1',
      PI_CODING_AGENT_DIR: state.piHome, PI_AGENTS_DIR: state.agentsHome },
  });
}

async function connect(state) {
  const home = kittoHome(), runtime = join(home, 'runtime');
  if (state.agents.includes('dsh') && !available('pnpm')) throw new Error('DSH native plugin operations require pnpm on PATH. Run setup --install-agents to install the missing prerequisite.');
  for (const name of state.agents) {
    if (name === 'pi') run('pi', ['install', runtime], { env: { ...process.env, PI_CODING_AGENT_DIR: state.piHome } });
    if (name === 'codex') {
      await mkdir(state.codexHome, { recursive: true });
      const marketplace = join(home, '.agents/plugins/marketplace.json');
      await atomicJson(marketplace, { name: 'phyzess-kitto', plugins: [{ name: 'kitto',
        source: { source: 'local', path: './runtime/integration' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] });
      const env = { ...process.env, CODEX_HOME: state.codexHome };
      run('codex', ['plugin', 'marketplace', 'add', home], { env });
      run('codex', ['plugin', 'add', 'kitto@phyzess-kitto'], { env });
    }
    if (name === 'dsh') {
      await mkdir(state.dshHome, { recursive: true });
      run('dsh', ['plugin', '--profile', state.dshProfile || 'web', 'add', runtime], {
        env: { ...process.env, DSH_HOME: state.dshHome, DSH_AGENTS_HOME: state.agentsHome },
      });
    }
  }
}

async function configurationPlan(state) {
  const groups = [{ name: 'shared', source: join(state.source, 'skills'), target: join(state.agentsHome, 'skills') },
    ...hostSkillRoots(state)];
  for (const group of groups) {
    const owned = group.name === 'shared' ? state.skills : state.hostSkills?.[group.name];
    group.plans = await skillPlan(group.source, group.target, owned, state.keepExistingSkills, state.keptSkills?.[group.name]);
    for (const plan of group.plans) console.log(`skill ${plan.action}: ${plan.name} (${group.name})`);
  }
  const instructions = await instructionPlan(state);
  for (const plan of instructions) console.log(`instructions ${plan.before === plan.after ? 'same' : 'sync'}: ${plan.target}`);
  const mcp = state.agents.includes('codex') ? await planCodexMcp(state) : undefined;
  return { groups, instructions, mcp };
}

async function deploy(state, apply, plan = undefined, codeRoot = undefined) {
  const { groups, instructions } = plan ?? await configurationPlan(state);
  const deployment = apply ? sourceRevision(state.source) : undefined;
  if (state.agents.includes('pi')) syncCommand(state, 'pull', apply, codeRoot);
  if (state.agents.includes('dsh')) await syncDshMcp(state, { dryRun: !apply });
  if (!apply) {
    if (!state.ready) console.log(`Connect native Kitto integrations: ${state.agents.join(', ')}`);
    return;
  }
  await applyInstructions(state, instructions);
  state.hostSkills ||= {};
  for (const { name, plans } of groups) {
    const owned = {};
    const kept = [];
    for (const plan of plans) {
      if (plan.action === 'copy') await replaceDirectory(plan.source, plan.target);
      else if (plan.action === 'remove') {
        const trash = `${plan.target}.kitto-remove-${process.pid}`;
        await rename(plan.target, trash);
        await rm(trash, { recursive: true, force: true });
      }
      if (plan.action === 'keep') kept.push(plan.name);
      else if (plan.action !== 'remove') owned[plan.name] = plan.hash;
    }
    if (kept.length) {
      state.keptSkills ||= {};
      state.keptSkills[name] = kept;
    } else if (state.keptSkills) delete state.keptSkills[name];
    if (name === 'shared') state.skills = owned;
    else state.hostSkills[name] = owned;
  }
  // Save deployment ownership before native managers, so retry is recoverable.
  await atomicJson(join(kittoHome(), 'state.json'), state);
  if (state.agents.includes('codex')) {
    await applyCodexMcp(state, { save: () => atomicJson(join(kittoHome(), 'state.json'), state) });
  }
  if (!state.ready) {
    await connect(state);
    state.runtimeHash = await treeHash(join(kittoHome(), 'runtime'), true);
  }
  state.deployed = deployment;
  state.ready = true;
  await atomicJson(join(kittoHome(), 'state.json'), state);
}

async function recover(state, apply) {
  if (state.detached || state.removing) throw new Error('Kitto integrations are being removed or already detached. Use setup to reconnect them.');
  const home = kittoHome(), previous = join(home, 'runtime.previous');
  if (!await present(join(home, 'runtime.previous.json'))) throw new Error('No verified runtime checkpoint. Rerun setup with a known working package version.');
  const checkpoint = await json(join(home, 'runtime.previous.json'));
  if (state.agents.includes('dsh') && (state.dshProfile || 'web') !== (checkpoint.dshProfile || 'web')) {
    throw new Error('The runtime checkpoint was verified with a different DSH profile.');
  }
  if (await treeHash(previous, true) !== checkpoint.hash) throw new Error('The runtime checkpoint was modified. Preserved; use a known working package version instead.');
  console.log(`Restore Kitto code ${state.version} -> ${checkpoint.version}; reconnect ${state.agents.join(', ')}. Personal configuration and skills stay as deployed.`);
  if (!apply) return;
  state.ready = false;
  await atomicJson(join(home, 'state.json'), state);
  if (!await present(join(home, 'runtime')) || await treeHash(join(home, 'runtime'), true) !== checkpoint.hash) {
    const next = join(home, 'runtime.next');
    await rm(next, { recursive: true, force: true });
    await cp(previous, next, { recursive: true });
    await replaceRuntime(home, next);
  }
  state.version = checkpoint.version;
  await atomicJson(join(home, 'state.json'), state);
  await connect(state);
  state.runtimeHash = checkpoint.hash;
  state.ready = true;
  await atomicJson(join(home, 'state.json'), state);
}

async function removeIntegration(state, name, apply, announce = true) {
  const home = kittoHome(), runtime = join(home, 'runtime');
  if (name === 'pi') {
    const settings = join(state.piHome, 'settings.json');
    const data = await present(settings) ? await json(settings) : {};
    const owned = value => typeof value === 'string' && (value.startsWith('.') || value.startsWith('/')) && sameLocation(resolve(state.piHome, value), runtime);
    if ((data.packages || []).some(entry => owned(typeof entry === 'string' ? entry : entry.source))) {
      if (apply) run('pi', ['remove', runtime], { env: { ...process.env, PI_CODING_AGENT_DIR: state.piHome } });
    }
    // The old Pi merge may have remembered this path as a machine-only package.
    const cache = join(state.source, 'config/pi/local/packages.txt');
    if (apply && await present(cache)) {
      const before = await readFile(cache, 'utf8');
      const after = before.split('\n').filter(line => !owned(line.trim())).join('\n');
      if (after !== before) await writeFile(cache, after);
    }
  } else if (name === 'codex') {
    const env = { ...process.env, CODEX_HOME: state.codexHome };
    if (!await present(state.codexHome)) return;
    const markets = JSON.parse(run('codex', ['plugin', 'marketplace', 'list', '--json'], { env, capture: true }));
    const market = markets.marketplaces.find(item => item.name === 'phyzess-kitto');
    if (market && !sameLocation(market.root, home)) throw new Error('The phyzess-kitto marketplace now belongs to another location. Preserved.');
    const plugins = JSON.parse(run('codex', ['plugin', 'list', '--json'], { env, capture: true }));
    if (plugins.installed.some(item => item.marketplaceName === 'phyzess-kitto' && item.pluginId !== 'kitto@phyzess-kitto')) {
      throw new Error('The Kitto marketplace contains other installed plugins. Preserved; detach them or move them to their own marketplace first.');
    }
    const plugin = plugins.installed.find(item => item.pluginId === 'kitto@phyzess-kitto');
    if (plugin && (plugin.source?.source !== 'local' || !sameLocation(plugin.source.path, join(runtime, 'integration')))) {
      throw new Error('The Codex Kitto plugin now comes from another source. Preserved.');
    }
    await removeCodexMcp(state, {
      apply, env,
      save: () => atomicJson(join(home, 'state.json'), state),
    });
    if (apply && plugin) run('codex', ['plugin', 'remove', 'kitto@phyzess-kitto'], { env });
    if (apply && market) run('codex', ['plugin', 'marketplace', 'remove', 'phyzess-kitto'], { env });
  } else if (name === 'dsh') {
    await removeDshMcp(state, { dryRun: !apply, ...(announce ? {} : { log: () => {}, warn: () => {} }) });
    const manifest = join(state.dshHome, 'profiles', state.dshProfile || 'web', 'package.json');
    if (!await present(manifest)) return;
    const profile = await json(manifest), dependency = profile.dependencies?.['@phyzess/kitto'];
    if (dependency && (!dependency.startsWith('link:') || !sameLocation(resolve(dirname(manifest), dependency.slice(5)), runtime))) throw new Error('DSH Kitto dependency now comes from another source. Preserved.');
    if (dependency || profile.dsh?.profile?.bundles?.includes('@phyzess/kitto')) {
      if (!available('pnpm')) throw new Error('DSH native removal requires pnpm on PATH. Restore pnpm before retrying removal.');
      if (apply) run('dsh', ['plugin', '--profile', state.dshProfile || 'web', 'remove', '@phyzess/kitto'], { env: { ...process.env, DSH_HOME: state.dshHome } });
    }
  }
}

async function remove(state, apply) {
  console.log(`Detach Kitto from ${state.agents.join(', ')}. Keep configuration, shared skills, agent CLIs and Kitto files for recovery/reinstallation.`);
  // Inspect every remaining host before making any change.
  const remaining = state.agents.filter(name => !(state.removedAgents || []).includes(name));
  // Keep the preflight quiet when the same removal will report its real work below.
  for (const name of remaining) await removeIntegration(state, name, false, !apply);
  if (!apply) return;
  const path = join(kittoHome(), 'state.json');
  state.ready = false; state.removing = true;
  await atomicJson(path, state);
  for (const name of remaining) {
    await removeIntegration(state, name, true);
    state.removedAgents = [...(state.removedAgents || []), name];
    await atomicJson(path, state);
  }
  state.removing = false; state.detached = true;
  await atomicJson(path, state);
}

function sourceRevision(source) {
  const status = git(source, ['status', '--porcelain', '--branch']).split('\n');
  return {
    commit: git(source, ['rev-parse', 'HEAD']),
    dirty: status.length > 1,
    detached: status[0] === '## HEAD (no branch)',
  };
}

const bootstrapMarker = source => join(source, '.git', 'kitto-bootstrap.json');

async function cloneSource(home, source, url, ref) {
  const staging = await mkdtemp(join(home, 'config.clone-'));
  try {
    run('git', ['clone', ...(ref ? ['--branch', ref] : []), '--', url, staging]);
    await atomicJson(bootstrapMarker(staging), { url, ref: ref ?? null });
    if (await present(source)) throw new Error(`Configuration destination already exists: ${source}`);
    await rename(staging, source);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function setup(options = {}) {
  if (options.global || Object.hasOwn(options, 'workspace') || Object.hasOwn(options, 'workspace-parent')) {
    const { setupScope } = await import('./scope-setup.mjs');
    return setupScope(options);
  }
  if (options['dsh-service']) throw new Error('--dsh-service requires --workspace PATH.');
  const home = kittoHome(), statePath = join(home, 'state.json');
  if (options.recover) {
    const work = async () => recover(await json(statePath), !options['dry-run']);
    return options['dry-run'] ? work() : locked(home, work);
  }
  const readState = () => readFile(statePath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const baseline = await readState();
  const old = baseline ? JSON.parse(baseline) : {};
  const agents = options.agents ? [...new Set([...(old.agents || []), ...options.agents])]
    : old.agents || Object.keys(hosts).filter(available);
  if (!agents.length) throw new Error('No agent detected. Select --agents pi,codex,dsh; add --install-agents to install missing CLIs.');
  const installPnpm = agents.includes('dsh') && !available('pnpm');
  if (installPnpm && !options['install-agents']) throw new Error('DSH native plugin operations require pnpm on PATH. Add --install-agents to install the missing prerequisite.');
  if (installPnpm) console.log(`Install missing DSH prerequisite: pnpm@${pnpmVersion}`);
  if (!available('git')) throw new Error('git is required.');
  const dshProfile = options['dsh-profile'] ?? old.dshProfile ?? 'web';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(dshProfile) || dshProfile === 'desktop') throw new Error('Invalid DSH CLI profile name.');
  if (options['dsh-profile'] && !agents.includes('dsh')) throw new Error('--dsh-profile requires DSH.');
  if (old.agents?.includes('dsh') && !old.detached && dshProfile !== (old.dshProfile || 'web')) {
    throw new Error('Detach the existing Kitto integration before selecting a different DSH profile.');
  }
  const requested = options.source || old.source || defaultSource;
  const local = existsSync(requested);
  const source = local ? await realpath(requested) : join(await realpath(home).catch(error => {
    if (error.code === 'ENOENT') return home;
    throw error;
  }), 'config');
  if (old.source && source !== old.source) {
    // A new Kitto home may have been recorded before its parent aliases were resolved.
    const sameSource = basename(source) === basename(old.source) && sameLocation(dirname(source), dirname(old.source));
    if (!sameSource) throw new Error('This installation already has a source. Keep it or use a separate KITTO_HOME; source switching is not implicit.');
  }
  if (!local && !/^(https:\/\/|ssh:\/\/|git@)/.test(requested)) throw new Error('Source must be an existing checkout or HTTPS/SSH Git URL.');
  let switchTag = false, ownedSource = false;
  const markerPath = bootstrapMarker(source);
  if (options.ref && await present(markerPath)) {
    const marker = await json(markerPath);
    const origin = git(source, ['config', '--local', '--get', 'remote.origin.url']);
    ownedSource = (local || requested === marker.url) && origin === marker.url;
    switchTag = ownedSource && (marker.ref !== options.ref || (Boolean(old.source)
        && git(source, ['rev-parse', '--abbrev-ref', 'HEAD']) !== options.ref));
    if (switchTag) {
      if (!local && await realpath(source) !== source) throw new Error('Kitto checkout is a symlink. Preserved.');
      git(source, ['check-ref-format', `refs/tags/${options.ref}`]);
      if (sourceRevision(source).dirty) throw new Error('Source has local changes. Commit or resolve them before switching tags.');
    }
  }
  let resume = false;
  if (!local && await present(source)) {
    if (await present(bootstrapMarker(source)) && await realpath(source) === source) {
      const marker = await json(bootstrapMarker(source));
      resume = marker.url === requested && (switchTag || marker.ref === (options.ref ?? null))
        && git(source, ['config', '--local', '--get', 'remote.origin.url']) === requested;
    }
    if (!resume) throw new Error(`Unregistered checkout already exists at ${source}. Inspect it and rerun with --source ${shellQuote(source)}.`);
    console.log(`Resume setup from Kitto checkout: ${source}`);
  }
  if (local && options.ref && !ownedSource) throw new Error('Switch tags only in a Kitto-created checkout. For your own checkout, use Git.');
  console.log(`Global setup: ${agents.join(', ')}; source: ${requested}; Kitto home: ${home}`);
  checkSelectedHosts(agents, options['install-agents']);
  const state = { ...old, schema: 1, ready: false, detached: false, removing: false, removedAgents: [], source, agents, dshProfile,
    agentsHome: old.agentsHome || resolve((agents.includes('pi') && process.env.PI_AGENTS_DIR)
      || (agents.includes('dsh') && process.env.DSH_AGENTS_HOME) || join(homedir(), '.agents')),
    piHome: old.piHome || resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent')),
    codexHome: old.codexHome || resolve(process.env.CODEX_HOME || join(homedir(), '.codex')),
    dshHome: old.dshHome || resolve(process.env.DSH_HOME || join(homedir(), '.dsh')),
    version: (await json(join(packageRoot, 'package.json'))).version,
  };
  if (options.keepExistingSkills === true) state.keepExistingSkills = true;
  if (agents.includes('codex') && state.agentsHome !== resolve(homedir(), '.agents')) {
    throw new Error('Codex discovers shared skills in ~/.agents. Use that common root for PI_AGENTS_DIR / DSH_AGENTS_HOME when selecting Codex.');
  }
  if (agents.includes('dsh') && process.env.DSH_AGENTS_HOME && resolve(process.env.DSH_AGENTS_HOME) !== state.agentsHome) {
    throw new Error('DSH_AGENTS_HOME and the shared skill root differ. Use the same root so native DSH sessions can discover your skills.');
  }
  if (agents.includes('dsh')) {
    const builtIn = ['web', 'headless', 'sdk', 'sdk-minimal', 'acp'];
    if (!builtIn.includes(dshProfile) && !await present(join(state.dshHome, 'profiles', dshProfile, 'package.json'))) {
      throw new Error(`Initialize the native DSH profile ${dshProfile} before setup.`);
    }
    console.log(`DSH profile: ${dshProfile}`);
  }
  if (agents.includes('pi') && (!(local || resume) || !options['dry-run'])) checkPiTools();
  if (options['dry-run']) {
    if (switchTag) console.log(`Would switch the Kitto checkout to tag ${options.ref} and deploy it.`);
    else if (local || resume) {
      await validateSource(state);
      await deploy(state, false, undefined, packageRoot);
    }
    console.log('Preview only: clone if needed, persist Kitto runtime, deploy selected configuration and skills, register native integrations. No writes.');
    return;
  }
  await locked(home, async () => {
    if (await readState() !== baseline) throw new Error('Kitto installation changed during setup. Run the same command again.');
    if (installPnpm) {
      run('npm', ['install', '--global', `pnpm@${pnpmVersion}`]);
      if (!available('pnpm')) throw new Error('pnpm was installed but cannot run. Check PATH and allow pnpm native-binary install scripts, then rerun setup.');
    }
    installMissingHosts(agents);
    if (!local && !resume) await cloneSource(home, source, requested, options.ref);
    if (switchTag) {
      if (sourceRevision(source).dirty) throw new Error('Source has local changes. Commit or resolve them before switching tags.');
      git(source, ['fetch', '--no-tags', 'origin', `refs/tags/${options.ref}`]);
      const commit = git(source, ['rev-parse', 'FETCH_HEAD^{commit}']);
      git(source, ['checkout', '--no-overwrite-ignore', '--detach', commit]);
    }
    await validateSource(state);
    const plan = await configurationPlan(state);
    await installRuntime(home, old);
    await atomicJson(join(home, 'state.json'), state);
    await deploy(state, true, plan);
  });
  console.log('Kitto setup complete. Start your agent with its native command; ask the Kitto skill to maintain configuration.');
}

export async function maintain(args) {
  const [operation = 'status', ...flags] = args;
  const allowed = { status: [], versions: ['--online'], sync: ['--apply'], update: ['--apply'], export: ['--apply'], deps: ['--apply'], recover: ['--apply'], remove: ['--apply'] };
  if (!allowed[operation] || flags.some(flag => !allowed[operation].includes(flag))) throw new Error('Unsupported maintenance operation or flag. Read the Kitto skill.');
  const home = kittoHome(), state = await json(join(home, 'state.json'));
  const apply = flags.includes('--apply');
  // These operations must also work when the personal checkout is unavailable.
  if (operation === 'recover' || operation === 'remove') {
    const work = () => operation === 'recover' ? recover(state, apply) : remove(state, apply);
    if (apply) await locked(home, work); else await work();
    return;
  }
  if (operation === 'status' && (state.detached || state.removing || !await present(state.source))) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (state.detached || state.removing) throw new Error('Kitto is detached or removal is incomplete. Use setup to reconnect, or finish remove.');
  await validateSource(state);
  if (operation === 'status') {
    console.log(JSON.stringify({ ...state, checkout: sourceRevision(state.source), git: git(state.source, ['status', '--short', '--branch']) }, null, 2));
    await configurationPlan(state);
    for (const tool of await dependencyPlan(state)) console.log(`dependency ${tool.available ? 'available' : 'missing'}: ${tool.name} (${tool.reason})`);
    await reportCodeGraphIndexes(state);
    await printMcpParity(state);
    if (state.agents.includes('pi')) syncCommand(state, 'status');
  } else if (operation === 'versions') {
    console.log(JSON.stringify(await versionReport(state, hosts, pnpmVersion, flags.includes('--online'), treeHash), null, 2));
  } else {
    const work = async () => {
      if (operation === 'update') {
        if (sourceRevision(state.source).detached) {
          throw new Error('Configuration is pinned to a detached revision. Run kitto setup --ref TAG to switch a Kitto-created checkout to another snapshot.');
        }
        if (git(state.source, ['status', '--porcelain'])) throw new Error('Source has local changes. Commit or resolve them before update; nothing was stashed or reset.');
        const branch = git(state.source, ['symbolic-ref', '--short', 'HEAD']);
        const remote = git(state.source, ['config', `branch.${branch}.remote`]);
        const ref = git(state.source, ['config', `branch.${branch}.merge`]);
        if (remote === '.') throw new Error('A remote-tracking branch is required for update.');
        if (!apply) { console.log(run('git', ['-C', state.source, 'ls-remote', remote, ref], { capture: true, timeout: 30_000 })); return; }
        git(state.source, ['pull', '--ff-only']);
        await validateSource(state);
      }
      if (operation === 'deps') await installDependencies(state, apply);
      else if (operation === 'export') {
        if (!state.agents.includes('pi')) throw new Error('Pi export requires a Pi installation. Edit shared skills in the source checkout.');
        syncCommand(state, 'push', apply);
      } else await deploy(state, apply);
    };
    if (apply) await locked(home, work); else await work();
  }
}
