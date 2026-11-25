import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadDshModule } from '../integration/scoped-dsh/native.mjs';
import { piServers } from './dependencies.mjs';
import { isDesktopProfile, validateDshProfile } from './dsh-profile.mjs';

const run = promisify(execFile);
const client = '@deepseek-ai/dsh-mcp-client';
const manager = '@deepseek-ai/dsh-mcp-manager';
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function optionalText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function codexExecutable() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const path = resolve(dir, 'codex');
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error('Codex is not available on PATH.');
}

export async function codexMcpNames(home, { codex } = {}) {
  if (!home) return [];
  let sandbox;
  try {
    const text = await optionalText(join(home, 'config.toml'));
    if (!text.trim()) return [];
    const command = codex ?? await codexExecutable();
    if (!isAbsolute(command)) throw new Error('Expected an absolute Codex executable.');
    sandbox = await mkdtemp(join(tmpdir(), 'kitto-parity-codex-'));
    await writeFile(join(sandbox, 'config.toml'), text, { mode: 0o600 });
    const { stdout } = await run(command, ['mcp', 'list', '--json'], {
      cwd: sandbox, timeout: 10000, maxBuffer: 1024 * 1024,
      env: {
        PATH: (process.env.PATH ?? '').split(delimiter).map(dir => resolve(dir)).join(delimiter),
        HOME: sandbox, CODEX_HOME: sandbox, USERPROFILE: sandbox,
        XDG_CONFIG_HOME: join(sandbox, 'config'), XDG_DATA_HOME: join(sandbox, 'data'),
        XDG_CACHE_HOME: join(sandbox, 'cache'), XDG_STATE_HOME: join(sandbox, 'state'),
        TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox, RUST_LOG: 'off',
      },
    });
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows) || rows.some(row => typeof row?.name !== 'string' || typeof row.enabled !== 'boolean')) {
      throw new Error('Unexpected Codex response.');
    }
    return [...new Set(rows.filter(row => row.enabled).map(row => row.name))].sort();
  } catch {
    throw new Error('Cannot read Codex MCP declarations using codex mcp list --json.');
  } finally {
    if (sandbox) await rm(sandbox, { recursive: true, force: true });
  }
}

const groupNames = new Set(['cordis:group', '@deepseek-ai/cordis-plugin-group']);
const includeNames = new Set(['cordis:include', '@deepseek-ai/cordis-plugin-include']);
const expression = 1n;

function parseDeclarations(yaml, text) {
  const doc = yaml.parseDocument(text, {
    intAsBigInt: false,
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: () => expression }],
  });
  if (doc.errors.length || doc.warnings.length) throw new Error('Invalid patch.');
  const value = doc.toJS();
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(patch => !isRecord(patch) || patch.id === expression ||
    patch.name === expression || patch.insert === expression)) throw new Error('Invalid patch list.');
  return value;
}

function collectNames(rows, found) {
  for (const row of rows) {
    if (!isRecord(row)) throw new Error('Invalid entry.');
    if (row.disabled === true) continue;
    if (row.name === expression || row.group === expression) throw new Error('Dynamic entry type.');
    const group = row.group === true || groupNames.has(row.name);
    const include = includeNames.has(row.name);
    if (!group && !include && row.name !== client && row.name !== manager) continue;
    if (row.disabled != null && row.disabled !== false) throw new Error('Dynamic activation.');
    if (include) throw new Error('External composition.');
    if (group) {
      if (!Array.isArray(row.config)) throw new Error('Unknown group entries.');
      collectNames(row.config, found);
    } else if (row.name === client) {
      const name = row.config?.serverName;
      if (typeof name !== 'string' || !name) throw new Error('Unknown client name.');
      found.add(name);
    } else {
      if (row.config != null && !isRecord(row.config)) throw new Error('Invalid manager config.');
      const servers = row.config?.servers;
      if (servers === undefined) continue;
      if (!isRecord(servers)) throw new Error('Invalid managed servers.');
      for (const [name, server] of Object.entries(servers)) {
        if (!isRecord(server) || (server.enabled !== undefined && typeof server.enabled !== 'boolean')) {
          throw new Error('Unknown server state.');
        }
        if (server.enabled !== false) found.add(name);
      }
    }
  }
}

export async function dshMcpNames(home, profile = 'web', { dsh } = {}) {
  if (!home) return [];
  try {
    const texts = await Promise.all([
      optionalText(join(home, 'profiles', validateDshProfile(profile), 'cordis.patch.yml')),
      optionalText(join(home, 'cordis.patch.yml')),
    ]);
    if (!texts.some(text => text.trim())) return [];
    const [yaml, { composeEntries }] = await Promise.all([
      loadDshModule('yaml', dsh), loadDshModule('@deepseek-ai/dsh-app-boot', dsh),
    ]);
    const layers = texts.map(text => parseDeclarations(yaml, text));
    const rows = composeEntries(layers, () => { throw new Error('Patch depends on an uninspected entry.'); });
    const found = new Set();
    collectNames(rows, found);
    return [...found].sort();
  } catch {
    throw new Error('Cannot read DSH MCP declarations from the selected profile and home patches.');
  }
}

export async function mcpParity(state, options) {
  const hosts = {}, globalOnly = [], unavailable = {};
  async function inspect(host, read) {
    try {
      hosts[host] = await read();
    } catch (error) {
      unavailable[host] = error.message;
    }
  }
  if (state.agents?.includes('pi')) hosts.pi = Object.keys(await piServers(state)).sort();
  if (state.agents?.includes('codex')) await inspect('codex', () => codexMcpNames(state.codexHome, options));
  if (state.agents?.includes('dsh')) {
    if (isDesktopProfile(state.dshProfile)) globalOnly.push('dsh');
    else await inspect('dsh', () => dshMcpNames(state.dshHome, state.dshProfile || 'web', options));
  }
  const all = [...new Set(Object.values(hosts).flat())].sort();
  const missing = {};
  for (const [host, entries] of Object.entries(hosts)) missing[host] = all.filter(name => !entries.includes(name));
  return { hosts, all, missing, globalOnly, unavailable };
}

export async function printMcpParity(state, log = console.log, options) {
  const parity = await mcpParity(state, options);
  for (const [host, entries] of Object.entries(parity.hosts)) {
    log(`mcp ${host}: ${entries.length ? entries.join(', ') : '(none)'}`);
  }
  for (const host of parity.globalOnly) log(`mcp ${host}: (global-only; MCP sync disabled)`);
  for (const [host, detail] of Object.entries(parity.unavailable)) log(`mcp ${host}: (unavailable; ${detail})`);
  for (const [host, entries] of Object.entries(parity.missing)) {
    if (entries.length) log(`mcp missing on ${host}: ${entries.join(', ')}`);
  }
  return parity;
}
