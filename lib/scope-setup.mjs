import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readScopeRegistry, scopeHome } from './scopes.mjs';
import { canWrite, ensureCodeGraphIndexes } from './codegraph.mjs';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const installers = { pi: 'installPiScope', codex: 'installCodexScope', dsh: 'installDshScope' };

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function workspacePath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || await exists(path)) throw error;
    return join(await workspacePath(dirname(path)), basename(path));
  }
}

async function installRuntime(home) {
  const runtime = join(home, 'scope-runtime');
  const backup = join(home, 'scope-runtime.previous');
  if (resolve(packageDir) === runtime) return runtime;
  for (const dir of [runtime, backup]) {
    if (await exists(dir) && !await exists(join(dir, '.kitto-scope-runtime'))) {
      throw new Error('Existing directory is not a Kitto scope runtime: ' + dir);
    }
  }
  if (await exists(backup) && !await exists(runtime)) await rename(backup, runtime);
  const temp = await mkdtemp(join(home, '.scope-runtime-'));
  try {
    await writeFile(join(temp, '.kitto-scope-runtime'), '1\n');
    for (const [dir, prefix] of [['lib', 'scope'], ['integration', 'scoped-']]) {
      await mkdir(join(temp, dir));
      for (const entry of await readdir(join(packageDir, dir))) {
        if (entry.startsWith(prefix)) await cp(join(packageDir, dir, entry), join(temp, dir, entry), { recursive: true });
      }
    }
    await cp(join(packageDir, 'lib', 'codegraph.mjs'), join(temp, 'lib', 'codegraph.mjs'));
    if (await exists(runtime)) {
      await rm(backup, { recursive: true, force: true });
      await rename(runtime, backup);
    }
    try { await rename(temp, runtime); }
    catch (error) {
      if (await exists(backup)) await rename(backup, runtime);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    return runtime;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function setupScope(options) {
  const workspaceParent = options['workspace-parent'];
  if ([options.global, options.workspace, workspaceParent].filter(Boolean).length !== 1) {
    throw new Error('Choose exactly one of --global, --workspace PATH or --workspace-parent PATH.');
  }
  for (const key of Object.keys(options)) {
    if (!['global', 'workspace', 'workspace-parent', 'agents', 'dsh-profile', 'dsh-service', 'dry-run'].includes(key)) {
      throw new Error('Scoped setup does not support --' + key);
    }
  }
  const dryRun = Boolean(options['dry-run']);
  const home = scopeHome();
  const global = Boolean(options.global);
  const root = global ? join(home, 'global') : await workspacePath(resolve(workspaceParent || options.workspace));
  if (!global && await exists(root) && !(await stat(root)).isDirectory()) throw new Error('Workspace must be a directory.');
  const unit = options['dsh-service'];
  if (unit && (global || workspaceParent || (options.agents && !options.agents.includes('dsh')))) {
    throw new Error('--dsh-service requires --workspace PATH and the DSH host.');
  }
  const agents = options.agents || Object.keys(installers).filter(name =>
    (name === 'dsh' && unit) || spawnSync(name, ['--version'], { stdio: 'ignore', timeout: 8000 }).status === 0);
  if (!agents.length) throw new Error('No supported host CLI found in this account. Use --agents to select a host.');
  const dshProfile = options['dsh-profile'] || 'web';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(dshProfile) || dshProfile === 'desktop') throw new Error('Invalid DSH profile.');
  if (options['dsh-profile'] && !agents.includes('dsh')) throw new Error('--dsh-profile requires DSH.');

  const args = { global, root, home: homedir(), dshProfile, dryRun };
  const scopeLabel = global ? 'global' : workspaceParent ? 'workspace parent' : 'workspace';
  const contentRoot = workspaceParent ? join(root, '<workspace>') : root;
  console.log(`Kitto ${scopeLabel}: ${root}\nHosts: ${agents.join(', ')}\nInstructions: ${join(contentRoot, 'AGENTS.md')}\nSkills: ${join(contentRoot, '.agents/skills')}`);
  if (!global && await exists(root) && !canWrite(root)) {
    console.warn(`Kitto: workspace ${root} is not writable by the current user. Agents cannot create CodeGraph indexes or edit files there; grant write access (chown or setfacl) before starting a session.`);
  }
  async function installHosts(directory, preview) {
    for (const name of agents) {
      if (unit && name === 'dsh') continue;
      const module = await import(pathToFileURL(join(directory, 'lib', 'scope-' + name + '.mjs')));
      await module[installers[name]]({ ...args, runtime: join(home, 'scope-runtime'), dryRun: preview });
    }
  }
  async function configureService(preview) {
    if (!unit) return;
    const { configureServiceScope } = await import('./scope-service.mjs');
    await configureServiceScope({ unit, root, dryRun: preview, packageDir, dshProfile });
  }
  const instructions = join(root, 'AGENTS.md');
  if (!workspaceParent && await exists(instructions) && !(await stat(instructions)).isFile()) throw new Error('Expected an instructions file at ' + instructions);
  const skills = join(root, '.agents/skills');
  if (!workspaceParent && await exists(skills) && !(await stat(skills)).isDirectory()) throw new Error('Expected a skills directory at ' + skills);
  await readScopeRegistry(home);
  await installHosts(packageDir, true);
  await configureService(true);
  if (dryRun) {
    if (!global) console.log(`CodeGraph: would initialize missing indexes under ${root} when the CLI is available.`);
    return;
  }

  await mkdir(home, { recursive: true });
  const lock = join(home, '.scope-setup.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Scope setup is locked: ' + lock);
    throw error;
  }
  try {
    const registry = await readScopeRegistry(home);
    const runtime = await installRuntime(home);
    if (unit) {
      // Create shared files under the account that works in this directory.
      await configureService(false);
    } else if (!workspaceParent) {
      await mkdir(skills, { recursive: true });
      try { await writeFile(instructions, '', { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    await installHosts(runtime, false);
    if (global) registry.global = true;
    else {
      const roots = workspaceParent ? (registry.workspaceParents ??= []) : registry.workspaces;
      if (!roots.includes(root)) roots.push(root);
    }
    const next = join(home, 'scopes.' + randomUUID() + '.tmp');
    try {
      await writeFile(next, JSON.stringify(registry, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(next, join(home, 'scopes.json'));
    } finally { await rm(next, { force: true }); }
    console.log('Scope ready. Start a new agent session in your project.');
    if (!global) {
      const owner = await stat(root).then(info => info.uid).catch(() => null);
      if (process.getuid?.() === 0 && owner !== null && owner !== 0) {
        console.warn(`CodeGraph indexes: setup runs as root but ${root} belongs to uid ${owner}; run codegraph init as that user instead.`);
      } else {
        await ensureCodeGraphIndexes({ home, source: join(home, 'config') }, { apply: true, registeredOnly: true });
      }
    }
  } finally { await rm(lock, { recursive: true }); }
}
