import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadDshYaml } from '../integration/scoped-dsh/native.mjs';
import {
  bearerCredentialReference, bearerCredentialTemplate, credentialReference, credentialTemplate,
  literalSecretsIn, literalValueReason, transportCredentialProblem, unresolvedPlaceholdersIn,
} from './mcp-credentials.mjs';
import { list, record, release } from './ownership.mjs';

export { loadDshYaml };

const pluginName = '@deepseek-ai/dsh-mcp-client';
const managerName = '@deepseek-ai/dsh-mcp-manager';
const managerId = 'mcp-manager';
const rowPrefix = 'kitto-mcp-';
const serverNamePattern = /^[A-Za-z0-9_-]{1,32}$/;
const optOut = 'KITTO_NO_MCP_SYNC';
const yamlOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export const rowFingerprint = row => createHash('sha256').update(canonical(row)).digest('hex');

const recordedRows = state => Object.fromEntries(list(state, 'mcp', 'dsh', 'owned').map(entry => [entry.name, entry.hash]));

function settleRows(state, keep, rows = []) {
  for (const row of rows) record(state, 'mcp', 'dsh', row.id, rowFingerprint(row));
  const kept = new Set([...keep, ...rows.map(row => row.id)]);
  for (const { name } of list(state, 'mcp', 'dsh')) if (!kept.has(name)) release(state, 'mcp', 'dsh', name);
}

function warnPreserved(plan, warn) {
  for (const row of plan.preserved) warn(`mcp dsh: preserved ${row.id} (live row differs from the recorded ownership fingerprint)`);
}

const isKittoRow = row => isObject(row) && typeof row.id === 'string' && row.id.startsWith(rowPrefix);

export function platformOverlay(platform = process.platform) {
  if (platform === 'darwin' || platform === 'macos') return 'macos';
  if (platform === 'linux') return 'linux';
  return null;
}

async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error.message}`);
  }
}

async function readPatch(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`DSH home patch is not a regular file: ${path}`);
    return { content: await readFile(path, 'utf8'), mode: info.mode & 0o777 };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { content: null, mode: 0o600 };
  }
}

function merge(base, over) {
  if (!isObject(base) || !isObject(over)) return over;
  const result = { ...base };
  for (const [key, value] of Object.entries(over)) result[key] = key in result ? merge(result[key], value) : value;
  return result;
}

function mcpServers(value, path) {
  if (value === null) return {};
  if (!isObject(value) || (value.mcpServers !== undefined && !isObject(value.mcpServers))) {
    throw new Error(`${path} must contain an mcpServers object.`);
  }
  return value.mcpServers ?? {};
}

function scanLiteralCredentials(entry) {
  const [secret] = literalSecretsIn(entry);
  if (secret) return `contains a literal secret (${secret.label}) at ${secret.path}`;
  const [placeholder] = unresolvedPlaceholdersIn(entry);
  if (placeholder) return `still contains an unresolved YOUR_* placeholder at ${placeholder.path}`;
  return null;
}

function dshEnv(env) {
  if (!isObject(env)) return { skip: 'env is not an object of strings' };
  const mapped = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') return { skip: `env.${name} is not a string` };
    const reference = credentialReference(value);
    if (reference === null) return { skip: literalValueReason(`env.${name}`, value) };
    mapped[name] = credentialTemplate(reference);
  }
  return Object.keys(mapped).length ? { value: mapped } : {};
}

function dshHeaders(headers) {
  if (!isObject(headers)) return { skip: 'headers is not an object of strings' };
  const mapped = {};
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

export async function piMcpServers(source, platform = process.platform, { includePrivate = false } = {}) {
  const sources = [join(source, 'config/pi/mcp.json')];
  const overlayName = platformOverlay(platform);
  if (overlayName) sources.push(join(source, 'config/pi/platform', overlayName, 'mcp.json'));
  if (includePrivate) {
    sources.push(join(source, 'config/pi/local/mcp.json'));
    sources.push(join(source, 'config/pi/mcp.private.json'));
  }
  const merged = {};
  for (const path of sources) {
    const declared = mcpServers(await readJson(path), path);
    for (const [name, entry] of Object.entries(declared)) merged[name] = merge(merged[name], entry);
  }

  const servers = [], skipped = [];
  for (const [name, entry] of Object.entries(merged)) {
    if (name.startsWith('_') || !isObject(entry) || entry.enabled === false) continue;
    const skip = reason => skipped.push({ name, reason });
    if (!serverNamePattern.test(name)) { skip('not a valid DSH server name'); continue; }
    const literal = scanLiteralCredentials(entry);
    if (literal) { skip(literal); continue; }
    const transportProblem = transportCredentialProblem(entry);
    if (transportProblem) { skip(`${transportProblem}; only env/headers references are synced`); continue; }
    const env = entry.env === undefined ? undefined : dshEnv(entry.env);
    const headers = entry.headers === undefined ? undefined : dshHeaders(entry.headers);
    if (entry.url !== undefined) {
      if (typeof entry.url !== 'string' || !entry.url) { skip('url is not a string'); continue; }
      if (entry.type !== undefined && !['http', 'streamable-http'].includes(entry.type)) { skip(`Pi transport ${entry.type} is not supported by DSH`); continue; }
      if (entry.url.includes('${')) { skip('url contains a credential template; only env/headers references are synced'); continue; }
      if (env) { skip('env is only synced for stdio servers'); continue; }
      if (headers?.skip) { skip(headers.skip); continue; }
      const server = { name, transport: 'streamable-http', url: entry.url };
      if (headers?.value) { server.headers = headers.value; server.expandTemplates = true; }
      servers.push(server);
    } else if (entry.command !== undefined) {
      if (typeof entry.command !== 'string' || !entry.command) { skip('command is not a string'); continue; }
      if (entry.type !== undefined && entry.type !== 'stdio') { skip(`Pi transport ${entry.type} is not supported by DSH`); continue; }
      const args = entry.args ?? [];
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) { skip('args is not a string array'); continue; }
      if (entry.command.includes('${') || args.some(arg => arg.includes('${'))) {
        skip('command or args contain a credential template; only env/headers references are synced');
        continue;
      }
      if (headers) { skip('headers are only synced for HTTP servers'); continue; }
      if (env?.skip) { skip(env.skip); continue; }
      const server = { name, transport: 'stdio', command: entry.command, args };
      if (env?.value) { server.env = env.value; server.expandTemplates = true; }
      servers.push(server);
    } else {
      skip('no command or url');
    }
  }
  return { servers, skipped };
}

export function dshMcpRows(servers) {
  return servers.map(server => ({
    id: rowPrefix + server.name,
    name: pluginName,
    config: server.transport === 'stdio'
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

function parsePatch(text, yaml, label) {
  const document = yaml.parseDocument(text, yamlOptions);
  if (document.errors.length) throw new Error(`${label} is not valid YAML: ${document.errors[0].message}`);
  const empty = yaml.isScalar(document.contents) && document.contents.value === null;
  if (document.contents !== null && !empty && !yaml.isSeq(document.contents)) {
    throw new Error(`${label} must be a top-level YAML sequence.`);
  }
  let value;
  try {
    value = document.toJS();
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error.message}`);
  }
  return { document, value };
}

function remember(declared, name, location) {
  if (typeof name === 'string' && !declared.has(name)) declared.set(name, location);
}

function collectDeclared(value, declared, location) {
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

async function profileDeclaredServers(state, yaml) {
  const declared = new Map();
  const directory = join(state.dshHome, 'profiles');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return declared;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, 'cordis.patch.yml');
    let content;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!content.trim()) continue;
    const { value } = parsePatch(content, yaml, `DSH profile patch ${path}`);
    collectDeclared(value, declared, path);
  }
  return declared;
}

function lineRange(text, node) {
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

function sameRows(left, right) {
  if (left.length !== right.length) return false;
  const canon = list => list.map(row => JSON.stringify(row)).sort();
  const a = canon(left), b = canon(right);
  return a.every((value, index) => value === b[index]);
}

function splitDocumentEnd(text) {
  const lines = [];
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

function validatePatch(text, yaml) {
  const document = yaml.parseDocument(text, yamlOptions);
  if (document.errors.length) {
    throw new Error(`Refusing to write the DSH home patch: ${document.errors[0].message}`);
  }
  let value;
  try {
    value = document.toJS();
  } catch (error) {
    throw new Error(`Refusing to write the DSH home patch: ${error.message}`);
  }
  if (!Array.isArray(value)) throw new Error('Refusing to write the DSH home patch: it would not be a top-level YAML sequence.');
}

async function writePatch(path, text, before, mode) {
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

export function planDshMcp({ content, rows, yaml, declared = new Map(), location = 'DSH home patch', recorded = {} }) {
  if (!yaml) throw new Error('DSH MCP sync needs the YAML module bundled with DSH.');
  const text = content ?? '';
  let base = text;
  const items = [];
  const found = new Map(declared);
  if (text.trim()) {
    const parsed = parsePatch(text, yaml, 'DSH home patch');
    const sequence = parsed.document.contents;
    const emptyScalar = yaml.isScalar(sequence) && sequence.value === null;
    if (sequence?.flow) {
      if (sequence.items.length) throw new Error('DSH home patch uses flow-style YAML; convert it to block style before syncing MCP servers.');
      base = text.slice(0, sequence.range[0]) + text.slice(sequence.range[1]);
    } else if (emptyScalar) {
      base = text.slice(0, sequence.range[0]) + text.slice(sequence.range[1]);
    } else if (Array.isArray(parsed.value)) {
      for (const [index, item] of sequence.items.entries()) items.push({ value: parsed.value[index], range: lineRange(text, item) });
    }
  }

  const removable = [];
  const preserved = [];
  for (const item of items) {
    const value = item.value;
    const insert = isObject(value) && Array.isArray(value.insert) ? value.insert : [];
    const kitto = insert.filter(isKittoRow);
    if (kitto.length) {
      if (!isObject(value) || Object.keys(value).length !== 1 || kitto.length !== insert.length) {
        throw new Error('DSH home patch mixes kitto-mcp-* rows with other entries; keep them in their own insert item.');
      }
      if (kitto.some(row => Object.hasOwn(recorded, row.id) && recorded[row.id] !== rowFingerprint(row))) {
        preserved.push(...kitto);
      } else removable.push(item);
      continue;
    }
    collectDeclared(value, found, location);
  }

  const removed = removable.flatMap(item => item.value.insert);
  const conflicts = [];
  const preservedIds = new Set(preserved.map(row => row.id));
  const desired = rows.filter(row => {
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
  let core;
  if (desired.length) {
    const blocks = yaml.stringify(desired.map(row => ({ insert: [row] })), { lineWidth: 0, singleQuote: true });
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

export async function syncDshMcp(state, {
  dryRun = false, yaml, log = console.log, warn = console.warn,
  includePrivate = state.includePrivate === true,
} = {}) {
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
      warn(`mcp dsh: skipped (cannot load the yaml module bundled with DSH: ${error.message})`);
      return { changed: false, path, skipped, conflicts: [], unavailable: true };
    }
  }
  const declared = rows.length ? await profileDeclaredServers(state, module) : new Map();
  const plan = planDshMcp({ content, rows, yaml: module, declared, location: path, recorded: recordedRows(state) });
  warnPreserved(plan, warn);
  for (const conflict of plan.conflicts) {
    warn(`mcp dsh: skipped ${conflict.row.config.serverName} (already declared in ${conflict.location})`);
  }
  const settle = () => { if (!dryRun) settleRows(state, plan.preserved.map(row => row.id), plan.desired); };
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

export async function removeDshMcp(state, { dryRun = false, yaml, log = console.log, warn = console.warn } = {}) {
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
      warn(`mcp dsh: skipped (cannot load the yaml module bundled with DSH: ${error.message})`);
      return { changed: false, path, removed: [], unavailable: true };
    }
  }
  let plan;
  try {
    plan = planDshMcp({ content, rows: [], yaml: module, location: path, recorded: recordedRows(state) });
  } catch (error) {
    warn(`mcp dsh: skipped removal (${error.message})`);
    return { changed: false, path, removed: [], skipped: error.message };
  }
  warnPreserved(plan, warn);
  const settle = () => { if (!dryRun) settleRows(state, plan.preserved.map(row => row.id)); };
  if (!plan.changed) {
    settle();
    return { changed: false, path, removed: [] };
  }
  const names = plan.removed.map(row => row.config?.serverName ?? row.id);
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
