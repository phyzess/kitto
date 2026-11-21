import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { importFromDsh } from '../integration/scoped-dsh/native.mjs';
import { dshExecutable } from './scope-dsh.mjs';

const pluginName = '@deepseek-ai/dsh-mcp-client';
const rowPrefix = 'kitto-mcp-';
const serverNamePattern = /^[A-Za-z0-9_-]{1,32}$/;
const optOut = 'KITTO_NO_MCP_SYNC';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isKittoRow = row => isObject(row) && typeof row.id === 'string' && row.id.startsWith(rowPrefix);

/** Pi stores its platform differences as macOS/Linux overlays. */
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

/**
 * Read the portable Pi MCP declarations: the repository base plus the current
 * platform overlay. Private and machine-local Pi files are deliberately not
 * consulted; servers with `env`/`headers` are reported and left alone.
 */
export async function piMcpServers(source, platform = process.platform) {
  const basePath = join(source, 'config/pi/mcp.json');
  const base = mcpServers(await readJson(basePath), basePath);
  const overlayName = platformOverlay(platform);
  const overlayPath = overlayName && join(source, 'config/pi/platform', overlayName, 'mcp.json');
  const overlay = overlayName ? mcpServers(await readJson(overlayPath), overlayPath) : {};
  const merged = {};
  for (const [name, entry] of Object.entries(base)) merged[name] = entry;
  for (const [name, entry] of Object.entries(overlay)) merged[name] = merge(merged[name], entry);

  const servers = [], skipped = [];
  for (const [name, entry] of Object.entries(merged)) {
    if (name.startsWith('_') || !isObject(entry) || entry.enabled === false) continue;
    const skip = reason => skipped.push({ name, reason });
    if (!serverNamePattern.test(name)) { skip('not a valid DSH server name'); continue; }
    const unsynced = ['env', 'headers'].filter(key => entry[key] !== undefined);
    if (unsynced.length) { skip(`${unsynced.join('/')} is not synced`); continue; }
    if (entry.url !== undefined) {
      if (typeof entry.url !== 'string' || !entry.url) { skip('url is not a string'); continue; }
      if (entry.type !== undefined && !['http', 'streamable-http'].includes(entry.type)) { skip(`Pi transport ${entry.type} is not supported by DSH`); continue; }
      servers.push({ name, transport: 'streamable-http', url: entry.url });
    } else if (entry.command !== undefined) {
      if (typeof entry.command !== 'string' || !entry.command) { skip('command is not a string'); continue; }
      if (entry.type !== undefined && entry.type !== 'stdio') { skip(`Pi transport ${entry.type} is not supported by DSH`); continue; }
      const args = entry.args ?? [];
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) { skip('args is not a string array'); continue; }
      servers.push({ name, transport: 'stdio', command: entry.command, args });
    } else {
      skip('no command or url');
    }
  }
  return { servers, skipped };
}

/** The DSH mcp-client rows for the selected servers. */
export function dshMcpRows(servers) {
  return servers.map(server => ({
    id: rowPrefix + server.name,
    name: pluginName,
    config: server.transport === 'stdio'
      ? { serverName: server.name, transport: 'stdio', command: server.command, args: server.args }
      : { serverName: server.name, transport: 'streamable-http', url: server.url },
  }));
}

/** Parse and stringify with the yaml module bundled inside the DSH installation. */
export async function loadDshYaml() {
  return importFromDsh(await dshExecutable(), 'yaml');
}

/** Full lines belonging to a top-level sequence item, dash included. */
function lineRange(text, node) {
  let start = text.lastIndexOf('\n', node.range[0] - 1) + 1;
  // `- # note` on its own line pushes the mapping down; keep the dash line too.
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

function collectServerNames(value, names) {
  if (Array.isArray(value)) {
    for (const entry of value) collectServerNames(entry, names);
  } else if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'serverName' && typeof entry === 'string') names.add(entry);
      else collectServerNames(entry, names);
    }
  }
}

function sameRows(left, right) {
  if (left.length !== right.length) return false;
  const canon = list => list.map(row => JSON.stringify(row)).sort();
  const a = canon(left), b = canon(right);
  return a.every((value, index) => value === b[index]);
}

/**
 * Compute the next `cordis.patch.yml`. Only whole top-level insert items whose
 * rows all carry a `kitto-mcp-*` id are rewritten; every other byte is kept.
 */
export function planDshMcp({ content, rows, yaml }) {
  if (!yaml) throw new Error('DSH MCP sync needs the YAML module bundled with DSH.');
  const text = content ?? '';
  let base = text;
  const items = [];
  if (text.trim()) {
    const document = yaml.parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
    if (document.errors.length) throw new Error(`DSH home patch is not valid YAML: ${document.errors[0].message}`);
    const sequence = document.contents;
    if (sequence !== null) {
      if (!yaml.isSeq(sequence)) throw new Error('DSH home patch must be a top-level YAML sequence.');
      if (sequence.flow) {
        if (sequence.items.length) throw new Error('DSH home patch uses flow-style YAML; convert it to block style before syncing MCP servers.');
        base = text.slice(0, sequence.range[0]) + text.slice(sequence.range[1]);
      } else {
        for (const item of sequence.items) items.push({ value: item.toJS(document), range: lineRange(text, item) });
      }
    }
  }

  const removable = [], declared = new Set();
  for (const item of items) {
    const value = item.value;
    const insert = isObject(value) && Array.isArray(value.insert) ? value.insert : [];
    const kitto = insert.filter(isKittoRow);
    if (kitto.length) {
      if (!isObject(value) || Object.keys(value).length !== 1 || kitto.length !== insert.length) {
        throw new Error('DSH home patch mixes kitto-mcp-* rows with other entries; keep them in their own insert item.');
      }
      removable.push(item);
      continue;
    }
    collectServerNames(value, declared);
  }

  const existing = removable.flatMap(item => item.value.insert);
  const conflicts = [];
  const desired = rows.filter(row => {
    if (!declared.has(row.config.serverName)) return true;
    conflicts.push(row);
    return false;
  });
  if (sameRows(existing, desired)) return { changed: false, text, conflicts };

  for (const { range } of removable.sort((left, right) => right.range[0] - left.range[0])) {
    base = base.slice(0, range[0]) + base.slice(range[1]);
  }
  const trimmed = base.replace(/[ \t\r\n]+$/, '');
  let next;
  if (desired.length) {
    const blocks = yaml.stringify(desired.map(row => ({ insert: [row] })), { lineWidth: 0, singleQuote: true });
    next = trimmed ? `${trimmed}\n\n${blocks}` : blocks;
  } else if (!trimmed) {
    next = '[]\n';
  } else {
    next = yaml.parseDocument(trimmed).contents === null ? `${trimmed}\n[]\n` : `${trimmed}\n`;
  }
  if (!next.endsWith('\n')) next += '\n';
  return { changed: next !== text, text: next, conflicts };
}

/** Preview or apply the portable Pi MCP servers to the DSH home patch. */
export async function syncDshMcp(state, { dryRun = false, yaml, log = console.log, warn = console.warn } = {}) {
  if (process.env[optOut] === '1') {
    log(`mcp dsh: skipped (${optOut}=1)`);
    return { changed: false, disabled: true };
  }
  if (!state.source) throw new Error('DSH MCP sync requires a configuration source.');
  if (!state.dshHome) throw new Error('DSH MCP sync requires the DSH home directory.');
  const path = join(state.dshHome, 'cordis.patch.yml');
  const { servers, skipped } = await piMcpServers(state.source);
  for (const item of skipped) warn(`mcp dsh: skipped ${item.name} (${item.reason})`);
  const rows = dshMcpRows(servers);
  const { content, mode } = await readPatch(path);
  if (!rows.length && content === null) return { changed: false, path, skipped, conflicts: [] };

  let module = yaml;
  if (!module) {
    try {
      module = await loadDshYaml();
    } catch (error) {
      warn(`mcp dsh: skipped (cannot load the yaml module bundled with DSH: ${error.message})`);
      return { changed: false, path, skipped, conflicts: [], unavailable: true };
    }
  }
  const plan = planDshMcp({ content, rows, yaml: module });
  for (const row of plan.conflicts) warn(`mcp dsh: skipped ${row.config.serverName} (already declared in ${path})`);
  if (!plan.changed) {
    log(`mcp dsh: up to date (${path})`);
    return { changed: false, path, skipped, conflicts: plan.conflicts };
  }
  const summary = `${rows.length - plan.conflicts.length} server${rows.length - plan.conflicts.length === 1 ? '' : 's'}`;
  if (dryRun) {
    log(`mcp dsh: would update ${path} (${summary})`);
    return { changed: true, path, skipped, conflicts: plan.conflicts };
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, plan.text, { flag: 'wx', mode });
    if ((await readPatch(path)).content !== content) throw new Error(`DSH home patch changed during sync: ${path}`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  log(`mcp dsh: updated ${path} (${summary}); restart DSH to load them.`);
  return { changed: true, path, skipped, conflicts: plan.conflicts };
}
