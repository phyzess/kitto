import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile, lstat, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const hosts = {
  pi: { package: '@earendil-works/pi-coding-agent', version: '1.5.2' },
  codex: { package: '@openai/codex', version: '0.169.0' },
  dsh: { package: '@deepseek-ai/dsh', version: '0.2.2-rc.1' },
};
export const pnpmVersion = '12.18.0'; // Required by the native DSH plugin manager.
const defaultSource = 'https://github.com/phyzess/pi-config.git';
export const kittoHome = () => {
  // Native hosts do not need to inherit the shell used during setup.
  const installedHome = dirname(resolve(packageRoot));
  return resolve(process.env.KITTO_HOME || (existsSync(join(installedHome, 'state.json')) && resolve(packageRoot) === join(installedHome, 'runtime')
    ? installedHome : join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'kitto')));
};
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const present = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

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
    if (['--dry-run', '--install-agents', '--recover'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--agents', '--source', '--ref'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('-')) options[arg.slice(2)] = args[++i];
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

async function validateSource(source) {
  if (git(source, ['rev-parse', '--show-toplevel']) !== await realpath(source)) throw new Error('Source must be the root of a Git checkout.');
  const settings = await json(join(source, 'config/pi/settings.json'));
  if (!Array.isArray(settings.packages)) throw new Error('Source lacks config/pi/settings.json packages.');
  await json(join(source, 'config/pi/mcp.json'));
  await readFile(join(source, 'config/pi/AGENTS.md'));
  await readdir(join(source, 'skills'));
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
  if (name === 'codex') run(name, ['plugin', 'add', '--help'], { capture: true, timeout: 8000 });
  if (name === 'dsh') run(name, ['plugin', '--help'], { capture: true, timeout: 8000 });
  console.log(`${name}: ${actual} (tested baseline ${expected})`);
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
      version: (await json(join(previous, 'package.json'))).version, hash: await treeHash(previous, true),
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
      else throw new Error(`Unsupported symlink or special file in skill: ${full}`);
    }
  }
  await walk(path);
  return hash.digest('hex');
}

async function skillPlan(state) {
  const root = join(state.source, 'skills');
  const plans = [], owned = state.skills || {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(root, entry.name, 'SKILL.md'))) continue;
    const source = join(root, entry.name), target = join(state.agentsHome, 'skills', entry.name);
    const nextHash = await treeHash(source);
    let action = 'copy';
    if (await present(target)) {
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) {
        if (resolve(dirname(target), await readlink(target)) !== source) throw new Error(`Skill conflict: ${target} links elsewhere. Preserved.`);
        action = 'linked';
      } else {
        const current = await treeHash(target);
        if (current === nextHash) action = 'same';
        else if (current !== owned[entry.name]) throw new Error(`Skill conflict: ${target} differs from the source and last deployment. Preserved.`);
      }
    }
    plans.push({ name: entry.name, source, target, hash: nextHash, action });
  }
  for (const name of Object.keys(owned)) {
    if (plans.some(plan => plan.name === name)) continue;
    const target = join(state.agentsHome, 'skills', name);
    if (await present(target)) {
      if ((await lstat(target)).isSymbolicLink() || await treeHash(target) !== owned[name]) throw new Error(`Removed skill has local changes: ${target}. Preserved.`);
      plans.push({ name, target, action: 'remove' });
    }
  }
  return plans;
}

function syncCommand(state, command, apply = false, codeRoot = join(kittoHome(), 'runtime')) {
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
      run('dsh', ['plugin', '--profile', 'web', 'add', runtime], {
        env: { ...process.env, DSH_HOME: state.dshHome, DSH_AGENTS_HOME: state.agentsHome },
      });
    }
  }
}

async function deploy(state, apply) {
  const plans = await skillPlan(state); // Preflight every shared skill before Pi writes.
  for (const plan of plans) console.log(`skill ${plan.action}: ${plan.name}`);
  if (state.agents.includes('pi')) syncCommand(state, 'pull', apply);
  if (!apply) {
    console.log(`Connect native Kitto integrations: ${state.agents.join(', ')}`);
    return;
  }
  state.skills = {};
  for (const plan of plans) {
    if (['copy', 'remove'].includes(plan.action)) {
      await rm(plan.target, { recursive: true, force: true });
      if (plan.action === 'copy') await cp(plan.source, plan.target, { recursive: true });
    }
    if (plan.action !== 'remove') state.skills[plan.name] = plan.hash;
  }
  // Save deployment ownership before native managers, so retry is recoverable.
  await atomicJson(join(kittoHome(), 'state.json'), state);
  if (!state.ready) {
    await connect(state);
    state.runtimeHash = await treeHash(join(kittoHome(), 'runtime'), true);
  }
  state.ready = true;
  await atomicJson(join(kittoHome(), 'state.json'), state);
}

async function recover(state, apply) {
  if (state.detached || state.removing) throw new Error('Kitto integrations are being removed or already detached. Use setup to reconnect them.');
  const home = kittoHome(), previous = join(home, 'runtime.previous');
  if (!await present(join(home, 'runtime.previous.json'))) throw new Error('No verified runtime checkpoint. Rerun setup with a known working package version.');
  const checkpoint = await json(join(home, 'runtime.previous.json'));
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

async function removeIntegration(state, name, apply) {
  const home = kittoHome(), runtime = join(home, 'runtime');
  if (name === 'pi') {
    const settings = join(state.piHome, 'settings.json');
    const data = await present(settings) ? await json(settings) : {};
    const owned = value => typeof value === 'string' && (value.startsWith('.') || value.startsWith('/')) && resolve(state.piHome, value) === runtime;
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
    if (market && resolve(market.root) !== home) throw new Error('The phyzess-kitto marketplace now belongs to another location. Preserved.');
    const plugins = JSON.parse(run('codex', ['plugin', 'list', '--json'], { env, capture: true }));
    if (plugins.installed.some(item => item.marketplaceName === 'phyzess-kitto' && item.pluginId !== 'kitto@phyzess-kitto')) {
      throw new Error('The Kitto marketplace contains other installed plugins. Preserved; detach them or move them to their own marketplace first.');
    }
    const plugin = plugins.installed.find(item => item.pluginId === 'kitto@phyzess-kitto');
    if (plugin && (plugin.source?.source !== 'local' || resolve(plugin.source.path) !== join(runtime, 'integration'))) {
      throw new Error('The Codex Kitto plugin now comes from another source. Preserved.');
    }
    if (apply && plugin) run('codex', ['plugin', 'remove', 'kitto@phyzess-kitto'], { env });
    if (apply && market) run('codex', ['plugin', 'marketplace', 'remove', 'phyzess-kitto'], { env });
  } else if (name === 'dsh') {
    const manifest = join(state.dshHome, 'profiles/web/package.json');
    if (!await present(manifest)) return;
    const profile = await json(manifest), dependency = profile.dependencies?.['@phyzess/kitto'];
    if (dependency && dependency !== `link:${runtime}`) throw new Error('DSH Kitto dependency now comes from another source. Preserved.');
    if (dependency || profile.dsh?.profile?.bundles?.includes('@phyzess/kitto')) {
      if (!available('pnpm')) throw new Error('DSH native removal requires pnpm on PATH. Restore pnpm before retrying removal.');
      if (apply) run('dsh', ['plugin', '--profile', 'web', 'remove', '@phyzess/kitto'], { env: { ...process.env, DSH_HOME: state.dshHome } });
    }
  }
}

async function remove(state, apply) {
  console.log(`Detach Kitto from ${state.agents.join(', ')}. Keep configuration, shared skills, agent CLIs and Kitto files for recovery/reinstallation.`);
  // Inspect every remaining host before making any change.
  const remaining = state.agents.filter(name => !(state.removedAgents || []).includes(name));
  for (const name of remaining) await removeIntegration(state, name, false);
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

export async function setup(options = {}) {
  const home = kittoHome();
  if (options.recover) {
    const state = await json(join(home, 'state.json'));
    if (options['dry-run']) return recover(state, false);
    return locked(home, () => recover(state, true));
  }
  const old = existsSync(join(home, 'state.json')) ? await json(join(home, 'state.json')) : {};
  const agents = options.agents ? [...new Set([...(old.agents || []), ...options.agents])]
    : old.agents || Object.keys(hosts).filter(available);
  if (!agents.length) throw new Error('No agent detected. Select --agents pi,codex,dsh; add --install-agents to install missing CLIs.');
  const installPnpm = agents.includes('dsh') && !available('pnpm');
  if (installPnpm && !options['install-agents']) throw new Error('DSH native plugin operations require pnpm on PATH. Add --install-agents to install the missing prerequisite.');
  if (installPnpm) console.log(`Install missing DSH prerequisite: pnpm@${pnpmVersion}`);
  for (const name of ['git', 'bash', 'python3']) if (!available(name)) throw new Error(`${name} is required.`);
  run('python3', ['-c', 'import sys; assert sys.version_info >= (3,10), "Python >=3.10 required"'], { capture: true });
  const requested = options.source || old.source || defaultSource;
  const local = existsSync(requested);
  const source = local ? await realpath(requested) : join(home, 'config');
  if (old.source && source !== old.source) throw new Error('This installation already has a source. Keep it or use a separate KITTO_HOME; source switching is not implicit.');
  if (!local && !/^(https:\/\/|ssh:\/\/|git@)/.test(requested)) throw new Error('Source must be an existing checkout or HTTPS/SSH Git URL.');
  if (!local && existsSync(source)) throw new Error(`Unregistered checkout already exists at ${source}. Inspect it and rerun with --source ${shellQuote(source)}.`);
  if (local && options.ref) throw new Error('--ref is only for a new clone; existing checkout branches are preserved.');
  console.log(`Global setup: ${agents.join(', ')}; source: ${requested}; Kitto home: ${home}`);
  for (const name of agents) {
    if (!available(name)) {
      if (!options['install-agents']) throw new Error(`${name} is missing. Install it natively or add --install-agents (pins ${hosts[name].version}).`);
      console.log(`Install missing CLI: ${hosts[name].package}@${hosts[name].version}${name === 'dsh' ? ' (prerelease)' : ''}`);
    } else checkHost(name);
  }
  const state = { ...old, schema: 1, ready: false, detached: false, removing: false, removedAgents: [], source, agents,
    agentsHome: old.agentsHome || resolve(process.env.PI_AGENTS_DIR || process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')),
    piHome: old.piHome || resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent')),
    codexHome: old.codexHome || resolve(process.env.CODEX_HOME || join(homedir(), '.codex')),
    dshHome: old.dshHome || resolve(process.env.DSH_HOME || join(homedir(), '.dsh')),
    version: (await json(join(packageRoot, 'package.json'))).version,
  };
  if (agents.includes('codex') && state.agentsHome !== resolve(homedir(), '.agents')) {
    throw new Error('Codex discovers shared skills in ~/.agents. Use that common root for PI_AGENTS_DIR / DSH_AGENTS_HOME when selecting Codex.');
  }
  if (agents.includes('dsh') && process.env.DSH_AGENTS_HOME && resolve(process.env.DSH_AGENTS_HOME) !== state.agentsHome) {
    throw new Error('DSH_AGENTS_HOME and the shared skill root differ. Use the same root so native DSH sessions can discover your skills.');
  }
  if (options['dry-run']) {
    if (local) {
      await validateSource(source);
      for (const plan of await skillPlan(state)) console.log(`skill ${plan.action}: ${plan.name}`);
      if (agents.includes('pi')) syncCommand(state, 'pull', false, packageRoot);
    }
    console.log('Preview only: clone if needed, persist Kitto runtime, deploy shared skills and Pi config, register native integrations. No writes.');
    return;
  }
  await locked(home, async () => {
    if (installPnpm) {
      run('npm', ['install', '--global', `pnpm@${pnpmVersion}`]);
      if (!available('pnpm')) throw new Error('pnpm was installed but is not available on PATH. Fix PATH and rerun setup.');
    }
    for (const name of agents) if (!available(name)) {
      run('npm', ['install', '--global', `${hosts[name].package}@${hosts[name].version}`]);
      checkHost(name);
    }
    if (!local) run('git', ['clone', ...(options.ref ? ['--branch', options.ref] : []), '--', requested, source]);
    await validateSource(source);
    await skillPlan(state);
    await installRuntime(home, old);
    await atomicJson(join(home, 'state.json'), state);
    await deploy(state, true);
  });
  console.log('Kitto setup complete. Start pi / codex / dsh web normally; ask the Kitto skill to maintain configuration.');
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
  await validateSource(state.source);
  if (operation === 'status') {
    console.log(JSON.stringify({ ...state, git: git(state.source, ['status', '--short', '--branch']) }, null, 2));
    for (const plan of await skillPlan(state)) console.log(`skill ${plan.action}: ${plan.name}`);
    if (state.agents.includes('pi')) syncCommand(state, 'status');
  } else if (operation === 'versions') {
    run('python3', [join(home, 'runtime/lib/versions.py'), ...flags], { env: { ...process.env, KITTO_CONFIG_ROOT: state.source, PI_CODING_AGENT_DIR: state.piHome } });
  } else {
    const work = async () => {
      if (operation === 'update') {
        if (git(state.source, ['status', '--porcelain'])) throw new Error('Source has local changes. Commit or resolve them before update; nothing was stashed or reset.');
        const branch = git(state.source, ['symbolic-ref', '--short', 'HEAD']);
        const remote = git(state.source, ['config', `branch.${branch}.remote`]);
        const ref = git(state.source, ['config', `branch.${branch}.merge`]);
        if (remote === '.') throw new Error('A remote-tracking branch is required for update.');
        if (!apply) { console.log(run('git', ['-C', state.source, 'ls-remote', remote, ref], { capture: true, timeout: 30_000 })); return; }
        git(state.source, ['pull', '--ff-only']);
        await validateSource(state.source);
      }
      if (operation === 'deps') syncCommand(state, 'deps', apply);
      else if (operation === 'export') {
        if (!state.agents.includes('pi')) throw new Error('Pi export requires a Pi installation. Edit shared skills in the source checkout.');
        syncCommand(state, 'push', apply);
      } else await deploy(state, apply);
    };
    if (apply) await locked(home, work); else await work();
  }
}
