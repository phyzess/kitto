import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPackageDir = fileURLToPath(new URL('../', import.meta.url));
const systemEnv = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' };
const properties = ['Id', 'LoadState', 'ActiveState', 'MainPID', 'User', 'DynamicUser', 'RootDirectory', 'RootImage'];

function execute(program, args, { cwd = '/', capture = true, timeout = 8_000 } = {}) {
  const result = spawnSync(program, args, {
    cwd, env: systemEnv, encoding: 'utf8', timeout, stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} failed: ${result.error?.message || result.stderr?.trim() || result.signal || result.status}`);
  }
  return result.stdout ?? '';
}

export function readServiceProperties(unit, output) {
  const details = Object.fromEntries(output.trimEnd().split('\n').map(line => {
    const equals = line.indexOf('=');
    return [line.slice(0, equals), line.slice(equals + 1)];
  }));
  if (details.Id !== unit || details.LoadState !== 'loaded' || details.ActiveState !== 'active' ||
      !/^[1-9][0-9]*$/.test(details.MainPID ?? '')) {
    throw new Error(`Expected a loaded and active systemd service with a main process: ${unit}`);
  }
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*[$]?$/.test(details.User ?? '') ||
      details.User === 'root' || /^0+$/.test(details.User) ||
      details.DynamicUser !== 'no' || details.RootDirectory !== '' || details.RootImage !== '') {
    throw new Error(`Service must use a fixed non-root account and the host filesystem: ${unit}`);
  }
  return { pid: details.MainPID, user: details.User };
}

function serviceDetails(unit) {
  return readServiceProperties(unit, execute('/usr/bin/systemctl', [
    '--system', 'show', '--no-pager', '--property=' + properties.join(','), '--', unit,
  ]));
}

export function readServiceEnvironment(data) {
  const env = {};
  for (const item of data.split('\0')) {
    const equals = item.indexOf('=');
    if (equals === -1) continue;
    const key = item.slice(0, equals);
    if (!['HOME', 'DSH_HOME', 'DSH_AGENTS_HOME', 'KITTO_HOME', 'XDG_DATA_HOME', 'PATH'].includes(key)) continue;
    if (Object.hasOwn(env, key)) throw new Error(`Duplicate service environment variable: ${key}`);
    const value = item.slice(equals + 1);
    const paths = key === 'PATH' ? value.split(':') : [value];
    if (paths.some(path => !isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path))) {
      throw new Error(`Service environment ${key} must contain absolute paths.`);
    }
    env[key] = value;
  }
  if (!env.HOME || !env.PATH) throw new Error('Service environment must provide HOME and PATH.');
  return env;
}

async function accountForService(unit) {
  const { pid, user } = serviceDetails(unit);
  const [name, , uid] = execute('/usr/bin/getent', ['passwd', user]).trimEnd().split(':');
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*[$]?$/.test(name) || !/^[1-9][0-9]*$/.test(uid ?? '')) {
    throw new Error(`Service must use a fixed non-root account: ${unit}`);
  }
  const proc = `/proc/${pid}`;
  const before = await readFile(join(proc, 'stat'), 'utf8');
  const status = await readFile(join(proc, 'status'), 'utf8');
  const processUids = status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m)?.slice(1);
  if (!processUids || !processUids.every(value => value === uid)) {
    throw new Error(`Service process does not match the configured account: ${unit}`);
  }
  const environment = readServiceEnvironment(await readFile(join(proc, 'environ'), 'utf8'));
  const after = await readFile(join(proc, 'stat'), 'utf8');
  const startTime = value => value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
  const current = serviceDetails(unit);
  if (!startTime(before) || startTime(before) !== startTime(after) || current.pid !== pid || current.user !== user) {
    throw new Error(`Service changed while reading its account settings: ${unit}`);
  }
  return { name, uid, environment };
}

async function requireWorkspaceAccess(workspace, includeAssets) {
  async function requireDirectory(path) {
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      await requireDirectory(parent);
      try {
        await access(parent, constants.W_OK | constants.X_OK);
      } catch (accessError) {
        if (accessError.code !== 'ENOENT') throw accessError;
      }
      return;
    }
    if (!info.isDirectory()) throw new Error(`Expected a directory: ${path}`);
    await access(path, constants.R_OK | constants.X_OK);
  }

  await requireDirectory(workspace);
  if (!includeAssets) return;
  await requireDirectory(join(workspace, '.agents', 'skills'));
  try {
    await access(join(workspace, 'AGENTS.md'), constants.R_OK);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await access(workspace, constants.W_OK | constants.X_OK); }
    catch (accessError) { if (accessError.code !== 'ENOENT') throw accessError; }
  }
}

async function checkLocalSource(source) {
  if (!source || !isAbsolute(source)) return;
  try {
    await access(source, constants.R_OK | constants.X_OK);
  } catch (error) {
    throw new Error(`The DSH service account cannot read the local source checkout ${source}. Use a checkout accessible to that account or a Git URL.`, { cause: error });
  }
  const git = spawnSync('git', ['-C', source, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 8_000 });
  if (git.status !== 0) {
    throw new Error(`The DSH service account cannot use the local Git checkout ${source}. Use a checkout trusted by that account or a Git URL.`);
  }
}

async function runServiceSetup() {
  const [, , uid, request] = process.argv;
  if (!/^[1-9][0-9]*$/.test(uid ?? '') || String(process.getuid?.()) !== uid || String(process.geteuid?.()) !== uid) {
    throw new Error('DSH setup must run under the selected non-root service account.');
  }
  const { source, dryRun, dshProfile, deps, workspace, global, installAgents, workspaceParent } = JSON.parse(request);
  await checkLocalSource(source);
  if (workspace) await requireWorkspaceAccess(workspace, !workspaceParent);
  const { setup, maintain, kittoHome } = await import('./kitto.mjs');
  const options = { agents: ['dsh'], 'dry-run': dryRun };
  if (dshProfile) options['dsh-profile'] = dshProfile;
  if (source !== false) {
    await setup({ ...options, keepExistingSkills: true, serviceSetup: true,
      ...(source ? { source } : {}), ...(installAgents ? { 'install-agents': true } : {}) });
  }
  const plans = [global && { global: true }, workspace && { [workspaceParent ? 'workspace-parent' : 'workspace']: workspace }].filter(Boolean);
  if (plans.length && dryRun && source !== false && installAgents &&
      spawnSync('dsh', ['--version'], { stdio: 'ignore', timeout: 8_000 }).status !== 0) {
    console.log('DSH scope registration will run after the DSH CLI is installed.');
  } else {
    for (const plan of plans) await setup({ ...options, ...plan });
  }
  if (deps) {
    const hasState = await stat(join(kittoHome(), 'state.json')).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (!dryRun || source === false || hasState) {
      await maintain(['deps', ...(!dryRun ? ['--apply'] : [])]);
    } else if (source && isAbsolute(source)) {
      const { installDependencies } = await import('./dependencies.mjs');
      await installDependencies({ agents: ['dsh'], source }, false);
    } else {
      console.log('DSH dependency checks will run after the configuration checkout is available.');
    }
  }
}

export async function stageServicePackage(packageDir, stage, legacy = false) {
  async function copy(relative, include = () => true) {
    const source = join(packageDir, relative);
    const target = join(stage, relative);
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error(`Expected an ordinary Kitto package path: ${source}`);
    if (info.isDirectory()) {
      await mkdir(target);
      await chmod(target, 0o755);
      for (const entry of await readdir(source)) {
        if (!entry.startsWith('.') && !['__pycache__', 'node_modules'].includes(entry) && include(entry)) {
          await copy(join(relative, entry));
        }
      }
    } else {
      if (!legacy && !relative.endsWith('.mjs')) return;
      if (!info.isFile()) throw new Error(`Expected a regular Kitto package file: ${source}`);
      await writeFile(target, await readFile(source), { flag: 'wx' });
      await chmod(target, 0o644);
    }
  }

  await copy('bin', name => name.endsWith('.mjs'));
  await copy('lib', name => name.endsWith('.mjs') || (legacy && name.endsWith('.py')));
  await copy('integration', name => legacy || name.startsWith('scoped-'));
  if (legacy) for (const name of ['package.json', 'sync.sh', 'CHANGELOG.md']) await copy(name);
}

function validateServiceHost(unit) {
  if (typeof unit !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/.test(unit)) {
    throw new Error('Expected a systemd service unit name ending in .service.');
  }
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) {
    throw new Error('DSH service setup requires root on a Linux systemd host.');
  }
}

function serviceInvocation({ name, environment }, command) {
  const assignments = Object.entries({ ...environment, USER: name, LOGNAME: name }).map(([key, value]) => key + '=' + value);
  return ['-u', name, '--', '/usr/bin/env', '-i', ...assignments, ...command];
}

export async function servicePnpmAvailable(unit) {
  validateServiceHost(unit);
  const account = await accountForService(unit);
  const result = spawnSync('/usr/sbin/runuser', serviceInvocation(account, ['pnpm', '--version']), {
    cwd: '/', env: systemEnv, stdio: 'ignore', timeout: 3_000,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

async function delegateServiceSetup(unit, packageDir, request) {
  validateServiceHost(unit);
  if (request.workspace !== undefined && (typeof request.workspace !== 'string' || !isAbsolute(request.workspace))) {
    throw new Error('Service workspace must be an absolute path.');
  }
  const account = await accountForService(unit);
  const stage = await mkdtemp('/tmp/kitto-service-');
  try {
    await stageServicePackage(packageDir, stage, request.source !== false || request.deps);
    await chmod(stage, 0o755);
    console.log(`Delegating DSH setup for ${unit} to ${account.name}.`);
    const runner = join(stage, 'lib', 'scope-service.mjs');
    execute('/usr/sbin/runuser', serviceInvocation(account, ['node', runner, account.uid, JSON.stringify(request)]),
      { cwd: stage, capture: false, timeout: request.dryRun ? 60_000 : 1_800_000 });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function configureServiceScope({ unit, root, dryRun = false, packageDir = defaultPackageDir, dshProfile }) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Service workspace must be an absolute path.');
  return delegateServiceSetup(unit, packageDir, { source: false, workspace: root, dryRun, dshProfile });
}

export async function configureServiceEnvironment({
  unit, source, dryRun = false, dshProfile, deps = false, workspace, global = false, installAgents = false,
}) {
  if (typeof source === 'string' && source && !/^(https:\/\/|ssh:\/\/|git@)/.test(source)) source = resolve(source);
  return delegateServiceSetup(unit, defaultPackageDir, { source, dryRun, dshProfile, deps, workspace, global, installAgents, workspaceParent: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runServiceSetup().catch(error => {
    console.error('Kitto service setup: ' + error.message);
    process.exitCode = 1;
  });
}
