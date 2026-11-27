import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadDshYaml } from '../integration/scoped-dsh/native.ts';
import {
  bearerCredentialReference,
  bearerCredentialTemplate,
  credentialReference,
  credentialTemplate,
  literalSecretsIn,
  literalValueReason,
  transportCredentialProblem,
  unresolvedPlaceholdersIn,
} from './mcp-credentials.ts';
import { list, record, release } from './ownership.ts';
import { platformOverlay } from './platform.ts';
import type { State } from '../types/kitto.d.ts';

export { loadDshYaml };

type Json = Record<string, any>;

export interface DshRow {
  id: string;
  name: string;
  config: Json;
}

export interface DshServer {
  name: string;
  transport: 'stdio' | 'streamable-http';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  expandTemplates?: boolean;
}

export interface McpRemoval {
  changed?: boolean;
  path?: string;
  removed?: unknown[];
  [key: string]: unknown;
}

export interface McpSyncOptions {
  dryRun?: boolean;
  yaml?: any;
  log?: (...data: unknown[]) => void;
  warn?: (...data: unknown[]) => void;
  includePrivate?: boolean;
}

interface DshPatchPlan {
  changed: boolean;
  text: string;
  conflicts: Array<{ row: DshRow; location: string }>;
  removed: DshRow[];
  preserved: DshRow[];
  desired: DshRow[];
}

const pluginName = '@deepseek-ai/dsh-mcp-client';
const managerName = '@deepseek-ai/dsh-mcp-manager';
const managerId = 'mcp-manager';
const rowPrefix = 'kitto-mcp-';
const serverNamePattern = /^[A-Za-z0-9_-]{1,32}$/;
const optOut = 'KITTO_NO_MCP_SYNC';
const yamlOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: unknown) => value }] };

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${(value as unknown[]).map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export const rowFingerprint = (row: unknown): string => createHash('sha256').update(canonical(row)).digest('hex');

const recordedRows = (state: State): Record<string, string> =>
  Object.fromEntries(list(state, 'mcp', 'dsh', 'owned').map((entry): [string, string] => [entry.name, entry.hash]));

function settleRows(state: State, keep: string[], rows: DshRow[] = []) {
  for (const row of rows) record(state, 'mcp', 'dsh', row.id, rowFingerprint(row));
  const kept = new Set([...keep, ...rows.map((row) => row.id)]);
  for (const { name } of list(state, 'mcp', 'dsh')) if (!kept.has(name)) release(state, 'mcp', 'dsh', name);
}

function warnPreserved(plan: DshPatchPlan, warn: (...data: unknown[]) => void) {
  for (const row of plan.preserved) warn(`mcp dsh: preserved ${row.id} (live row differs from the recorded ownership fingerprint)`);
}

const isKittoRow = (row: unknown): row is DshRow => isObject(row) && typeof row.id === 'string' && row.id.startsWith(rowPrefix);

async function readJson(path: string): Promise<any> {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
}

async function readPatch(path: string): Promise<{ content: string | null; mode: number }> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`DSH home patch is not a regular file: ${path}`);
    return { content: await readFile(path, 'utf8'), mode: info.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { content: null, mode: 0o600 };
  }
}

function merge(base: unknown, over: unknown): any {
  if (!isObject(base) || !isObject(over)) return over;
  const result: Json = { ...base };
  for (const [key, value] of Object.entries(over)) result[key] = key in result ? merge(result[key], value) : value;
  return result;
}

function mcpServers(value: unknown, path: string): Json {
  if (value === null) return {};
  if (!isObject(value) || (value.mcpServers !== undefined && !isObject(value.mcpServers))) {
    throw new Error(`${path} must contain an mcpServers object.`);
  }
  return value.mcpServers ?? {};
}

function scanLiteralCredentials(entry: unknown): string | null {
  const [secret] = literalSecretsIn(entry);
  if (secret) return `contains a literal secret (${secret.label}) at ${secret.path}`;
  const [placeholder] = unresolvedPlaceholdersIn(entry);
  if (placeholder) return `still contains an unresolved YOUR_* placeholder at ${placeholder.path}`;
  return null;
}

function dshEnv(env: unknown): { skip?: string; value?: Record<string, string> } {
  if (!isObject(env)) return { skip: 'env is not an object of strings' };
  const mapped: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') return { skip: `env.${name} is not a string` };
    const reference = credentialReference(value);
    if (reference === null) return { skip: literalValueReason(`env.${name}`, value) };
    mapped[name] = credentialTemplate(reference);
  }
  return Object.keys(mapped).length ? { value: mapped } : {};
}

function dshHeaders(headers: unknown): { skip?: string; value?: Record<string, string> } {
  if (!isObject(headers)) return { skip: 'headers is not an object of strings' };
  const mapped: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') return { skip: `headers.${name} is not a string` };
    const authorization = name.toLowerCase() === 'authorization';
    const bearer = authorization ? bearerCredentialReference(value) : null;
    const reference = bearer ?? credentialReference(value);
    if (reference === null) {
      return { skip: literalValueReason(`headers.${name}`, value, { authorization }) };
    }
    mapped[name] = bearer ? bearerCredentialTemplate(reference) : credentialTemplate(reference);
  }
  return Object.keys(mapped).length ? { value: mapped } : {};
}

export async function piMcpServers(
  source: string,
  platform: string = process.platform,
  { includePrivate = false }: { includePrivate?: boolean } = {},
): Promise<{ servers: DshServer[]; skipped: Array<{ name: string; reason: string }> }> {
  const sources = [join(source, 'config/pi/mcp.json')];
  const overlayName = platformOverlay(platform);
  if (overlayName) sources.push(join(source, 'config/pi/platform', overlayName, 'mcp.json'));
  if (includePrivate) {
    sources.push(join(source, 'config/pi/local/mcp.json'));
    sources.push(join(source, 'config/pi/mcp.private.json'));
  }
  const merged: Json = {};
  for (const path of sources) {
    const declared = mcpServers(await readJson(path), path);
    for (const [name, entry] of Object.entries(declared)) merged[name] = merge(merged[name], entry);
  }

  const servers: DshServer[] = [],
    skipped: Array<{ name: string; reason: string }> = [];
  for (const [name, entry] of Object.entries(merged)) {
    if (name.startsWith('_') || !isObject(entry) || entry.enabled === false) continue;
    const skip = (reason: string) => skipped.push({ name, reason });
    if (!serverNamePattern.test(name)) {
      skip('not a valid DSH server name');
      continue;
    }
    const literal = scanLiteralCredentials(entry);
    if (literal) {
      skip(literal);
      continue;
    }
    const transportProblem = transportCredentialProblem(entry);
    if (transportProblem) {
      skip(`${transportProblem}; only env/headers references are synced`);
      continue;
    }
    const env = entry.env === undefined ? undefined : dshEnv(entry.env);
    const headers = entry.headers === undefined ? undefined : dshHeaders(entry.headers);
    if (entry.url !== undefined) {
      if (typeof entry.url !== 'string' || !entry.url) {
        skip('url is not a string');
        continue;
      }
      if (entry.type !== undefined && !['http', 'streamable-http'].includes(entry.type)) {
        skip(`Pi transport ${entry.type} is not supported by DSH`);
        continue;
      }
      if (entry.url.includes('${')) {
        skip('url contains a credential template; only env/headers references are synced');
        continue;
      }
      if (env) {
        skip('env is only synced for stdio servers');
        continue;
      }
      if (headers?.skip) {
        skip(headers.skip);
        continue;
      }
      const server: DshServer = { name, transport: 'streamable-http', url: entry.url };
      if (headers?.value) {
        server.headers = headers.value;
        server.expandTemplates = true;
      }
      servers.push(server);
    } else if (entry.command !== undefined) {
      if (typeof entry.command !== 'string' || !entry.command) {
        skip('command is not a string');
        continue;
      }
      if (entry.type !== undefined && entry.type !== 'stdio') {
        skip(`Pi transport ${entry.type} is not supported by DSH`);
        continue;
      }
      const args = entry.args ?? [];
      if (!Array.isArray(args) || args.some((arg: unknown) => typeof arg !== 'string')) {
        skip('args is not a string array');
        continue;
      }
      if (entry.command.includes('${') || args.some((arg: string) => arg.includes('${'))) {
        skip('command or args contain a credential template; only env/headers references are synced');
        continue;
      }
      if (headers) {
        skip('headers are only synced for HTTP servers');
        continue;
      }
      if (env?.skip) {
        skip(env.skip);
        continue;
      }
      const server: DshServer = { name, transport: 'stdio', command: entry.command, args };
      if (env?.value) {
        server.env = env.value;
        server.expandTemplates = true;
      }
      servers.push(server);
    } else {
      skip('no command or url');
    }
  }
  return { servers, skipped };
}

export function dshMcpRows(servers: DshServer[]): DshRow[] {
  return servers.map((server) => ({
    id: rowPrefix + server.name,
    name: pluginName,
    config:
      server.transport === 'stdio'
        ? {
            serverName: server.name,
            transport: 'stdio',
            command: server.command,
            args: server.args,
            ...(server.env ? { env: server.env } : {}),
            ...(server.expandTemplates ? { expandTemplates: true } : {}),
          }
        : {
            serverName: server.name,
            transport: 'streamable-http',
            url: server.url,
            ...(server.headers ? { headers: server.headers } : {}),
            ...(server.expandTemplates ? { expandTemplates: true } : {}),
          },
  }));
}

function parsePatch(text: string, yaml: any, label: string): { document: any; value: any } {
  const document = yaml.parseDocument(text, yamlOptions);
  if (document.errors.length) throw new Error(`${label} is not valid YAML: ${document.errors[0].message}`);
  const empty = yaml.isScalar(document.contents) && document.contents.value === null;
  if (document.contents !== null && !empty && !yaml.isSeq(document.contents)) {
    throw new Error(`${label} must be a top-level YAML sequence.`);
  }
  let value: any;
  try {
    value = document.toJS();
  } catch (error) {
    throw new Error(`${label} cannot be read: ${(error as Error).message}`);
  }
  return { document, value };
}

function remember(declared: Map<string, string>, name: unknown, location: string) {
  if (typeof name === 'string' && !declared.has(name)) declared.set(name, location);
}

function collectDeclared(value: unknown, declared: Map<string, string>, location: string): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectDeclared(entry, declared, location);
    return;
  }
  if (!isObject(value)) return;
  if ((value.name === managerName || value.id === managerId) && isObject(value.config?.servers)) {
    for (const [name, entry] of Object.entries(value.config.servers)) {
      if (!isObject(entry) || entry.enabled !== false) remember(declared, name, `${location} (mcp-manager)`);
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'serverName' && typeof entry === 'string') remember(declared, entry, location);
    else collectDeclared(entry, declared, location);
  }
}

async function profileDeclaredServers(state: State, yaml: any): Promise<Map<string, string>> {
  const declared = new Map<string, string>();
  const directory = join(state.dshHome, 'profiles');
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return declared;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, 'cordis.patch.yml');
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!content.trim()) continue;
    const { value } = parsePatch(content, yaml, `DSH profile patch ${path}`);
    collectDeclared(value, declared, path);
  }
  return declared;
}

function lineRange(text: string, node: any): [number, number] {
  let start = text.lastIndexOf('\n', node.range[0] - 1) + 1;
  if (!/^\s*-/.test(text.slice(start, node.range[0]))) {
    const previous = text.lastIndexOf('\n', start - 2) + 1;
    if (/^\s*-(?:\s|$)/.test(text.slice(previous, start).replace(/\r?\n$/, ''))) start = previous;
  }
  let end = node.range[1];
  if (text[end - 1] !== '\n') {
    const next = text.indexOf('\n', end);
    end = next === -1 ? text.length : next + 1;
  }
  return [start, end];
}

function sameRows(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length) return false;
  const canon = (list: unknown[]) => list.map((row) => JSON.stringify(row)).sort();
  const a = canon(left),
    b = canon(right);
  return a.every((value, index) => value === b[index]);
}

function splitDocumentEnd(text: string): { body: string; end: string } {
  const lines: Array<{ start: number; text: string }> = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    lines.push({ start: offset, text: line });
    offset += line.length + 1;
  }
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].text.replace(/\r$/, '');
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (!/^\.\.\.(?:[ \t]+#[^\n]*)?[ \t]*$/.test(line)) return { body: text, end: '' };
    return { body: text.slice(0, lines[index].start), end: text.slice(lines[index].start) };
  }
  return { body: text, end: '' };
}

function validatePatch(text: string, yaml: any) {
  const document = yaml.parseDocument(text, yamlOptions);
  if (document.errors.length) {
    throw new Error(`Refusing to write the DSH home patch: ${document.errors[0].message}`);
  }
  let value: unknown;
  try {
    value = document.toJS();
  } catch (error) {
    throw new Error(`Refusing to write the DSH home patch: ${(error as Error).message}`);
  }
  if (!Array.isArray(value)) throw new Error('Refusing to write the DSH home patch: it would not be a top-level YAML sequence.');
}

async function writePatch(path: string, text: string, before: string | null, mode: number) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx', mode });
    if ((await readPatch(path)).content !== before) throw new Error(`DSH home patch changed during the update: ${path}`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function planDshMcp({
  content,
  rows,
  yaml,
  declared = new Map(),
  location = 'DSH home patch',
  recorded = {},
}: {
  content: string | null;
  rows: DshRow[];
  yaml: any;
  declared?: Map<string, string>;
  location?: string;
  recorded?: Record<string, string>;
}): DshPatchPlan {
  if (!yaml) throw new Error('DSH MCP sync needs the YAML module bundled with DSH.');
  const text = content ?? '';
  let base = text;
  const items: Array<{ value: any; range: [number, number] }> = [];
  const found = new Map(declared);
  if (text.trim()) {
    const parsed = parsePatch(text, yaml, 'DSH home patch');
    const sequence = parsed.document.contents;
    const emptyScalar = yaml.isScalar(sequence) && sequence.value === null;
    if (sequence?.flow) {
      if (sequence.items.length)
        throw new Error('DSH home patch uses flow-style YAML; convert it to block style before syncing MCP servers.');
      base = text.slice(0, sequence.range[0]) + text.slice(sequence.range[1]);
    } else if (emptyScalar) {
      base = text.slice(0, sequence.range[0]) + text.slice(sequence.range[1]);
    } else if (Array.isArray(parsed.value)) {
      for (const [index, item] of sequence.items.entries()) items.push({ value: parsed.value[index], range: lineRange(text, item) });
    }
  }

  const removable: typeof items = [];
  const preserved: DshRow[] = [];
  for (const item of items) {
    const value = item.value;
    const insert = isObject(value) && Array.isArray(value.insert) ? value.insert : [];
    const kitto: DshRow[] = insert.filter(isKittoRow);
    if (kitto.length) {
      if (!isObject(value) || Object.keys(value).length !== 1 || kitto.length !== insert.length) {
        throw new Error('DSH home patch mixes kitto-mcp-* rows with other entries; keep them in their own insert item.');
      }
      if (kitto.some((row: DshRow) => Object.hasOwn(recorded, row.id) && recorded[row.id] !== rowFingerprint(row))) {
        preserved.push(...kitto);
      } else removable.push(item);
      continue;
    }
    collectDeclared(value, found, location);
  }

  const removed: DshRow[] = removable.flatMap((item) => item.value.insert);
  const conflicts: DshPatchPlan['conflicts'] = [];
  const preservedIds = new Set(preserved.map((row) => row.id));
  const desired = rows.filter((row: DshRow) => {
    if (preservedIds.has(row.id)) return false;
    const where = found.get(row.config.serverName);
    if (where === undefined) return true;
    conflicts.push({ row, location: where });
    return false;
  });
  if (sameRows(removed, desired)) return { changed: false, text, conflicts, removed, preserved, desired };

  for (const { range } of removable.sort((left, right) => right.range[0] - left.range[0])) {
    base = base.slice(0, range[0]) + base.slice(range[1]);
  }
  const { body, end } = splitDocumentEnd(base);
  const trimmed = body.replace(/[ \t\r\n]+$/, '');
  let core: string;
  if (desired.length) {
    const blocks = yaml.stringify(
      desired.map((row) => ({ insert: [row] })),
      { lineWidth: 0, singleQuote: true },
    );
    core = trimmed ? `${trimmed}\n\n${blocks}` : blocks;
  } else if (!trimmed) {
    core = '[]\n';
  } else {
    core = parsePatch(trimmed, yaml, 'DSH home patch').value === null ? `${trimmed}\n[]\n` : `${trimmed}\n`;
  }
  if (!core.endsWith('\n')) core += '\n';
  const next = core + end;
  if (next === text) return { changed: false, text, conflicts, removed, preserved, desired };
  validatePatch(next, yaml);
  return { changed: true, text: next, conflicts, removed, preserved, desired };
}

export async function syncDshMcp(
  state: State,
  { dryRun = false, yaml, log = console.log, warn = console.warn, includePrivate = state.includePrivate === true }: McpSyncOptions = {},
): Promise<McpRemoval> {
  if (process.env[optOut] === '1') {
    log(`mcp dsh: skipped (${optOut}=1)`);
    return { changed: false, disabled: true };
  }
  if (!state.source) throw new Error('DSH MCP sync requires a configuration source.');
  if (!state.dshHome) throw new Error('DSH MCP sync requires the DSH home directory.');
  const path = join(state.dshHome, 'cordis.patch.yml');
  const { servers, skipped } = await piMcpServers(state.source, process.platform, { includePrivate });
  for (const item of skipped) warn(`mcp dsh: skipped ${item.name} (${item.reason})`);
  const rows = dshMcpRows(servers);
  const { content, mode } = await readPatch(path);
  if (!rows.length && content === null) {
    if (!dryRun) settleRows(state, []);
    return { changed: false, path, skipped, conflicts: [] };
  }

  let module = yaml;
  if (!module) {
    try {
      module = await loadDshYaml();
    } catch (error) {
      warn(`mcp dsh: skipped (cannot load the yaml module bundled with DSH: ${(error as Error).message})`);
      return { changed: false, path, skipped, conflicts: [], unavailable: true };
    }
  }
  const declared = rows.length ? await profileDeclaredServers(state, module) : new Map();
  const plan = planDshMcp({ content, rows, yaml: module, declared, location: path, recorded: recordedRows(state) });
  warnPreserved(plan, warn);
  for (const conflict of plan.conflicts) {
    warn(`mcp dsh: skipped ${conflict.row.config.serverName} (already declared in ${conflict.location})`);
  }
  const settle = () => {
    if (!dryRun)
      settleRows(
        state,
        plan.preserved.map((row) => row.id),
        plan.desired,
      );
  };
  if (!plan.changed) {
    settle();
    log(`mcp dsh: up to date (${path})`);
    return { changed: false, path, skipped, conflicts: plan.conflicts };
  }
  const synced = rows.length - plan.conflicts.length;
  const summary = `${synced} server${synced === 1 ? '' : 's'}`;
  if (dryRun) {
    log(`mcp dsh: would update ${path} (${summary})`);
    return { changed: true, path, skipped, conflicts: plan.conflicts };
  }
  await writePatch(path, plan.text, content, mode);
  settle();
  log(`mcp dsh: updated ${path} (${summary}); restart DSH to load them.`);
  return { changed: true, path, skipped, conflicts: plan.conflicts };
}

export async function removeDshMcp(
  state: State,
  { dryRun = false, yaml, log = console.log, warn = console.warn }: Omit<McpSyncOptions, 'includePrivate'> = {},
): Promise<McpRemoval> {
  if (!state.dshHome) throw new Error('DSH MCP removal requires the DSH home directory.');
  const path = join(state.dshHome, 'cordis.patch.yml');
  const { content, mode } = await readPatch(path);
  if (content === null) {
    if (!dryRun) settleRows(state, []);
    return { changed: false, path, removed: [] };
  }

  let module = yaml;
  if (!module) {
    try {
      module = await loadDshYaml();
    } catch (error) {
      warn(`mcp dsh: skipped (cannot load the yaml module bundled with DSH: ${(error as Error).message})`);
      return { changed: false, path, removed: [], unavailable: true };
    }
  }
  let plan: DshPatchPlan;
  try {
    plan = planDshMcp({ content, rows: [], yaml: module, location: path, recorded: recordedRows(state) });
  } catch (error) {
    warn(`mcp dsh: skipped removal (${(error as Error).message})`);
    return { changed: false, path, removed: [], skipped: (error as Error).message };
  }
  warnPreserved(plan, warn);
  const settle = () => {
    if (!dryRun)
      settleRows(
        state,
        plan.preserved.map((row) => row.id),
      );
  };
  if (!plan.changed) {
    settle();
    return { changed: false, path, removed: [] };
  }
  const names = plan.removed.map((row) => row.config?.serverName ?? row.id);
  const summary = `${names.length} Kitto MCP server${names.length === 1 ? '' : 's'}`;
  if (dryRun) {
    log(`mcp dsh: would remove ${summary} from ${path}`);
    return { changed: true, path, removed: names };
  }
  await writePatch(path, plan.text, content, mode);
  settle();
  log(`mcp dsh: removed ${summary} from ${path}`);
  return { changed: true, path, removed: names };
}
