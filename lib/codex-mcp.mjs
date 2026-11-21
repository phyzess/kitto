import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Pi MCP definitions are the source of truth. Local, private and machine-level
// overlays stay out of Codex: they can contain credentials this module refuses
// to guess at.
const platformDirectories = { darwin: 'macos', linux: 'linux' };
// The names `codex mcp add` accepts (letters, numbers, '-', '_', ':', '@', '/',
// '.'). Anything else is reported instead of being passed through.
const acceptedName = /^[A-Za-z0-9_:@/.-]+$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const empty = value => value === undefined || value === null
  || (isObject(value) && Object.keys(value).length === 0)
  || (Array.isArray(value) && value.length === 0);

function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return over;
  const merged = { ...base };
  for (const [key, value] of Object.entries(over)) {
    merged[key] = hasOwn(merged, key) ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasTemplate(value) {
  if (typeof value === 'string') return value.includes('${');
  if (Array.isArray(value)) return value.some(hasTemplate);
  if (isObject(value)) return Object.values(value).some(hasTemplate);
  return false;
}

/** A stable fingerprint for the transport Kitto is allowed to own. */
export function transportHash(transport) {
  return createHash('sha256').update(canonicalJson(transport)).digest('hex');
}

/** Map one Pi MCP entry to the subset `codex mcp add` can represent. */
export function sourceTransport(entry) {
  if (!isObject(entry)) return { skip: 'server definition is not an object' };
  const command = entry.command, url = entry.url;
  const hasCommand = typeof command === 'string' && command !== '';
  const hasUrl = typeof url === 'string' && url !== '';
  if (hasCommand && hasUrl) return { skip: 'defines both command and url' };
  if (hasUrl) {
    if (!empty(entry.headers)) return { skip: 'headers are not synced in v1' };
    if (!empty(entry.env_http_headers)) return { skip: 'env_http_headers are not synced in v1' };
    if (!empty(entry.bearer_token_env_var) || !empty(entry.http_headers_helper)) {
      return { skip: 'header credentials are not synced in v1' };
    }
    if (!empty(entry.env)) return { skip: 'env is not synced in v1' };
    if (hasTemplate(url)) return { skip: 'url contains a credential template' };
    return { transport: { type: 'http', url } };
  }
  if (!hasCommand) return { skip: 'has neither a command nor a url' };
  if (command.includes('${')) return { skip: 'command contains a credential template' };
  const args = entry.args ?? [];
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    return { skip: 'args is not an array of strings' };
  }
  if (hasTemplate(args)) return { skip: 'args contain a credential template' };
  if (!empty(entry.env)) return { skip: 'env is not synced in v1' };
  if (!empty(entry.env_vars)) return { skip: 'env_vars are not synced in v1' };
  if (!empty(entry.bearer_token_env_var)) return { skip: 'bearer_token_env_var is not synced in v1' };
  if (!empty(entry.cwd)) return { skip: 'cwd is not supported by codex mcp add' };
  return { transport: { type: 'stdio', command, args } };
}

async function optionalJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error.message}`);
  }
}

/** Enabled servers from the repository and platform Pi MCP files. */
export async function sourceServers(source, platform = process.platform) {
  const basePath = join(source, 'config/pi/mcp.json');
  const base = await optionalJson(basePath);
  if (base === null) {
    throw new Error(`Codex MCP sync needs ${basePath}, but the Pi MCP source is missing.`);
  }
  const platformName = platformDirectories[platform];
  const overlay = platformName
    ? await optionalJson(join(source, `config/pi/platform/${platformName}/mcp.json`))
    : null;
  const merged = new Map();
  for (const [label, config] of [[basePath, base], [`config/pi/platform/${platformName ?? platform}/mcp.json`, overlay]]) {
    if (config == null) continue;
    if (!isObject(config) || (config.mcpServers !== undefined && !isObject(config.mcpServers))) {
      throw new Error(`Invalid MCP configuration in ${label}: mcpServers must be an object.`);
    }
    for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
      if (name.startsWith('_') || !isObject(entry)) continue;
      merged.set(name, deepMerge(merged.get(name) ?? {}, entry));
    }
  }
  const servers = [];
  for (const [name, entry] of merged) {
    if (entry.enabled === false) continue;
    if (!acceptedName.test(name)) {
      servers.push({ name, skip: 'name contains characters codex mcp add rejects' });
      continue;
    }
    const mapped = sourceTransport(entry);
    if (mapped.skip) servers.push({ name, skip: mapped.skip });
    else servers.push({ name, transport: mapped.transport, hash: transportHash(mapped.transport) });
  }
  return servers;
}

/** Normalize the transport fields returned by `codex mcp list/get --json`. */
export function liveTransport(entry) {
  const transport = isObject(entry) ? entry.transport : null;
  if (!isObject(transport)) return null;
  if (transport.type === 'stdio' && typeof transport.command === 'string' && transport.command !== '') {
    const args = transport.args ?? [];
    if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) return null;
    return { type: 'stdio', command: transport.command, args };
  }
  if ((transport.type === 'streamable_http' || transport.type === 'http')
      && typeof transport.url === 'string' && transport.url !== '') {
    return { type: 'http', url: transport.url };
  }
  return null;
}

/**
 * Settings that `codex mcp add` would silently drop. If any are present, the
 * live server has been adjusted outside Kitto and must be preserved.
 */
export function liveExtras(entry) {
  if (!isObject(entry)) return ['unknown definition'];
  const extras = [];
  if (entry.enabled === false) extras.push('enabled=false');
  if (!empty(entry.enabled_tools)) extras.push('enabled_tools');
  if (!empty(entry.disabled_tools)) extras.push('disabled_tools');
  if (!empty(entry.startup_timeout_sec)) extras.push('startup_timeout_sec');
  if (!empty(entry.tool_timeout_sec)) extras.push('tool_timeout_sec');
  const transport = entry.transport;
  if (!isObject(transport)) return extras;
  if (transport.type === 'stdio') {
    if (!empty(transport.env)) extras.push('env');
    if (!empty(transport.env_vars)) extras.push('env_vars');
    if (!empty(transport.cwd)) extras.push('cwd');
  } else {
    if (!empty(transport.bearer_token_env_var)) extras.push('bearer_token_env_var');
    if (!empty(transport.http_headers)) extras.push('http_headers');
    if (!empty(transport.env_http_headers)) extras.push('env_http_headers');
    if (!empty(transport.http_headers_helper)) extras.push('http_headers_helper');
  }
  return extras;
}

export function formatOperation(operation) {
  const reason = operation.reason ? `: ${operation.reason}` : '';
  switch (operation.action) {
    case 'add': return `mcp add: ${operation.name} (codex)`;
    case 'update': return `mcp update: ${operation.name} (codex)`;
    case 'same': return `mcp same: ${operation.name} (codex)`;
    case 'skip': return `mcp skip: ${operation.name} (codex)${reason}`;
    case 'conflict': return `mcp conflict: ${operation.name} (codex)${reason}; preserved`;
    case 'remove': return `mcp remove: ${operation.name} (codex)`;
    default: return `mcp ${operation.action}: ${operation.name} (codex)`;
  }
}

/**
 * Pure plan for the source servers against the live Codex inventory.
 * `details` holds `codex mcp get --json` results for servers Kitto owns.
 */
export function buildMcpPlan({ servers = [], owned = {}, live = [], details = new Map() }) {
  const sources = new Map(servers.map(server => [server.name, server]));
  const current = new Map(live.map(entry => [entry.name, entry]));
  const operations = [];
  for (const server of servers) {
    if (server.skip) {
      operations.push({ name: server.name, action: 'skip', reason: server.skip });
      continue;
    }
    const liveEntry = current.get(server.name);
    if (!liveEntry) {
      operations.push({ name: server.name, action: 'add', transport: server.transport, hash: server.hash });
      continue;
    }
    if (!hasOwn(owned, server.name)) {
      operations.push({ name: server.name, action: 'conflict',
        reason: 'same-name MCP server is not owned by Kitto' });
      continue;
    }
    const detail = details.get(server.name) ?? liveEntry;
    const transport = liveTransport(detail);
    if (!transport) {
      operations.push({ name: server.name, action: 'conflict', reason: 'unrecognized live transport' });
      continue;
    }
    if (transportHash(transport) !== owned[server.name]) {
      operations.push({ name: server.name, action: 'conflict',
        reason: 'live server differs from the recorded ownership fingerprint' });
      continue;
    }
    const extras = liveExtras(detail);
    if (extras.length) {
      operations.push({ name: server.name, action: 'conflict',
        reason: `live server has additional settings (${extras.join(', ')})` });
      continue;
    }
    if (transportHash(transport) === server.hash) {
      operations.push({ name: server.name, action: 'same' });
      continue;
    }
    operations.push({ name: server.name, action: 'update', transport: server.transport, hash: server.hash });
  }
  for (const [name, recorded] of Object.entries(owned)) {
    if (sources.has(name)) continue;
    const liveEntry = current.get(name);
    if (!liveEntry) continue;
    const detail = details.get(name) ?? liveEntry;
    const transport = liveTransport(detail);
    if (!transport) {
      operations.push({ name, action: 'conflict', reason: 'unrecognized live transport' });
      continue;
    }
    if (transportHash(transport) !== recorded) {
      operations.push({ name, action: 'conflict',
        reason: 'source removed the server, but the live server changed outside Kitto' });
      continue;
    }
    const extras = liveExtras(detail);
    if (extras.length) {
      operations.push({ name, action: 'conflict',
        reason: `source removed the server, but the live server has additional settings (${extras.join(', ')})` });
      continue;
    }
    operations.push({ name, action: 'remove', hash: recorded });
  }
  return operations;
}

/** Preview/removal plan for detaching Kitto from Codex. */
export function buildRemovalPlan({ owned = {}, live = [], details = new Map() }) {
  const current = new Map(live.map(entry => [entry.name, entry]));
  const operations = [];
  const stale = [];
  for (const [name, recorded] of Object.entries(owned)) {
    const liveEntry = current.get(name);
    if (!liveEntry) {
      stale.push(name);
      continue;
    }
    const detail = details.get(name) ?? liveEntry;
    const transport = liveTransport(detail);
    if (!transport) {
      operations.push({ name, action: 'conflict', reason: 'unrecognized live transport' });
      continue;
    }
    if (transportHash(transport) !== recorded) {
      operations.push({ name, action: 'conflict',
        reason: 'live server differs from the recorded ownership fingerprint' });
      continue;
    }
    const extras = liveExtras(detail);
    if (extras.length) {
      operations.push({ name, action: 'conflict',
        reason: `live server has additional settings (${extras.join(', ')})` });
      continue;
    }
    operations.push({ name, action: 'remove', hash: recorded });
  }
  return { operations, stale };
}

/** Run `codex` and return stdout; spawn failures and non-zero exits throw. */
export function defaultCodexRun(args, { env = process.env, timeout = 30_000, cwd } = {}) {
  const result = spawnSync('codex', args, { encoding: 'utf8', env, timeout, cwd });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`codex ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function parseResponse(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

export function listCodexMcp({ run = defaultCodexRun, env = process.env, home } = {}) {
  // Invoking `codex` also creates helper files under CODEX_HOME; a missing home
  // means there is no Codex configuration to reconcile yet.
  const target = home ?? env?.CODEX_HOME;
  if (target && !existsSync(target)) return [];
  const parsed = parseResponse(run(['mcp', 'list', '--json'], { env }), 'codex mcp list --json');
  if (!Array.isArray(parsed)) throw new Error('codex mcp list --json did not return an array.');
  return parsed;
}

export function getCodexMcp(name, { run = defaultCodexRun, env = process.env } = {}) {
  const parsed = parseResponse(run(['mcp', 'get', name, '--json'], { env }), `codex mcp get ${name} --json`);
  if (!isObject(parsed)) throw new Error(`codex mcp get ${name} --json did not return an object.`);
  return parsed;
}

function codexEnvironment(state) {
  return { ...process.env, CODEX_HOME: state.codexHome };
}

function liveDetails({ owned, live, run, env }) {
  const details = new Map();
  for (const entry of live) {
    if (hasOwn(owned, entry?.name)) details.set(entry.name, getCodexMcp(entry.name, { run, env }));
  }
  return details;
}

async function collectPlan(state, { run, env, home, platform, readSource, list }) {
  const owned = state.mcp?.codex ?? {};
  const servers = await readSource(state.source, platform);
  const live = list ? await list() : listCodexMcp({ run, env, home });
  return { servers, owned, live, details: liveDetails({ owned, live, run, env }) };
}

function addArguments(name, transport) {
  if (transport.type === 'stdio') return ['mcp', 'add', name, '--', transport.command, ...transport.args];
  return ['mcp', 'add', name, '--url', transport.url];
}

/** Print the MCP part of the deployment plan without writing anything. */
export async function planCodexMcp(state, {
  run = defaultCodexRun, env = codexEnvironment(state), home = state.codexHome,
  platform = process.platform, log = console.log, readSource = sourceServers, list,
} = {}) {
  const context = await collectPlan(state, { run, env, home, platform, readSource, list });
  const operations = buildMcpPlan(context);
  for (const operation of operations) log(formatOperation(operation));
  return operations;
}

function verifyOwnedLive(name, recorded, run, env) {
  const live = listCodexMcp({ run, env });
  const entry = live.find(item => item.name === name);
  if (!entry) return { entry: null, problem: 'live server disappeared' };
  const detail = getCodexMcp(name, { run, env });
  const transport = liveTransport(detail);
  if (!transport || transportHash(transport) !== recorded) {
    return { entry, problem: 'live server differs from the recorded ownership fingerprint' };
  }
  const extras = liveExtras(detail);
  if (extras.length) return { entry, problem: `live server has additional settings (${extras.join(', ')})` };
  return { entry, transport };
}

/**
 * Apply the plan. Every successful write is flushed through `save` before the
 * next server is touched, so an interrupted run can simply be retried.
 */
export async function applyCodexMcp(state, {
  run = defaultCodexRun, env = codexEnvironment(state), home = state.codexHome,
  platform = process.platform, save = async () => {}, log = () => {},
  warn = console.warn, readSource = sourceServers, list,
} = {}) {
  const context = await collectPlan(state, { run, env, home, platform, readSource, list });
  const operations = buildMcpPlan(context);
  state.mcp ||= {};
  state.mcp.codex ||= {};
  for (const operation of operations) {
    if (operation.action === 'add' || operation.action === 'update') {
      if (operation.action === 'add') {
        const live = list ? await list() : listCodexMcp({ run, env, home });
        if (live.some(item => item.name === operation.name)) {
          warn(`mcp conflict: ${operation.name} (codex): live server appeared during sync; preserved`);
          continue;
        }
      } else {
        const check = verifyOwnedLive(operation.name, state.mcp.codex[operation.name], run, env);
        if (check.problem) {
          warn(`mcp conflict: ${operation.name} (codex): ${check.problem}; preserved`);
          continue;
        }
      }
      if (home) await mkdir(home, { recursive: true });
      run(addArguments(operation.name, operation.transport), { env });
      const live = list ? await list() : listCodexMcp({ run, env, home });
      const entry = live.find(item => item.name === operation.name);
      const transport = entry ? liveTransport(entry) : null;
      if (!transport || transportHash(transport) !== operation.hash) {
        throw new Error(`codex mcp add ${operation.name} did not persist the requested transport.`);
      }
      state.mcp.codex[operation.name] = operation.hash;
      await save();
      log(`mcp ${operation.action}: ${operation.name} (codex)`);
      continue;
    }
    if (operation.action === 'remove') {
      const check = verifyOwnedLive(operation.name, state.mcp.codex[operation.name], run, env);
      if (check.problem) {
        warn(`mcp conflict: ${operation.name} (codex): ${check.problem}; preserved`);
        continue;
      }
      run(['mcp', 'remove', operation.name], { env });
      const live = list ? await list() : listCodexMcp({ run, env, home });
      if (live.some(item => item.name === operation.name)) {
        throw new Error(`codex mcp remove ${operation.name} did not remove the server.`);
      }
      delete state.mcp.codex[operation.name];
      await save();
      log(`mcp remove: ${operation.name} (codex)`);
      continue;
    }
    if (operation.action === 'conflict') {
      warn(`mcp conflict: ${operation.name} (codex): ${operation.reason}; preserved`);
    }
  }
  return operations;
}

/** Preview or remove every Codex MCP server that Kitto still owns. */
export async function removeCodexMcp(state, {
  apply = false, run = defaultCodexRun, env = codexEnvironment(state), home = state.codexHome,
  save = async () => {}, log = console.log, warn = console.warn, list,
} = {}) {
  const owned = state.mcp?.codex ?? {};
  if (!Object.keys(owned).length) return { operations: [], stale: [] };
  const live = list ? await list() : listCodexMcp({ run, env, home });
  const details = liveDetails({ owned, live, run, env });
  const plan = buildRemovalPlan({ owned, live, details });
  if (!apply) {
    for (const operation of plan.operations) log(formatOperation(operation));
    return plan;
  }
  state.mcp ||= {};
  state.mcp.codex ||= {};
  for (const operation of plan.operations) {
    if (operation.action === 'conflict') {
      warn(`mcp conflict: ${operation.name} (codex): ${operation.reason}; preserved`);
      continue;
    }
    if (operation.action !== 'remove') continue;
    const check = verifyOwnedLive(operation.name, state.mcp.codex[operation.name], run, env);
    if (check.problem) {
      warn(`mcp conflict: ${operation.name} (codex): ${check.problem}; preserved`);
      continue;
    }
    run(['mcp', 'remove', operation.name], { env });
    const liveAfter = list ? await list() : listCodexMcp({ run, env, home });
    if (liveAfter.some(item => item.name === operation.name)) {
      throw new Error(`codex mcp remove ${operation.name} did not remove the server.`);
    }
    delete state.mcp.codex[operation.name];
    await save();
    log(`mcp remove: ${operation.name} (codex)`);
  }
  for (const name of plan.stale) {
    if (!hasOwn(state.mcp.codex, name)) continue;
    delete state.mcp.codex[name];
    await save();
  }
  return plan;
}
