import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, lstat, readlink, realpath } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { applyInstructions, hostSkillRoots, instructionPlan } from './host-config.mjs';
import { dependencyPlan, installDependencies } from './dependencies.mjs';
import { sameLocation } from './paths.mjs';
import { piAdapter } from './pi-adapter.mjs';
import { processAlive } from './process-alive.mjs';
import { reportCodeGraphIndexes } from './codegraph.mjs';
import { applyCodexMcp, planCodexMcp, removeCodexMcp, sourceServers as codexMcpSource } from './codex-mcp.mjs';
import { printMcpParity } from './parity.mjs';
import { removeDshMcp, syncDshMcp } from './mcp-sync.mjs';
import { desktopProfileNotice, isDesktopProfile, probeDesktopProfile, reportDesktopProbe, validateDshProfile } from './dsh-profile.mjs';
import { versionReport } from './versions.mjs';

import { hosts, pnpmVersion } from './host-pins.mjs';
import { hostsCommand } from './hosts.mjs';
import { kittoHome, packageRoot } from './kitto-home.mjs';
import { meetsBaseline, readVersion } from './version-order.mjs';
import { setRoutingBoundary } from './routing-policy.mjs';

export { hosts, pnpmVersion, kittoHome, packageRoot, meetsBaseline };
const defaultSource = 'https://github.com/phyzess/kitto.git';
const isGitUrl = value => typeof value === 'string' && /^(https:\/\/|ssh:\/\/|git@)/.test(value);
const redactUrl = value => String(value).replace(/\/\/[^/@\s]+@/g, '//***@');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const present = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

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
function run(command, args, { capture = false, ...options } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 600_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  return result.stdout?.trim() || '';
}
const git = (source, args) => run('git', ['-C', source, ...args], { capture: true, timeout: 30_000 });
const available = (name, env = process.env) => spawnSync(name, ['--version'], { stdio: 'ignore', timeout: 8000, env }).status === 0;

export function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--dry-run', '--install-agents', '--recover', '--require-baseline', '--global', '--include-private', '--no-include-private'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--agents', '--source', '--ref', '--dsh-profile', '--workspace', '--workspace-parent', '--dsh-service',
      '--routing-boundary', '--routing-routes'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('-')) {
      const name = arg.slice(2);
      if (name.startsWith('routing-') && Object.hasOwn(options, name)) throw new Error(`Specify ${arg} at most once.`);
      options[name] = args[++i];
    }
    else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  if (options.agents) {
    options.agents = [...new Set(options.agents.split(','))];
    if (options.agents.some(name => !hosts[name])) throw new Error('Agents must be pi,codex,dsh.');
  }
  if (options['include-private'] && options['no-include-private']) throw new Error('Choose either --include-private or --no-include-private.');
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

let breakStaleLocks = false;
export function allowStaleLockBreak(value = true) { breakStaleLocks = value; }

const ownedLocks = new Set();
let lockSignalsBound = false;

function lockOwnerRecord() {
  return { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(),
    command: process.argv.slice(2).join(' ').slice(0, 200) };
}

async function readLockOwner(lock) {
  try { return JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); }
  catch { return undefined; }
}

function lockMessage(lock, owner, stale) {
  if (!owner) {
    return `${lock} exists without an owner record (an older Kitto, or a directory someone created by hand). `
      + 'Verify no Kitto process is running, then delete that directory.';
  }
  const who = `pid ${owner.pid}${owner.startedAt ? ` started ${owner.startedAt}` : ''}${owner.command ? ` (${owner.command})` : ''}`;
  return stale
    ? `${lock} is a stale lock: ${who} is no longer running. Rerun with --break-lock to remove it, or delete that directory.`
    : `Another Kitto operation holds ${lock}: ${who}. Wait for it to finish.`;
}

function bindLockSignals() {
  if (lockSignalsBound) return;
  lockSignalsBound = true;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      for (const lock of ownedLocks) { try { rmSync(lock, { recursive: true, force: true }); } catch {} }
      process.exit(code);
    });
  }
}

async function acquireLock(home) {
  await mkdir(home, { recursive: true });
  const lock = join(home, '.lock');
  bindLockSignals();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, 'owner.json'), JSON.stringify(lockOwnerRecord(), null, 1) + '\n', { mode: 0o600 });
      ownedLocks.add(lock);
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readLockOwner(lock);
      const stale = owner ? processAlive(owner.pid) === false : false;
      if (stale && breakStaleLocks) {
        await rm(lock, { recursive: true, force: true });
        console.log(`kitto: removed stale lock ${lock} (pid ${owner.pid} is no longer running).`);
        continue;
      }
      throw new Error(lockMessage(lock, owner, stale));
    }
  }
  throw new Error(`Cannot acquire ${join(home, '.lock')}: a stale lock reappeared after it was cleared.`);
}

function breakStaleSyncLock(state) {
  const lock = join(state.source, 'config/pi/local/.sync-lock');
  if (!existsSync(lock)) return;
  let pid = NaN;
  try { pid = Number(readFileSync(join(lock, 'pid'), 'utf8').trim()); } catch {}
  if (processAlive(pid) !== false) return;
  rmSync(lock, { recursive: true, force: true });
  console.log(`kitto: removed stale sync lock ${lock} (pid ${pid} is no longer running).`);
}

async function locked(home, callback) {
  const lock = await acquireLock(home);
  try { return await callback(); } finally {
    ownedLocks.delete(lock);
    await rm(lock, { recursive: true, force: true });
  }
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

function hostCapabilities(name, env) {
  const supports = args => spawnSync(name, args, { stdio: 'ignore', timeout: 8000, env }).status === 0;
  if (name === 'codex') return { plugin: supports(['plugin', 'add', '--help']), mcp: supports(['mcp', '--help']) };
  if (name === 'dsh') return { plugin: supports(['plugin', '--help']) };
  return {};
}

function inspectHost(name) {
  const probe = name === 'codex' ? mkdtempSync(join(tmpdir(), 'kitto-codex-check-')) : null;
  const env = probe ? { ...process.env, CODEX_HOME: probe } : process.env;
  try {
    const result = spawnSync(name, ['--version'], { encoding: 'utf8', timeout: 8000, env });
    const stdout = (result.stdout ?? '').trim();
    const actual = !result.error && result.status === 0 ? readVersion(stdout) : null;
    const baseline = hosts[name].version;
    const missing = result.error?.code === 'ENOENT';
    const detail = (stdout.split('\n')[0] || (result.stderr ?? '').trim().split('\n')[0] || `exit ${result.status}`);
    return {
      name, baseline, actual, status: missing ? 'missing' : actual ? 'found' : 'unreadable', detail,
      meetsBaseline: Boolean(actual) && meetsBaseline(actual, baseline),
      capabilities: missing ? {} : hostCapabilities(name, env),
    };
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
}

function reportHost(report, requireBaseline) {
  const { name, baseline } = report;
  if (report.status === 'unreadable') {
    console.warn(`kitto: ${name}: could not read its version (${report.detail}); continuing, but its native integration is unverified.`);
  } else if (report.meetsBaseline) {
    console.log(`${name}: ${report.actual} (tested baseline ${baseline})`);
  } else {
    const detail = `${name}: ${report.actual} is older than the tested baseline ${baseline}`;
    if (requireBaseline) throw new Error(`${detail}. Upgrade it with \`kitto hosts --apply\`, or drop --require-baseline.`);
    console.warn(`kitto: ${detail}; continuing and skipping the steps this CLI cannot support. Run \`kitto hosts --apply\` when you want the tested baseline.`);
  }
}
function availableHost(name) {
  if (name !== 'codex') return available(name);
  const probe = mkdtempSync(join(tmpdir(), 'kitto-codex-check-'));
  try { return available(name, { ...process.env, CODEX_HOME: probe }); }
  finally { rmSync(probe, { recursive: true, force: true }); }
}

export function checkSelectedHosts(agents, installAgents, options = {}) {
  const reports = [];
  for (const name of agents) {
    if (!availableHost(name)) {
      if (!installAgents) throw new Error(`${name} is missing. Install it natively or add --install-agents (pins ${hosts[name].version}).`);
      const requiredNode = hosts[name].node;
      if (requiredNode && !meetsBaseline(process.versions.node, requiredNode)) {
        throw new Error(`Installing ${name} through npm requires Node >=${requiredNode}.`);
      }
      console.log(`Install missing CLI: ${hosts[name].package}@${hosts[name].version}${name === 'dsh' ? ' (prerelease)' : ''}`);
      continue;
    }
    const report = inspectHost(name);
    reports.push(report);
    reportHost(report, options.requireBaseline === true);
  }
  return reports;
}

export function installMissingHosts(agents) {
  for (const name of agents) if (!availableHost(name)) {
    run('npm', ['install', '--global', `${hosts[name].package}@${hosts[name].version}`]);
    const report = inspectHost(name);
    if (report.status !== 'found' || report.actual !== hosts[name].version) {
      throw new Error(`${name}: npm finished, but the CLI reports ${report.actual ?? report.status} instead of ${hosts[name].version}. `
        + 'Check PATH and the npm global prefix; Kitto wrote no state.');
    }
    console.log(`${name}: ${report.actual} (installed pinned baseline)`);
  }
}

async function replaceRuntime(home, next) {
  const runtime = join(home, 'runtime'), replacing = join(home, 'runtime.replacing');
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
  const next = join(home, 'runtime.next');
  const runtime = join(home, 'runtime');
  const previous = join(home, 'runtime.previous');
  if (sameLocation(packageRoot, runtime)) return runtime;
  await rm(next, { recursive: true, force: true });
  await mkdir(next);
  for (const name of ['package.json', 'bin', 'lib', 'integration', 'CHANGELOG.md']) {
    await cp(join(packageRoot, name), join(next, name), { recursive: true });
  }
  const skillPath = join(next, 'integration/skills/kitto/SKILL.md');
  const entries = { KITTO_RUNNER: 'maintain.mjs', KITTO_CLI: 'kitto.mjs' };
  const template = await readFile(skillPath, 'utf8');
  await writeFile(skillPath, template.replace(/KITTO_RUNNER|KITTO_CLI/g, key => shellQuote(join(runtime, 'bin', entries[key]))));
  const hash = await treeHash(next);
  if (await present(runtime) && await treeHash(runtime) === hash) {
    await rm(next, { recursive: true });
    return runtime;
  }
  const currentIsVerified = await present(runtime) && (old.runtimeHash
    ? await treeHash(runtime) === old.runtimeHash
    : (await json(join(runtime, 'package.json'))).version === old.version);
  if (old.ready && !old.detached && currentIsVerified) {
    const staging = join(home, 'checkpoint.next');
    await rm(staging, { recursive: true, force: true });
    await cp(runtime, staging, { recursive: true });
    await rm(previous, { recursive: true, force: true });
    await rename(staging, previous);
    await atomicJson(join(home, 'runtime.previous.json'), {
      version: (await json(join(previous, 'package.json'))).version, dshProfile: old.dshProfile || 'web', hash: await treeHash(previous),
    });
  }
  await replaceRuntime(home, next);
  return runtime;
}

export async function treeHash(path) {
  const hash = createHash('sha256');
  async function walk(directory, relative = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
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

function syncCommand(state, command, apply = false) {
  if (breakStaleLocks) breakStaleSyncLock(state);
  piAdapter(command, {
    source: state.source, piHome: state.piHome, agentsHome: state.agentsHome,
    dryRun: !apply && command !== 'status',
    onLock: lock => ownedLocks.add(lock), onUnlock: lock => ownedLocks.delete(lock),
  });
}

async function connect(state) {
  const home = kittoHome(), runtime = join(home, 'runtime');
  const desktopDsh = state.agents.includes('dsh') && isDesktopProfile(state.dshProfile);
  if (state.agents.includes('dsh') && !desktopDsh && !available('pnpm')) throw new Error('DSH native plugin operations require pnpm on PATH. Run setup --install-agents to install the missing prerequisite.');
  for (const name of state.agents) {
    if (name === 'pi') run('pi', ['install', runtime], { env: { ...process.env, PI_CODING_AGENT_DIR: state.piHome } });
    if (name === 'codex') {
      const codex = inspectHost('codex');
      if (!codex.capabilities.plugin) {
        console.warn('kitto: this codex CLI has no plugin subcommand; skipped the Kitto plugin registration. '
          + 'Rules, skills and MCP were still deployed.');
        continue;
      }
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
      if (isDesktopProfile(state.dshProfile)) {
        console.log('DSH desktop profile: app-managed; skipped Kitto bundle registration (global rules and skills only).');
        continue;
      }
      const dsh = inspectHost('dsh');
      if (!dsh.capabilities.plugin) {
        console.warn(`kitto: this dsh CLI${dsh.actual ? ` (${dsh.actual})` : ''} has no plugin subcommand; `
          + 'skipped the Kitto bundle registration. Rules and skills were still deployed.');
        continue;
      }
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

async function deploy(state, apply, plan = undefined) {
  const { groups, instructions } = plan ?? await configurationPlan(state);
  const deployment = apply ? sourceRevision(state.source) : undefined;
  const connectable = state.agents.filter(name => !(name === 'dsh' && isDesktopProfile(state.dshProfile)));
  if (state.agents.includes('pi')) syncCommand(state, 'pull', apply);
  if (state.agents.includes('dsh') && !isDesktopProfile(state.dshProfile)) await syncDshMcp(state, { dryRun: !apply });
  if (!apply) {
    if (!state.ready && connectable.length) console.log(`Connect native Kitto integrations: ${connectable.join(', ')}`);
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
  await atomicJson(join(kittoHome(), 'state.json'), state);
  if (state.agents.includes('codex')) {
    await applyCodexMcp(state, { save: () => atomicJson(join(kittoHome(), 'state.json'), state) });
  }
  if (!state.ready) {
    await connect(state);
    state.runtimeHash = await treeHash(join(kittoHome(), 'runtime'));
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
  if (await treeHash(previous) !== checkpoint.hash) throw new Error('The runtime checkpoint was modified. Preserved; use a known working package version instead.');
  console.log(`Restore Kitto code ${state.pendingRuntime?.version || state.version} -> ${checkpoint.version}; reconnect ${state.agents.join(', ')}. Personal configuration and skills stay as deployed.`);
  if (!apply) return;
  state.ready = false;
  await atomicJson(join(home, 'state.json'), state);
  if (!await present(join(home, 'runtime')) || await treeHash(join(home, 'runtime')) !== checkpoint.hash) {
    const next = join(home, 'runtime.next');
    await rm(next, { recursive: true, force: true });
    await cp(previous, next, { recursive: true });
    await replaceRuntime(home, next);
  }
  state.version = checkpoint.version;
  delete state.pendingRuntime;
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
      ...(announce ? {} : { log: () => {}, warn: () => {} }),
    });
    if (apply && plugin) run('codex', ['plugin', 'remove', 'kitto@phyzess-kitto'], { env });
    if (apply && market) run('codex', ['plugin', 'marketplace', 'remove', 'phyzess-kitto'], { env });
  } else if (name === 'dsh') {
    if (isDesktopProfile(state.dshProfile)) {
      if (announce) console.log('DSH desktop profile is app-managed; Kitto never installed a bundle, patch or MCP home row for it, so no native removal is needed.');
      return;
    }
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
  const remaining = state.agents.filter(name => !(state.removedAgents || []).includes(name));
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

function hostCliVersions(state) {
  console.log('Host CLIs (Kitto never upgrades them; use each native manager):');
  for (const name of state.agents) {
    const baseline = hosts[name].version;
    if (name === 'dsh' && isDesktopProfile(state.dshProfile)) {
      console.log(`  dsh: app-managed (Kitto tested baseline ${baseline}); upgrade through DeepSeek Harness Desktop`);
      continue;
    }
    const probe = name === 'codex' ? mkdtempSync(join(tmpdir(), 'kitto-codex-check-')) : null;
    try {
      const output = run(name, ['--version'], { capture: true, timeout: 8000, env: probe ? { ...process.env, CODEX_HOME: probe } : process.env });
      const actual = readVersion(output) || output.split('\n')[0];
      console.log(`  ${name}: ${actual} (Kitto tested baseline ${baseline}); upgrade with its native manager (${hosts[name].package})`);
    } catch {
      console.log(`  ${name}: not found (Kitto tested baseline ${baseline}); install ${hosts[name].package} with its native manager`);
    } finally {
      if (probe) rmSync(probe, { recursive: true, force: true });
    }
  }
}

async function refreshRuntime(state, apply) {
  const home = kittoHome(), runtime = join(home, 'runtime');
  const fromInstalledRuntime = sameLocation(packageRoot, runtime);
  const current = state.version;
  if (!apply) {
    if (fromInstalledRuntime) console.log(`Runtime: ${current} (this entry runs from the installed copy; run update with the intended Kitto package to replace it).`);
    else {
      const next = (await json(join(packageRoot, 'package.json'))).version;
      console.log(next === current
        ? `Runtime: ${current} (re-synced from the executing package only if its files differ).`
        : `Runtime: ${current} -> ${next} (the previous verified version stays recoverable).`);
    }
    return undefined;
  }
  if (fromInstalledRuntime) {
    console.log(`Runtime: ${current} (the installed maintenance runner cannot replace itself; run update with the intended Kitto package to refresh the code copy).`);
    return undefined;
  }
  const installed = await installRuntime(home, state);
  const pending = { version: (await json(join(installed, 'package.json'))).version, hash: await treeHash(installed) };
  state.pendingRuntime = pending;
  await atomicJson(join(home, 'state.json'), state);
  console.log(pending.version === current
    ? `Runtime: ${pending.version} (re-synced; verified after deployment)`
    : `Runtime: ${current} -> ${pending.version} (verified after deployment; recover keeps ${current} until then)`);
  return pending;
}

async function finalizeRuntime(state, pending) {
  if (!pending) return;
  state.version = pending.version;
  state.runtimeHash = pending.hash;
  delete state.pendingRuntime;
  await atomicJson(join(kittoHome(), 'state.json'), state);
}

function upstreamOf(state, branch) {
  try {
    return git(state.source, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    throw new Error(`Branch ${branch} has no upstream. Set one with 'git branch --set-upstream-to=<remote>/${branch} ${branch}' or 'git push -u <remote> ${branch}', then retry.`);
  }
}

function restoreHint(state) {
  const steps = [];
  if (state.sourceUrl) steps.push(`git clone ${shellQuote(redactUrl(state.sourceUrl))} ${shellQuote(state.source)}`);
  if (state.sourceRef) steps.push(`git -C ${shellQuote(state.source)} checkout ${shellQuote(state.sourceRef)}`);
  return steps.length ? `Recreate the checkout in place (${steps.join(' && ')})` : `Recreate the checkout in place at ${state.source}`;
}

function restoreError(state, detail) {
  return new Error(`${detail} ${restoreHint(state)} and rerun kitto setup; or use a new KITTO_HOME for a fresh installation.`);
}

async function checkRestoreRef(state) {
  const ref = state.sourceRef;
  if (!ref) return;
  let heads, tags;
  try {
    heads = run('git', ['ls-remote', '--heads', state.sourceUrl, `refs/heads/${ref}`], { capture: true, timeout: 30_000 });
    tags = run('git', ['ls-remote', '--tags', state.sourceUrl, `refs/tags/${ref}`], { capture: true, timeout: 30_000 });
  } catch (error) {
    throw restoreError(state, `Cannot inspect ${redactUrl(state.sourceUrl)}: ${error.message}.`);
  }
  if (heads && tags) throw restoreError(state, `The recorded ref ${ref} exists as both a branch and a tag on ${redactUrl(state.sourceUrl)}.`);
  if (tags) throw restoreError(state, `The checkout was pinned to tag ${ref} and Kitto does not guess pinned snapshots.`);
  if (!heads) throw restoreError(state, `Branch ${ref} no longer exists on ${redactUrl(state.sourceUrl)}.`);
}

async function syncSourceLocation(state, apply) {
  if (!state.sourceUrl) return;
  let origin;
  try { origin = git(state.source, ['config', '--local', '--get', 'remote.origin.url']); } catch { return; }
  if (!origin || origin === state.sourceUrl) return;
  if (!isGitUrl(origin)) {
    console.log(`Configuration origin is not a Git URL; keeping ${redactUrl(state.sourceUrl)} for recovery.`);
    return;
  }
  console.log(`Configuration source URL changed: ${redactUrl(state.sourceUrl)} -> ${redactUrl(origin)}.`);
  if (!apply) return;
  state.sourceUrl = origin;
  const markerPath = bootstrapMarker(state.source);
  if (await present(markerPath)) {
    const marker = await json(markerPath).catch(() => ({}));
    await atomicJson(markerPath, { ...marker, url: origin });
  }
  await atomicJson(join(kittoHome(), 'state.json'), state);
}

async function backfillSource(state) {
  if (!await present(state.source)) return;
  const markerPath = bootstrapMarker(state.source);
  if (!await present(markerPath)) return;
  const marker = await json(markerPath).catch(() => undefined);
  if (!marker) return;
  let changed = false;
  if (marker.url && !state.sourceUrl) { state.sourceUrl = marker.url; changed = true; }
  if (state.sourceRef === undefined) { state.sourceRef = marker.ref ?? null; changed = true; }
  if (!changed) return;
  console.log(`Recovered the configuration source from the bootstrap marker: ${redactUrl(state.sourceUrl)}${state.sourceRef ? ` (${state.sourceRef})` : ''}.`);
}

async function updateSource(state, apply) {
  if (!await present(state.source)) {
    if (!state.sourceUrl) throw restoreError(state, 'The Kitto configuration checkout is missing and no source URL was recorded.');
    if (state.deployed?.detached) throw restoreError(state, `The configuration checkout was pinned to a detached revision${state.sourceRef ? ` (${state.sourceRef})` : ''} and is missing. Kitto does not guess pinned snapshots.`);
    if (state.sourceRef === undefined) throw restoreError(state, 'The configuration checkout is missing and state.json does not record its branch or tag.');
    if (!isGitUrl(state.sourceUrl)) throw restoreError(state, 'The recorded source URL is not an HTTPS/SSH Git URL.');
    await checkRestoreRef(state);
    console.log(`Restore configuration checkout from ${redactUrl(state.sourceUrl)}${state.sourceRef ? ` (${state.sourceRef})` : ' (remote default branch)'}: ${state.source}`);
    if (!apply) return false;
    await cloneSource(kittoHome(), state.source, state.sourceUrl, state.sourceRef ?? undefined);
  }
  if (sourceRevision(state.source).detached) {
    throw new Error('Configuration is pinned to a detached revision. Run kitto setup --ref TAG to switch a Kitto-created checkout to another snapshot.');
  }
  if (git(state.source, ['status', '--porcelain'])) throw new Error('Source has local changes. Commit or resolve them before update; nothing was stashed or reset.');
  const branch = git(state.source, ['symbolic-ref', '--short', 'HEAD']);
  const upstream = upstreamOf(state, branch);
  const remote = git(state.source, ['config', `branch.${branch}.remote`]);
  const ref = git(state.source, ['config', `branch.${branch}.merge`]);
  if (remote === '.') throw new Error('A remote-tracking branch is required for update.');
  const before = sourceRevision(state.source).commit;
  if (!apply) {
    const head = run('git', ['-C', state.source, 'ls-remote', remote, ref], { capture: true, timeout: 30_000 }).split('\n')[0]?.split(/\s+/)[0];
    console.log(`Configuration ${branch}: local ${before.slice(0, 7)}; remote ${head ? head.slice(0, 7) : '(no matching ref)'} (not fetched).`);
    return false;
  }
  git(state.source, ['fetch', remote]);
  const isAncestor = (earlier, later) => spawnSync('git', ['-C', state.source, 'merge-base', '--is-ancestor', earlier, later],
    { stdio: 'ignore', timeout: 30_000 }).status === 0;
  if (!isAncestor(before, upstream) && !isAncestor(upstream, before)) {
    throw new Error(`The remote branch ${upstream} and the local branch ${branch} have diverged (neither is an ancestor of the other). Kitto only fast-forwards; reconcile manually (for example git pull --rebase) and retry. Nothing was changed.`);
  }
  git(state.source, ['pull', '--ff-only']);
  const after = sourceRevision(state.source).commit;
  console.log(after === before
    ? `Configuration ${branch} is already at ${after.slice(0, 7)}.`
    : `Configuration ${branch} fast-forwarded ${before.slice(0, 7)} -> ${after.slice(0, 7)}.`);
  await validateSource(state);
  return true;
}

export async function update(args = []) {
  if (args.includes('--check') && args.includes('--apply')) throw new Error('Choose either --check or --apply for update.');
  if (args.includes('--include-private') && args.includes('--no-include-private')) throw new Error('Choose either --include-private or --no-include-private for update.');
  const unknown = args.filter(flag => !['--check', '--apply', '--include-private', '--no-include-private'].includes(flag));
  if (unknown.length) throw new Error(`Unknown update option: ${unknown[0]}. Read the Kitto skill.`);
  const apply = args.includes('--apply');
  const includePrivate = args.includes('--include-private') ? true
    : args.includes('--no-include-private') ? false : undefined;
  const home = kittoHome();
  const state = await json(join(home, 'state.json')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!state) throw new Error(`Kitto is not set up in ${home}. Run kitto setup first.`);
  if (state.detached || state.removing) throw new Error('Kitto is detached or removal is incomplete. Use setup to reconnect, or finish remove.');
  console.log(`Kitto ${state.version} update${apply ? '' : ' preview (no writes)'}.`);
  hostCliVersions(state);
  const work = async () => {
    if (includePrivate !== undefined) state.includePrivate = includePrivate;
    await backfillSource(state);
    const updated = await updateSource(state, apply);
    if (!updated) {
      if (await present(state.source)) {
        await syncSourceLocation(state, false);
        const plan = await configurationPlan(state);
        await deploy(state, false, plan, packageRoot);
      }
      await refreshRuntime(state, false);
      console.log('Preview only: restore the checkout if missing, fetch and fast-forward the source branch, refresh the Kitto runtime copy, then deploy configuration, skills and MCP. No writes.');
      return;
    }
    await syncSourceLocation(state, true);
    const plan = await configurationPlan(state);
    const pending = await refreshRuntime(state, true);
    try {
      await deploy(state, true, plan, packageRoot);
    } catch (error) {
      if (pending) console.error(`kitto: runtime ${pending.version} stays unverified because the deployment did not finish. `
        + 'Rerun `kitto update --apply` to finish, or `kitto setup --recover` to return to the previous runtime.');
      throw error;
    }
    await finalizeRuntime(state, pending);
    console.log(`Kitto update complete: runtime ${state.version}, configuration ${sourceRevision(state.source).commit.slice(0, 7)}. Restart native hosts to load new plugin code.`);
  };
  if (apply) await locked(home, work); else await work();
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
  const boundary = options['routing-boundary'], routingRoutes = options['routing-routes'];
  if (routingRoutes !== undefined && boundary === undefined) throw new Error('--routing-routes requires --routing-boundary custom.');
  if (options.global || Object.hasOwn(options, 'workspace') || Object.hasOwn(options, 'workspace-parent')) {
    if (boundary !== undefined) throw new Error('Routing boundary requires full local Kitto setup, not scoped setup.');
    if (options['include-private'] || options['no-include-private']) {
      throw new Error('--include-private and --no-include-private apply to global setup/update; scoped setup does not sync MCP servers.');
    }
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
    : old.agents || Object.keys(hosts).filter(availableHost);
  if (!agents.length) throw new Error('No agent detected. Select --agents pi,codex,dsh; add --install-agents to install missing CLIs.');
  const dshProfile = validateDshProfile(options['dsh-profile'] ?? old.dshProfile ?? 'web');
  if (options['dsh-profile'] && !agents.includes('dsh')) throw new Error('--dsh-profile requires DSH.');
  const installPnpm = agents.includes('dsh') && !isDesktopProfile(dshProfile) && !available('pnpm');
  if (installPnpm && !options['install-agents']) throw new Error('DSH native plugin operations require pnpm on PATH. Add --install-agents to install the missing prerequisite.');
  if (installPnpm) console.log(`Install missing DSH prerequisite: pnpm@${pnpmVersion}`);
  if (!available('git')) throw new Error('git is required.');
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
    const sameSource = basename(source) === basename(old.source) && sameLocation(dirname(source), dirname(old.source));
    if (!sameSource) throw new Error('This installation already has a source. Keep it or use a separate KITTO_HOME; source switching is not implicit.');
  }
  if (!local && !isGitUrl(requested)) throw new Error('Source must be an existing checkout or HTTPS/SSH Git URL.');
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
  const marker = await present(markerPath) ? await json(markerPath).catch(() => undefined) : undefined;
  const sourceUrl = local ? marker?.url : requested;
  const sourceRef = options.ref ?? marker?.ref ?? old.sourceRef ?? null;
  console.log(`Global setup: ${agents.join(', ')}; source: ${requested}; Kitto home: ${home}`);
  const checkedAgents = agents.filter(name => !(name === 'dsh' && isDesktopProfile(dshProfile)));
  checkSelectedHosts(checkedAgents, options['install-agents'], { requireBaseline: options['require-baseline'] === true });
  const includePrivate = options['include-private'] === true ? true
    : options['no-include-private'] === true ? false : old.includePrivate === true;
  const state = { ...old, schema: 1, ready: false, detached: false, removing: false, removedAgents: [], source, agents, dshProfile,
    includePrivate, sourceUrl: sourceUrl || old.sourceUrl, sourceRef, pendingRuntime: undefined,
    agentsHome: old.agentsHome || resolve((agents.includes('pi') && process.env.PI_AGENTS_DIR)
      || (agents.includes('dsh') && process.env.DSH_AGENTS_HOME) || join(homedir(), '.agents')),
    piHome: old.piHome || resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent')),
    codexHome: old.codexHome || resolve(process.env.CODEX_HOME || join(homedir(), '.codex')),
    dshHome: old.dshHome || resolve(process.env.DSH_HOME || join(homedir(), '.dsh')),
    version: (await json(join(packageRoot, 'package.json'))).version,
  };
  if (options.serviceSetup === true) {
    if (boundary !== undefined) throw new Error('Do not copy a local routing boundary to a service account.');
    state.routingInstallKind = 'service';
  } else if (boundary !== undefined) {
    if (old.routingInstallKind === 'service' && boundary !== 'skip') throw new Error('Routing is not supported for a Kitto service account.');
    state.routingInstallKind = old.routingInstallKind === 'service' ? 'service' : 'local';
    setRoutingBoundary(state, boundary, routingRoutes);
    console.log(`Local model routing boundary: ${state.routingBoundary.mode}`);
  }
  if (options.keepExistingSkills === true) state.keepExistingSkills = true;
  if (agents.includes('codex') && !sameLocation(state.agentsHome, resolve(homedir(), '.agents'))) {
    throw new Error('Codex discovers shared skills in ~/.agents. Use that common root for PI_AGENTS_DIR / DSH_AGENTS_HOME when selecting Codex.');
  }
  if (agents.includes('dsh') && process.env.DSH_AGENTS_HOME && !sameLocation(process.env.DSH_AGENTS_HOME, state.agentsHome)) {
    throw new Error('DSH_AGENTS_HOME and the shared skill root differ. Use the same root so native DSH sessions can discover your skills.');
  }
  if (agents.includes('dsh')) {
    if (isDesktopProfile(dshProfile)) {
      console.log(`DSH profile: ${dshProfile} (global-only; managed by the Desktop app)`);
      reportDesktopProbe(probeDesktopProfile({ dshHome: state.dshHome }));
      console.log(desktopProfileNotice);
    } else {
      const builtIn = ['web', 'headless', 'sdk', 'sdk-minimal', 'acp'];
      if (!builtIn.includes(dshProfile) && !await present(join(state.dshHome, 'profiles', dshProfile, 'package.json'))) {
        throw new Error(`Initialize the native DSH profile ${dshProfile} before setup.`);
      }
      console.log(`DSH profile: ${dshProfile}`);
    }
  }
  if (options['dry-run']) {
    if (switchTag) console.log(`Would switch the Kitto checkout to tag ${options.ref} and deploy it.`);
    else if (local || resume) {
      await validateSource(state);
      await deploy(state, false);
    }
    console.log(isDesktopProfile(dshProfile)
      ? 'Preview only: clone if needed, persist Kitto runtime, deploy global rules and skills; the app-managed DSH desktop bundle and scopes stay untouched. No writes.'
      : 'Preview only: clone if needed, persist Kitto runtime, deploy selected configuration and skills, register native integrations. No writes.');
    return;
  }
  await locked(home, async () => {
    if (await readState() !== baseline) throw new Error('Kitto installation changed during setup. Run the same command again.');
    if (installPnpm) {
      run('npm', ['install', '--global', `pnpm@${pnpmVersion}`]);
      if (!available('pnpm')) throw new Error('pnpm was installed but cannot run. Check PATH and allow pnpm native-binary install scripts, then rerun setup.');
    }
    installMissingHosts(checkedAgents);
    if (!local && !resume) await cloneSource(home, source, requested, options.ref);
    if (switchTag) {
      if (sourceRevision(source).dirty) throw new Error('Source has local changes. Commit or resolve them before switching tags.');
      git(source, ['fetch', '--no-tags', 'origin', `refs/tags/${options.ref}`]);
      const commit = git(source, ['rev-parse', 'FETCH_HEAD^{commit}']);
      git(source, ['checkout', '--no-overwrite-ignore', '--detach', commit]);
      await atomicJson(bootstrapMarker(source), { ...(await json(bootstrapMarker(source)).catch(() => ({}))), ref: options.ref });
    }
    await validateSource(state);
    const plan = await configurationPlan(state);
    await installRuntime(home, old);
    await atomicJson(join(home, 'state.json'), state);
    await deploy(state, true, plan);
  });
  console.log(isDesktopProfile(dshProfile)
    ? 'Kitto setup complete. Fully quit and reopen DeepSeek Harness Desktop to load the deployed global rules and skills; ask the Kitto skill to maintain configuration.'
    : 'Kitto setup complete. Start your agent with its native command; ask the Kitto skill to maintain configuration.');
}

export async function maintain(args) {
  const [operation = 'status', ...flags] = args;
  if (operation === 'hosts') return hostsCommand(flags);
  const allowed = { status: [], versions: ['--online'], sync: ['--apply'], update: ['--check', '--apply'], export: ['--apply'], deps: ['--apply'], recover: ['--apply'], remove: ['--apply'] };
  if (!allowed[operation] || flags.some(flag => !allowed[operation].includes(flag))) throw new Error('Unsupported maintenance operation or flag. Read the Kitto skill.');
  if (operation === 'update') return update(flags);
  const home = kittoHome(), state = await json(join(home, 'state.json'));
  const apply = flags.includes('--apply');
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
      if (operation === 'deps') await installDependencies(state, apply);
      else if (operation === 'export') {
        if (!state.agents.includes('pi')) throw new Error('Pi export requires a Pi installation. Edit shared skills in the source checkout.');
        syncCommand(state, 'push', apply);
      } else await deploy(state, apply);
    };
    if (apply) await locked(home, work); else await work();
  }
}
