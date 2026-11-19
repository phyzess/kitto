import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const runtimeDir = resolve(packageDir);

export function scopeHome() {
  // Native agents may run without the environment used by the setup command.
  if (runtimeDir.endsWith(sep + 'scope-runtime') && existsSync(join(runtimeDir, '.kitto-scope-runtime'))) return dirname(runtimeDir);
  return resolve(process.env.KITTO_HOME || join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'kitto'));
}

export async function readScopeRegistry(home = scopeHome()) {
  let contents;
  try { contents = await readFile(join(home, 'scopes.json'), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, global: false, workspaces: [] };
    throw error;
  }
  const registry = JSON.parse(contents);
  const { workspaceParents, workspaces } = registry;
  const paths = value => Array.isArray(value) && value.every(path => typeof path === 'string' && isAbsolute(path));
  if (registry.version !== 1 || typeof registry.global !== 'boolean' ||
      !paths(workspaces) || (workspaceParents !== undefined && !paths(workspaceParents))) {
    throw new Error('Invalid Kitto scope registry: ' + join(home, 'scopes.json'));
  }
  return registry;
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
