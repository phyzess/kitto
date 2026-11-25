import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const runtimeDir = resolve(packageDir);

export function scopeHome() {
  if (runtimeDir.endsWith(sep + 'scope-runtime') && existsSync(join(runtimeDir, '.kitto-scope-runtime'))) return dirname(runtimeDir);
  return resolve(process.env.KITTO_HOME || join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'kitto'));
}

const registryPath = home => join(home, 'scopes.json');

function emptyScopeRegistry() {
  return { version: 1, global: false, workspaces: [], workspaceParents: [] };
}

function validateScopeRegistry(registry, file) {
  const paths = value => Array.isArray(value) && value.every(path => typeof path === 'string' && isAbsolute(path));
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) ||
      registry.version !== 1 || typeof registry.global !== 'boolean' ||
      !paths(registry.workspaces) ||
      (registry.workspaceParents !== undefined && !paths(registry.workspaceParents))) {
    throw new Error('Invalid Kitto scope registry: ' + file);
  }
}

export async function readScopeRegistry(home = scopeHome()) {
  const file = registryPath(home);
  let contents;
  try { contents = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyScopeRegistry();
    throw error;
  }
  let registry;
  try { registry = JSON.parse(contents); }
  catch (error) { throw new Error('Invalid Kitto scope registry: ' + file, { cause: error }); }
  validateScopeRegistry(registry, file);
  return registry;
}

export async function writeScopeRegistry(home, registry) {
  const file = registryPath(home);
  validateScopeRegistry(registry, file);
  const next = {
    ...registry,
    workspaces: [...registry.workspaces],
    workspaceParents: [...(registry.workspaceParents ?? [])],
  };
  await mkdir(home, { recursive: true });
  const temporary = join(home, 'scopes.' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function descendantPath(root, directory) {
  const path = relative(root, directory);
  if (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)) return path;
}

export async function resolveScopes(cwd, home = scopeHome()) {
  const registry = await readScopeRegistry(home);
  const directory = await realpath(cwd);
  const roots = registry.workspaces.filter(root => descendantPath(root, directory) !== undefined);
  for (const parent of registry.workspaceParents ?? []) {
    const path = descendantPath(parent, directory);
    if (path) roots.push(join(parent, path.split(sep, 1)[0]));
  }
  roots.sort((left, right) => left.length - right.length);
  if (registry.global) roots.unshift(join(home, 'global'));
  return [...new Set(roots)].map(root => ({
    root, instructions: join(root, 'AGENTS.md'), skills: join(root, '.agents', 'skills'),
  }));
}
