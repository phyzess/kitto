import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sameLocation } from './paths.mjs';
import { readScopeRegistry, scopeHome } from './scopes.mjs';

const INDEX_DIR = '.codegraph';

function isInside(path, root) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function gitRoot(path) {
  let directory;
  try { directory = resolve(path); } catch { return undefined; }
  for (;;) {
    try {
      const stat = statSync(join(directory, '.git'));
      if (stat.isDirectory() || stat.isFile()) return directory;
    } catch {  }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function childRepos(parent) {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => gitRoot(join(parent, entry.name)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function codegraphTargets(options = {}) {
  const { source, dshHome, agentsHome, home = scopeHome(), cwd = process.cwd(), registeredOnly = false } = options;
  const registry = await readScopeRegistry(home);
  const targets = new Set();
  const excluded = [source, dshHome, agentsHome].filter(Boolean).map(path => resolve(path));
  const add = path => {
    const repo = gitRoot(path);
    if (!repo || excluded.some(root => isInside(repo, root))) return;
    targets.add(repo);
  };
  const addWorkspace = root => {
    if (!existsSync(root)) return;
    const repo = gitRoot(root);
    if (repo) add(repo);
    else for (const child of childRepos(root)) add(child);
  };
  for (const root of registry.workspaces ?? []) addWorkspace(root);
  for (const parent of registry.workspaceParents ?? []) addWorkspace(parent);
  if (!registeredOnly) {
    if (targets.size === 0) add(cwd);
    if (targets.size === 0 && !sameLocation(cwd, homedir())) for (const child of childRepos(cwd)) add(child);
  }
  return [...targets].sort();
}

export function canWrite(path) {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function hasCodegraph() {
  return spawnSync('codegraph', ['--version'], { stdio: 'ignore', timeout: 8000 }).status === 0;
}

export function codegraphPlan(targets, { available = true, writable = canWrite } = {}) {
  return targets.map(path => {
    const indexed = isDirectory(join(path, INDEX_DIR));
    const action = indexed ? 'ready' : !available ? 'missing-cli' : !writable(path) ? 'unwritable' : 'init';
    return { path, action };
  });
}

function defaultRun(path) {
  return spawnSync('codegraph', ['init', '-y', path], { stdio: 'inherit', timeout: 600_000 });
}

export async function reportCodeGraphIndexes(state = {}) {
  const plan = codegraphPlan(await codegraphTargets(state), { available: hasCodegraph() });
  for (const item of plan) {
    if (item.action === 'ready') continue;
    if (item.action === 'missing-cli') console.log(`codegraph index unavailable: ${item.path} (codegraph CLI not found)`);
    else if (item.action === 'unwritable') console.log(`codegraph index missing: ${item.path} (not writable by the current user)`);
    else console.log(`codegraph index missing: ${item.path} (run codegraph init ${item.path})`);
  }
  return plan;
}

export async function ensureCodeGraphIndexes(state = {}, options = {}) {
  const { apply = false, log = console.log, targets, available = hasCodegraph(), writable = canWrite, run = defaultRun, registeredOnly = false } = options;
  const paths = targets ?? await codegraphTargets({ ...state, registeredOnly });
  if (paths.length === 0) return [];
  const plan = codegraphPlan(paths, { available, writable });
  const disabled = process.env.KITTO_NO_CODEGRAPH_INIT === '1';
  for (const item of plan) {
    if (item.action === 'ready') {
      log(`codegraph index ready: ${item.path}`);
      continue;
    }
    if (item.action === 'missing-cli') {
      log(`codegraph index unavailable: ${item.path} (codegraph CLI not found; install @colbymchenry/codegraph)`);
      continue;
    }
    if (item.action === 'unwritable') {
      log(`codegraph index missing: ${item.path} (not writable by the current user; run codegraph init as the workspace owner)`);
      continue;
    }
    if (!apply || disabled) {
      log(`codegraph index missing: ${item.path} (run codegraph init ${item.path})`);
      continue;
    }
    const result = run(item.path);
    if (result?.status === 0) log(`codegraph index created: ${item.path}`);
    else log(`codegraph index failed: ${item.path} (${result?.error?.message || `exit ${result?.status}`})`);
  }
  return plan;
}
