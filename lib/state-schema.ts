import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { packageHash, packageKey } from './package-key.ts';

export const CURRENT_SCHEMA = 2;
export const INSTRUCTIONS_NAME = 'agents-md';
export const MANAGED_PACKAGES_FILE = 'managed-packages.json';
export const V1_BACKUP_NAME = 'state.v1.json';

const hasOwn = (object, key) => Object.hasOwn(object, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function schemaOf(state) {
  if (!isObject(state)) throw new Error('Kitto state must be a JSON object.');
  const schema = state.schema ?? 1;
  if (schema !== 1 && schema !== CURRENT_SCHEMA) {
    throw new Error(`Unsupported Kitto state schema ${JSON.stringify(state.schema)}; this Kitto understands 1 and ${CURRENT_SCHEMA}. Upgrade Kitto to read it.`);
  }
  return schema;
}

function put(owned, kind, scope, name, entry) {
  owned[kind] ||= {};
  owned[kind][scope] ||= {};
  owned[kind][scope][name] = entry;
}

function importPiPackages(owned, piLocalDir) {
  const path = join(piLocalDir, MANAGED_PACKAGES_FILE);
  if (!existsSync(path)) return { imported: false };
  let specs;
  try { specs = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    throw new Error(`Cannot import ${path}: ${error.message}`);
  }
  if (!Array.isArray(specs)) throw new Error(`Cannot import ${path}: expected a JSON array.`);
  for (const spec of specs) {
    const name = packageKey(spec);
    if (!name || name === '__proto__') continue;
    const hash = packageHash(spec);
    put(owned, 'pi-package', 'pi', name, { hash, status: 'owned', spec });
  }
  return { imported: true, path };
}

export function migrateState(input, { piLocalDir = undefined } = {}) {
  const schema = schemaOf(input);
  const state = structuredClone(input);
  if (schema === CURRENT_SCHEMA) {
    const path = state.migration?.pi?.imported && piLocalDir ? join(piLocalDir, MANAGED_PACKAGES_FILE) : undefined;
    return { state, changed: false, removable: path && existsSync(path) ? [path] : [] };
  }
  const owned = {};
  const present = [];
  if (hasOwn(state, 'skills')) {
    present.push('skills');
    owned.skill ||= {};
    owned.skill.shared = {};
    for (const [name, hash] of Object.entries(state.skills ?? {})) owned.skill.shared[name] = { hash, status: 'owned' };
    delete state.skills;
  }
  if (hasOwn(state, 'hostSkills')) {
    present.push('hostSkills');
    for (const [group, skills] of Object.entries(state.hostSkills ?? {})) {
      present.push(`hostSkills.${group}`);
      owned.skill ||= {};
      owned.skill[group] = {};
      for (const [name, hash] of Object.entries(skills ?? {})) owned.skill[group][name] = { hash, status: 'owned' };
    }
    delete state.hostSkills;
  }
  if (hasOwn(state, 'keptSkills')) {
    present.push('keptSkills');
    for (const [group, names] of Object.entries(state.keptSkills ?? {})) {
      for (const name of names) {
        if (owned.skill?.[group] && hasOwn(owned.skill[group], name)) continue;
        put(owned, 'skill', group, name, { hash: null, status: 'kept' });
      }
    }
    delete state.keptSkills;
  }
  if (hasOwn(state, 'instructions')) {
    present.push('instructions');
    for (const [host, block] of Object.entries(state.instructions ?? {})) {
      put(owned, 'instructions', host, INSTRUCTIONS_NAME, { hash: block, status: 'owned' });
    }
    delete state.instructions;
  }
  if (isObject(state.mcp)) {
    present.push('mcp');
    const confirmed = state.mcp.codex;
    const pending = state.mcp.codexPending;
    if (hasOwn(state.mcp, 'codex')) present.push('mcp.codex');
    if (hasOwn(state.mcp, 'codexPending')) present.push('mcp.codexPending');
    for (const [name, hash] of Object.entries(confirmed ?? {})) put(owned, 'mcp', 'codex', name, { hash, status: 'owned' });
    for (const [name, hash] of Object.entries(pending ?? {})) {
      const previous = confirmed && hasOwn(confirmed, name) ? { previous: confirmed[name] } : {};
      put(owned, 'mcp', 'codex', name, { hash, status: 'pending', ...previous });
    }
    delete state.mcp.codex;
    delete state.mcp.codexPending;
    if (!Object.keys(state.mcp).length) delete state.mcp;
  }
  const pi = piLocalDir ? importPiPackages(owned, piLocalDir) : { imported: false };
  state.schema = CURRENT_SCHEMA;
  state.owned = owned;
  state.migration = { from: 1, present, pi: { imported: pi.imported } };
  return { state, changed: true, removable: pi.imported ? [pi.path] : [] };
}

function unrepresentable(what) {
  return new Error(`Cannot downgrade Kitto state to schema 1: ${what}.`);
}

export function downgradeState(input) {
  const schema = schemaOf(input);
  const state = structuredClone(input);
  if (schema === 1) return state;
  const present = new Set(state.migration?.present ?? []);
  const skills = {}, hostSkills = {}, keptSkills = {}, instructions = {}, codex = {}, codexPending = {};
  for (const [kind, scopes] of Object.entries(state.owned ?? {})) {
    for (const [scope, entries] of Object.entries(scopes)) {
      if (kind === 'skill') {
        const target = scope === 'shared' ? skills : (hostSkills[scope] ||= {});
        for (const [name, entry] of Object.entries(entries)) {
          if (entry.status === 'owned') target[name] = entry.hash;
          else if (entry.status === 'kept') (keptSkills[scope] ||= []).push(name);
          else throw unrepresentable(`pending skill ${scope}/${name}`);
        }
      } else if (kind === 'instructions') {
        for (const [name, entry] of Object.entries(entries)) {
          if (name !== INSTRUCTIONS_NAME || entry.status !== 'owned') throw unrepresentable(`instructions ${scope}/${name}`);
          instructions[scope] = entry.hash;
        }
      } else if (kind === 'mcp') {
        if (scope === 'dsh') continue;
        if (scope !== 'codex') throw unrepresentable(`mcp scope ${scope}`);
        for (const [name, entry] of Object.entries(entries)) {
          if (entry.status === 'owned') codex[name] = entry.hash;
          else if (entry.status === 'pending') {
            codexPending[name] = entry.hash;
            if (entry.previous !== undefined) codex[name] = entry.previous;
          } else throw unrepresentable(`kept mcp ${scope}/${name}`);
        }
      } else if (kind !== 'pi-package') throw unrepresentable(`unknown kind ${kind}`);
    }
  }
  for (const key of present) {
    if (key.startsWith('hostSkills.')) hostSkills[key.slice('hostSkills.'.length)] ||= {};
  }
  for (const group of Object.keys(hostSkills)) {
    const entries = state.owned?.skill?.[group] ?? {};
    const owns = Object.values(entries).some(entry => entry.status === 'owned');
    if (!owns && !present.has(`hostSkills.${group}`)) delete hostSkills[group];
  }
  delete state.owned;
  delete state.migration;
  state.schema = 1;
  if (present.has('skills') || Object.keys(skills).length) state.skills = skills;
  if (present.has('hostSkills') || Object.keys(hostSkills).length) state.hostSkills = hostSkills;
  if (present.has('keptSkills') || Object.keys(keptSkills).length) state.keptSkills = keptSkills;
  if (present.has('instructions') || Object.keys(instructions).length) state.instructions = instructions;
  if (present.has('mcp') || Object.keys(codex).length || Object.keys(codexPending).length) {
    state.mcp ||= {};
    if (present.has('mcp.codex') || Object.keys(codex).length) state.mcp.codex = codex;
    if (present.has('mcp.codexPending') || Object.keys(codexPending).length) state.mcp.codexPending = codexPending;
  }
  return state;
}

export function importedPiPackages(state) {
  return Object.values(state.owned?.['pi-package']?.pi ?? {}).map(entry => entry.spec);
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function readText(path) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeBackupOnce(path, text) {
  try {
    await writeFile(path, text, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

export async function loadState(path, { dryRun = false, piLocalDir = undefined } = {}) {
  const text = await readText(path);
  if (text === undefined) return undefined;
  const result = migrateState(JSON.parse(text), { piLocalDir });
  let backup = false;
  if (result.changed && !dryRun) {
    backup = await writeBackupOnce(join(dirname(path), V1_BACKUP_NAME), text);
    await atomicJson(path, result.state);
  }
  return { ...result, backup, wrote: result.changed && !dryRun };
}

export async function saveState(path, state, { dryRun = false } = {}) {
  if (schemaOf(state) !== CURRENT_SCHEMA) throw new Error(`Refusing to save state schema ${state.schema ?? 1}; migrate it first.`);
  if (dryRun) return false;
  await atomicJson(path, state);
  return true;
}

export async function rollbackState(path, { dryRun = false } = {}) {
  const text = await readText(path);
  if (text === undefined) return undefined;
  const state = downgradeState(JSON.parse(text));
  if (!dryRun) await atomicJson(path, state);
  return { state, wrote: !dryRun };
}
