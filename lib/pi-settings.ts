import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { composeInstructions, normalizeInstructions } from './host-config.ts';
import { packageKey, type PiPackageSpec } from './package-key.ts';

export type JsonObject = Record<string, any>;

export { packageKey };

export const VOLATILE_KEYS = ['lastChangelogVersion', 'extensionChangelogVersions'];
export const AGENTS_BOUNDARY = '<!-- kitto:host-addendum -->';

const SECRET_KEY_NAMES = new Set([
  'apikey',
  'api_key',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'client_secret',
  'password',
  'passwd',
  'private_key',
  'bearer_token',
  'authorization',
]);
const SECRET_VALUE_PATTERNS = new Map([
  ['openai-style key', /sk-[A-Za-z0-9_-]{16,}/],
  ['GitHub token', /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/],
  ['GitHub fine-grained token', /github_pat_[A-Za-z0-9_]{20,}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]);

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object: object, key: string) => Object.hasOwn(object, key);
const contains = (list: unknown[], item: unknown) => list.some((entry) => isDeepStrictEqual(entry, item));
const truthy = (value: unknown) =>
  Array.isArray(value) ? value.length > 0 : isObject(value) ? Object.keys(value).length > 0 : Boolean(value);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${(value as unknown[]).map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function unique<T>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = canonical(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function deepMerge(base: unknown, over: unknown): any {
  if (!isObject(base) || !isObject(over)) return over;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = own(out, key) ? deepMerge(out[key], value) : value;
  return out;
}

export function scanSecrets(value: unknown, path = ''): { cleaned: any; removed: string[]; found: Array<[string, string]> } {
  const removed: string[] = [],
    found: Array<[string, string]> = [];
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const child = path ? `${path}.${key}` : key;
      if (SECRET_KEY_NAMES.has(key.toLowerCase())) {
        removed.push(child);
        continue;
      }
      const scanned = scanSecrets(item, child);
      out[key] = scanned.cleaned;
      removed.push(...scanned.removed);
      found.push(...scanned.found);
    }
    return { cleaned: out, removed, found };
  }
  if (Array.isArray(value)) {
    const cleaned = value.map((item, index) => {
      const scanned = scanSecrets(item, `${path}[${index}]`);
      removed.push(...scanned.removed);
      found.push(...scanned.found);
      return scanned.cleaned;
    });
    return { cleaned, removed, found };
  }
  if (typeof value === 'string') {
    for (const [label, pattern] of SECRET_VALUE_PATTERNS) if (pattern.test(value)) found.push([path, label]);
  }
  return { cleaned: value, removed, found };
}

export function refuseSecrets(found: Array<[string, string]>): void {
  if (!found.length) return;
  const lines = found.map(([path, label]) => `refusing to export a literal secret (${label}) at ${path}`);
  lines.push('Replace the literal with an environment-variable reference or remove it before exporting.');
  throw new Error(lines.join('\n'));
}

export function readText(path: string | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function loadJson(path: string | undefined, fallback: any = null): any {
  const text = readText(path);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${(error as Error).message}`);
  }
}

function replaceFile(path: string, text: string) {
  mkdirSync(dirname(path) || '.', { recursive: true });
  const temporary = join(dirname(path), `.kitto-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeText(path: string, text: string): boolean {
  if (readText(path) === text) return false;
  replaceFile(path, text);
  return true;
}

export function dumpJson(path: string, data: unknown): boolean {
  return writeText(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function dumpSemantic(path: string, data: unknown): boolean {
  if (existsSync(path) && isDeepStrictEqual(loadJson(path), data)) return false;
  return dumpJson(path, data);
}

export function readList(path: string): string[] {
  const text = readText(path);
  if (text === null) return [];
  return text
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function writeList(path: string, values: string[]) {
  const header = '# generated by kitto sync — machine-only pi packages\n';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, values.length ? `${header}${values.join('\n')}\n` : header);
}

export function listSharedPackages(repoPath: string, skipPath: string): string[] {
  const skip = new Set(readList(skipPath).map(packageKey));
  const settings = loadJson(repoPath);
  if (!settings || !Array.isArray(settings.packages)) throw new Error(`missing packages in ${repoPath}`);
  return settings.packages
    .filter((item: PiPackageSpec) => !skip.has(packageKey(item)))
    .map((item: PiPackageSpec) => (typeof item === 'string' ? item : item.source));
}

export function mergeSettings(
  repoPath: string,
  machinePath: string,
  localDir: string,
  outPath: string,
  { previous = [] }: { previous?: unknown[] } = {},
): string[] {
  const repoConfig = loadJson(repoPath, {}) || {};
  const machineConfig = loadJson(machinePath, {}) || {};
  for (const key of VOLATILE_KEYS) delete repoConfig[key];
  const skip = new Set(readList(join(localDir, 'packages.skip.txt')).map(packageKey));
  const repoPackages = repoConfig.packages ?? [];
  const machinePackages = machineConfig.packages ?? [];
  const extra = unique([
    ...readList(join(localDir, 'packages.txt')),
    ...machinePackages.filter((item: unknown) => !contains(repoPackages, item) && !contains(previous, item)),
  ]);
  const overrides = loadJson(join(localDir, 'settings.json'), {}) || {};
  let result: JsonObject = { ...machineConfig, ...repoConfig };
  result = deepMerge(result, overrides);
  const packages = unique([...repoPackages, ...extra].filter((item) => !skip.has(packageKey(item))));
  result.packages = packages;
  const changed = dumpJson(outPath, result);
  const lines = [`settings: ${changed ? 'updated' : 'unchanged'}`];
  const added = packages.filter((item) => !contains(machinePackages, item));
  const removed = machinePackages.filter((item: unknown) => !contains(packages, item));
  if (added.length) lines.push(`  packages added: ${added.join(', ')}`);
  if (removed.length) lines.push(`  packages dropped: ${removed.join(', ')}`);
  if (extra.length) lines.push(`  machine-only packages kept: ${extra.join(', ')}`);
  return lines;
}

export function recordSettings(repoPath: string, machinePath: string, localDir: string): unknown[] {
  const repo = (loadJson(repoPath, {}) || {}).packages ?? [];
  const machine = (loadJson(machinePath, {}) || {}).packages ?? [];
  const extraPath = join(localDir, 'packages.txt');
  const extra = unique([...readList(extraPath), ...machine.filter((item: unknown) => !contains(repo, item))]);
  writeList(
    extraPath,
    extra.filter((item) => typeof item === 'string'),
  );
  return repo;
}

function restoreOverrides(out: JsonObject, repo: JsonObject, overrides: JsonObject): JsonObject {
  const result = { ...out };
  for (const [key, value] of Object.entries(overrides)) {
    if (isObject(value) && isObject(result[key])) {
      result[key] = restoreOverrides(result[key], isObject(repo[key]) ? repo[key] : {}, value);
      if (!Object.keys(result[key]).length && !own(repo, key)) delete result[key];
    } else if (own(repo, key)) result[key] = repo[key];
    else delete result[key];
  }
  return result;
}

export function sanitizeSettings(machinePath: string, repoPath: string, localDir: string, outPath: string): string[] {
  const machine = loadJson(machinePath, {}) || {};
  const repo = loadJson(repoPath, {}) || {};
  const extra = readList(join(localDir, 'packages.txt'));
  const skip = readList(join(localDir, 'packages.skip.txt'));
  const repoPackages = [...(repo.packages ?? [])];
  const machinePackages = [...(machine.packages ?? [])];
  const dropped = machinePackages.filter((item: string) => extra.includes(item) || skip.includes(item));
  const additions = machinePackages.filter(
    (item: string) => !contains(repoPackages, item) && !extra.includes(item) && !skip.includes(item),
  );
  const packages = unique([...repoPackages, ...additions]);
  let out: JsonObject = {};
  for (const key of Object.keys(repo)) {
    if (VOLATILE_KEYS.includes(key)) continue;
    out[key] = key === 'packages' ? packages : own(machine, key) ? machine[key] : repo[key];
  }
  if (!own(out, 'packages')) out.packages = packages;
  const overrides = loadJson(join(localDir, 'settings.json'), {}) || {};
  out = restoreOverrides(out, repo, overrides);
  const scanned = scanSecrets(out);
  refuseSecrets(scanned.found);
  const lines: string[] = [];
  if (scanned.removed.length) lines.push(`  credential-shaped keys left out: ${[...scanned.removed].sort().join(', ')}`);
  const changed = dumpSemantic(outPath, scanned.cleaned);
  lines.push(`settings: ${changed ? 'exported' : 'unchanged'}`);
  if (dropped.length) lines.push(`  machine-only packages left out: ${dropped.join(', ')}`);
  if (additions.length) lines.push(`  new packages taken upstream: ${additions.join(', ')}`);
  return lines;
}

const servers = (path: string): JsonObject => (loadJson(path, {}) || {}).mcpServers || {};

export function mergeMcp(repoPath: string, platformPath: string, localPath: string, machinePath: string, outPath: string): string[] {
  const merged: JsonObject = {};
  for (const path of [machinePath, repoPath, platformPath, localPath]) {
    for (const [name, entry] of Object.entries(servers(path))) {
      if (name.startsWith('_') || !isObject(entry)) continue;
      merged[name] = deepMerge(merged[name] ?? {}, entry);
    }
  }
  const machine = loadJson(machinePath, {}) || {};
  const local = servers(localPath);
  for (const [name, entry] of Object.entries(machine.mcpServers ?? {})) {
    if (!own(merged, name) || !isObject(entry)) continue;
    for (const key of ['enabled', 'exposure', 'toolExposure']) {
      if (own(entry, key) && !(isObject(local[name]) && own(local[name], key))) merged[name][key] = entry[key];
    }
  }
  const changed = dumpJson(outPath, { ...machine, mcpServers: merged });
  const names = Object.keys(merged);
  const on = names.filter((name) => truthy(own(merged[name], 'enabled') ? merged[name].enabled : true));
  const off = names.filter((name) => !on.includes(name));
  const lines = [`mcp: ${changed ? 'updated' : 'unchanged'} (${names.length} servers)`];
  if (on.length) lines.push(`  enabled: ${on.join(', ')}`);
  if (off.length) lines.push(`  disabled: ${off.join(', ')}`);
  return lines;
}

export function exportMcp(
  repoPath: string,
  machinePath: string,
  platformPath: string,
  localPath: string,
  privatePath: string,
  outPath: string,
): string[] {
  const repo = servers(repoPath),
    machine = servers(machinePath),
    platform = servers(platformPath);
  const local = servers(localPath),
    privateServers = servers(privatePath);
  const out: JsonObject = {},
    replaced: string[] = [],
    dropped: string[] = [];
  for (const [name, entry] of Object.entries(machine)) {
    if (own(local, name) || own(privateServers, name)) {
      if (own(repo, name)) out[name] = repo[name];
      dropped.push(name);
    } else if (own(platform, name)) {
      if (own(repo, name)) {
        out[name] = repo[name];
        replaced.push(name);
      } else dropped.push(name);
    } else if (own(repo, name)) out[name] = entry;
    else dropped.push(name);
  }
  const scanned = scanSecrets(out);
  refuseSecrets(scanned.found);
  const lines: string[] = [];
  if (scanned.removed.length) lines.push(`  credential-shaped keys left out: ${[...scanned.removed].sort().join(', ')}`);
  const changed = dumpSemantic(outPath, { mcpServers: scanned.cleaned });
  lines.push(`mcp: ${changed ? 'exported' : 'unchanged'} (${Object.keys(scanned.cleaned).length} servers)`);
  if (dropped.length) lines.push(`  left out (unmanaged/local/platform/private): ${[...dropped].sort().join(', ')}`);
  if (replaced.length) lines.push(`  repo entry kept instead of machine override: ${[...replaced].sort().join(', ')}`);
  return lines;
}

export function composeAgents(commonPath: string, addendumPath: string, outPath: string): void {
  const common = readText(commonPath),
    addendum = readText(addendumPath);
  if (common === null) throw new Error(`missing shared instructions: ${commonPath}`);
  for (const [path, text] of [
    [commonPath, common],
    [addendumPath, addendum],
  ]) {
    if (text && text.includes(AGENTS_BOUNDARY)) throw new Error(`reserved shared/host boundary in ${path}`);
  }
  writeText(outPath, composeInstructions(common, addendum));
}

export function extractAgents(machinePath: string, commonPath: string, outPath: string): string {
  const machine = readText(machinePath),
    common = readText(commonPath);
  if (machine === null) throw new Error(`missing deployed instructions: ${machinePath}`);
  if (common === null) throw new Error(`missing shared instructions: ${commonPath}`);
  const prefix = normalizeInstructions(common).trim();
  const body = normalizeInstructions(machine).trim();
  const lines = body.split('\n');
  const boundaries = lines.flatMap((line, index) => (line.trim() === AGENTS_BOUNDARY ? [index] : []));
  if (!boundaries.length) {
    throw new Error(
      `${machinePath} has no ${AGENTS_BOUNDARY} boundary; push only exports the host-specific ` +
        'section of a file composed from the current shared layer. Run sync before exporting.',
    );
  }
  if (boundaries.length > 1) throw new Error(`${machinePath} contains more than one ${AGENTS_BOUNDARY} boundary; refusing to export.`);
  const split = boundaries[0];
  if (lines.slice(0, split).join('\n').trim() !== prefix) {
    throw new Error(
      `${machinePath} shared rules differ from ${commonPath} (the deployed file may predate ` +
        'the current shared layer); run sync before exporting.',
    );
  }
  const addendum = lines
    .slice(split + 1)
    .join('\n')
    .trim();
  if (!addendum) throw new Error(`${machinePath} has no host-specific section; refusing to export an empty addendum.`);
  if (composeInstructions(common, addendum) !== `${body}\n`) {
    throw new Error(
      `${machinePath} is not a canonical shared-layer composition; run sync before exporting. ` +
        'Shared rules must be edited in the source, not in the deployed file.',
    );
  }
  const changed = writeText(outPath, `${addendum}\n`);
  return `AGENTS.md: ${changed ? 'exported' : 'unchanged'} (host addendum only)`;
}
