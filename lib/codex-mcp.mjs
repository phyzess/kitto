import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bearerCredentialReference, literalSecretsIn, transportCredentialProblem, unresolvedPlaceholdersIn,
} from './mcp-credentials.mjs';

const platformDirectories = { darwin: 'macos', linux: 'linux' };
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

export function transportHash(transport) {
  return createHash('sha256').update(canonicalJson(transport)).digest('hex');
}

export function sourceTransport(entry) {
  if (!isObject(entry)) return { skip: 'server definition is not an object' };
  const [secret] = literalSecretsIn(entry);
  if (secret) return { skip: `contains a literal secret (${secret.label}) at ${secret.path}` };
  const [placeholder] = unresolvedPlaceholdersIn(entry);
  if (placeholder) return { skip: `still contains an unresolved YOUR_* placeholder at ${placeholder.path}` };
  const transportProblem = transportCredentialProblem(entry);
  if (transportProblem) return { skip: `${transportProblem}; only reference credentials are synced` };
  for (const field of ['oauth', 'scopes', 'tools', 'toolFilter', 'enabledTools', 'disabledTools',
    'enabled_tools', 'disabled_tools', 'startup_timeout_sec', 'tool_timeout_sec', 'timeout']) {
    if (!empty(entry[field])) return { skip: `${field} is not synced in v1` };
  }
  const command = entry.command, url = entry.url;
  const hasCommand = typeof command === 'string' && command !== '';
  const hasUrl = typeof url === 'string' && url !== '';
  if (hasCommand && hasUrl) return { skip: 'defines both command and url' };
  if (hasUrl) {
    if (!empty(entry.env_http_headers)) return { skip: 'env_http_headers are not synced in v1' };
    if (!empty(entry.bearer_token_env_var) || !empty(entry.http_headers_helper)) {
      return { skip: 'header credentials are not synced in v1' };
    }
    if (!empty(entry.env)) return { skip: 'env is not synced in v1' };
    if (hasTemplate(url)) return { skip: 'url contains a credential template' };
    let bearerTokenEnvVar;
    if (!empty(entry.headers)) {
      if (!isObject(entry.headers)) return { skip: 'headers is not an object of strings' };
      const names = Object.keys(entry.headers);
      const [header] = names;
      const value = header === undefined ? undefined : entry.headers[header];
      const reference = names.length === 1 && header.toLowerCase() === 'authorization'
        ? bearerCredentialReference(value) : null;
      if (!reference) {
        return { skip: 'headers are not synced in v1: only Authorization: Bearer ${VAR} is supported' };
      }
      bearerTokenEnvVar = reference;
    }
    return { transport: { type: 'http', url, ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}) } };
  }
  if (!hasCommand) return { skip: 'has neither a command nor a url' };
  if (command.includes('${')) return { skip: 'command contains a credential template' };
  const args = entry.args ?? [];
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    return { skip: 'args is not an array of strings' };
  }
  if (hasTemplate(args)) return { skip: 'args contain a credential template' };
  if (!empty(entry.headers)) return { skip: 'headers are not synced in v1 for stdio servers' };
  if (!empty(entry.env)) return { skip: 'env is not synced in v1: codex mcp add --env would store a literal' };
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

export async function sourceServers(source, platform = process.platform, { includePrivate = false } = {}) {
  const basePath = join(source, 'config/pi/mcp.json');
  const base = await optionalJson(basePath);
  if (base === null) {
    throw new Error(`Codex MCP sync needs ${basePath}, but the Pi MCP source is missing.`);
  }
  const platformName = platformDirectories[platform];
  const sources = [[basePath, base]];
  if (platformName) {
    const overlayPath = join(source, `config/pi/platform/${platformName}/mcp.json`);
    sources.push([overlayPath, await optionalJson(overlayPath)]);
  }
  if (includePrivate) {
    for (const path of [join(source, 'config/pi/local/mcp.json'), join(source, 'config/pi/mcp.private.json')]) {
      sources.push([path, await optionalJson(path)]);
    }
  }
  const merged = new Map();
  for (const [label, config] of sources) {
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
    const bearer = transport.bearer_token_env_var;
    return {
      type: 'http',
      url: transport.url,
      ...(typeof bearer === 'string' && bearer !== '' ? { bearerTokenEnvVar: bearer } : {}),
    };
  }
  return null;
}

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
    case 'adopt': return `mcp adopt: ${operation.name} (codex)`;
    case 'forget': return `mcp forget: ${operation.name} (codex)`;
    case 'forgetPending': return `mcp forget pending: ${operation.name} (codex)`;
    default: return `mcp ${operation.action}: ${operation.name} (codex)`;
  }
}

export function buildMcpPlan({
  servers = [], owned = {}, pending = {}, live = [], details = new Map(), liveVerified = false,
}) {
  const sources = new Map(servers.map(server => [server.name, server]));
  const current = new Map(live.map(entry => [entry.name, entry]));
  const operations = [];
  const added = new Set();
  for (const server of servers) {
    if (server.skip) {
      operations.push({ name: server.name, action: 'skip', reason: server.skip });
      continue;
    }
    const liveEntry = current.get(server.name);
    if (!liveEntry) {
      operations.push({ name: server.name, action: 'add', transport: server.transport, hash: server.hash });
      added.add(server.name);
      continue;
    }
    const detail = details.get(server.name) ?? liveEntry;
    const transport = liveTransport(detail);
    const liveHash = transport ? transportHash(transport) : null;
    const extras = liveExtras(detail);
    if (transport && extras.length === 0 && hasOwn(pending, server.name) && pending[server.name] === liveHash) {
      operations.push({ name: server.name, action: 'adopt', hash: liveHash,
        reason: hasOwn(owned, server.name) ? 'finish an interrupted update' : 'finish an interrupted add' });
      continue;
    }
    if (!hasOwn(owned, server.name)) {
      operations.push({ name: server.name, action: 'conflict',
        reason: 'same-name MCP server is not owned by Kitto' });
      continue;
    }
    if (!transport) {
      operations.push({ name: server.name, action: 'conflict', reason: 'unrecognized live transport' });
      continue;
    }
    if (liveHash !== owned[server.name]) {
      operations.push({ name: server.name, action: 'conflict',
        reason: 'live server differs from the recorded ownership fingerprint' });
      continue;
    }
    if (extras.length) {
      operations.push({ name: server.name, action: 'conflict',
        reason: `live server has additional settings (${extras.join(', ')})` });
      continue;
    }
    if (liveHash === server.hash) {
      operations.push({ name: server.name, action: 'same' });
      continue;
    }
    operations.push({ name: server.name, action: 'update', transport: server.transport, hash: server.hash });
  }
  for (const name of Object.keys(owned)) {
    if (sources.has(name)) continue;
    const liveEntry = current.get(name);
    if (!liveEntry) continue;
    const detail = details.get(name) ?? liveEntry;
    const transport = liveTransport(detail);
    if (!transport) {
      operations.push({ name, action: 'conflict', reason: 'unrecognized live transport' });
      continue;
    }
    const fingerprints = [owned[name], pending[name]].filter(value => value);
    if (!fingerprints.includes(transportHash(transport))) {
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
    operations.push({ name, action: 'remove', hash: transportHash(transport) });
  }
  for (const name of Object.keys(owned)) {
    if (current.has(name) || added.has(name) || !liveVerified) continue;
    operations.push({ name, action: 'forget', reason: 'recorded server is missing from live Codex' });
  }
  for (const name of Object.keys(pending)) {
    if (hasOwn(owned, name)) continue;
    const source = sources.get(name);
    if (source && !source.skip) continue;
    const liveEntry = current.get(name);
    if (!liveEntry) {
      if (liveVerified) {
        operations.push({ name, action: 'forgetPending', reason: 'pending server is missing from live Codex' });
      }
      continue;
    }
    const detail = details.get(name) ?? liveEntry;
    const transport = liveTransport(detail);
    const liveHash = transport ? transportHash(transport) : null;
    const matches = transport && liveExtras(detail).length === 0 && pending[name] === liveHash;
    if (!matches) {
      if (liveVerified) {
        operations.push({ name, action: 'forgetPending', reason: 'pending server was changed outside Kitto' });
      }
      continue;
    }
    if (!source) {
      operations.push({ name, action: 'remove', hash: liveHash, reason: 'source removed an interrupted add' });
      continue;
    }
    operations.push({ name, action: 'adopt', hash: liveHash, reason: 'finish an interrupted add' });
  }
  return operations;
}

export function buildRemovalPlan({ owned = {}, pending = {}, live = [], details = new Map() }) {
  const current = new Map(live.map(entry => [entry.name, entry]));
  const operations = [];
  const stale = [];
  const stalePending = [];
  for (const name of new Set([...Object.keys(owned), ...Object.keys(pending)])) {
    const liveEntry = current.get(name);
    if (!liveEntry) {
      if (hasOwn(owned, name)) stale.push(name);
      if (hasOwn(pending, name)) stalePending.push(name);
      continue;
    }
    const detail = details.get(name) ?? liveEntry;
    const transport = liveTransport(detail);
    if (!transport) {
      operations.push({ name, action: 'conflict', reason: 'unrecognized live transport' });
      continue;
    }
    const liveHash = transportHash(transport);
    const fingerprints = [owned[name], pending[name]].filter(value => value);
    if (!fingerprints.includes(liveHash)) {
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
    operations.push({ name, action: 'remove', hash: liveHash });
  }
  return { operations, stale, stalePending };
}

export function defaultCodexRun(args, { env = process.env, timeout = 30_000, cwd } = {}) {
  const result = spawnSync('codex', args, { encoding: 'utf8', env, timeout, cwd });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`codex ${args.slice(0, 2).join(' ')} failed: ${detail}`);
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

function liveDetails({ owned, pending = {}, live, run, env }) {
  const tracked = new Set([...Object.keys(owned), ...Object.keys(pending)]);
  const details = new Map();
  for (const entry of live) {
    if (tracked.has(entry?.name)) details.set(entry.name, getCodexMcp(entry.name, { run, env }));
  }
  return details;
}

function liveVerifiedFor(home, env) {
  const target = home ?? env?.CODEX_HOME;
  return target ? existsSync(target) : false;
}

async function withLive({ run, env, home, list, readOnly }, callback) {
  if (list) return callback({ live: await list(), env, verified: true, home });
  if (readOnly && home && existsSync(home)) {
    const scratch = await mkdtemp(join(tmpdir(), 'kitto-codex-mcp-'));
    try {
      const config = join(home, 'config.toml');
      if (existsSync(config)) await copyFile(config, join(scratch, 'config.toml'));
      const probeEnv = { ...env, CODEX_HOME: scratch };
      const live = listCodexMcp({ run, env: probeEnv, home: scratch });
      return await callback({ live, env: probeEnv, verified: true, home: scratch });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  const live = listCodexMcp({ run, env, home });
  return callback({ live, env, verified: liveVerifiedFor(home, env), home });
}

async function collectPlan(state, { run, env, home, platform, readSource, list, readOnly = false }) {
  const owned = state.mcp?.codex ?? {};
  const pending = state.mcp?.codexPending ?? {};
  const servers = await readSource(state.source, platform, { includePrivate: state.includePrivate === true });
  return withLive({ run, env, home, list, readOnly }, ({ live, env: liveEnv, verified }) => ({
    servers, owned, pending, live, liveVerified: verified,
    details: liveDetails({ owned, pending, live, run, env: liveEnv }),
  }));
}

function addArguments(name, transport) {
  if (transport.type === 'stdio') return ['mcp', 'add', name, '--', transport.command, ...transport.args];
  return ['mcp', 'add', name, '--url', transport.url,
    ...(transport.bearerTokenEnvVar ? ['--bearer-token-env-var', transport.bearerTokenEnvVar] : [])];
}

export async function planCodexMcp(state, {
  run = defaultCodexRun, env = codexEnvironment(state), home = state.codexHome,
  platform = process.platform, log = console.log, readSource = sourceServers, list, readOnly = true,
} = {}) {
  const context = await collectPlan(state, { run, env, home, platform, readSource, list, readOnly });
  const operations = buildMcpPlan(context);
  for (const operation of operations) log(formatOperation(operation));
  return operations;
}

function verifyLive(name, recorded, run, env) {
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

async function savePending(state, name, hash, save) {
  state.mcp ||= {};
  state.mcp.codex ||= {};
  state.mcp.codexPending ||= {};
  state.mcp.codexPending[name] = hash;
  await save();
}

async function promotePending(state, name, hash) {
  state.mcp.codex[name] = hash;
  if (!state.mcp.codexPending) return;
  delete state.mcp.codexPending[name];
  if (!Object.keys(state.mcp.codexPending).length) delete state.mcp.codexPending;
}

function forgetPending(state, name) {
  if (!state.mcp?.codexPending) return false;
  if (!hasOwn(state.mcp.codexPending, name)) return false;
  delete state.mcp.codexPending[name];
  if (!Object.keys(state.mcp.codexPending).length) delete state.mcp.codexPending;
  return true;
}

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
    if (operation.action === 'skip') {
      warn(formatOperation(operation));
      continue;
    }
    if (operation.action === 'add' || operation.action === 'update') {
      if (operation.action === 'add') {
        const live = list ? await list() : listCodexMcp({ run, env, home });
        if (live.some(item => item.name === operation.name)) {
          warn(`mcp conflict: ${operation.name} (codex): live server appeared during sync; preserved`);
          continue;
        }
      } else {
        const check = verifyLive(operation.name, state.mcp.codex[operation.name], run, env);
        if (check.problem) {
          warn(`mcp conflict: ${operation.name} (codex): ${check.problem}; preserved`);
          continue;
        }
      }
      await savePending(state, operation.name, operation.hash, save);
      if (home) await mkdir(home, { recursive: true });
      try {
        run(addArguments(operation.name, operation.transport), { env });
      } catch (error) {
        let detail = null;
        try {
          const live = list ? await list() : listCodexMcp({ run, env, home });
          if (live.some(item => item.name === operation.name)) {
            detail = getCodexMcp(operation.name, { run, env });
          }
        } catch {  }
        const transport = detail ? liveTransport(detail) : null;
        if (!transport || transportHash(transport) !== operation.hash || liveExtras(detail).length) throw error;
        warn(`mcp warning: ${operation.name} (codex): native ${operation.action} failed after writing the server (${error.message}); adopted. Run \`codex mcp login ${operation.name}\` if it needs authentication.`);
        await promotePending(state, operation.name, operation.hash);
        await save();
        log(`mcp adopt: ${operation.name} (codex)`);
        continue;
      }
      const live = list ? await list() : listCodexMcp({ run, env, home });
      const entry = live.find(item => item.name === operation.name);
      const transport = entry ? liveTransport(entry) : null;
      if (!transport || transportHash(transport) !== operation.hash) {
        throw new Error(`codex mcp add ${operation.name} did not persist the requested transport.`);
      }
      await promotePending(state, operation.name, operation.hash);
      await save();
      log(`mcp ${operation.action}: ${operation.name} (codex)`);
      continue;
    }
    if (operation.action === 'adopt') {
      await promotePending(state, operation.name, operation.hash);
      await save();
      log(`mcp adopt: ${operation.name} (codex)`);
      continue;
    }
    if (operation.action === 'forget') {
      delete state.mcp.codex[operation.name];
      forgetPending(state, operation.name);
      await save();
      log(`mcp forget: ${operation.name} (codex)`);
      continue;
    }
    if (operation.action === 'forgetPending') {
      if (forgetPending(state, operation.name)) {
        await save();
        log(`mcp forget pending: ${operation.name} (codex)`);
      }
      continue;
    }
    if (operation.action === 'remove') {
      const recorded = state.mcp.codex[operation.name] ?? state.mcp.codexPending?.[operation.name];
      const check = verifyLive(operation.name, recorded, run, env);
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
      forgetPending(state, operation.name);
      await save();
      log(`mcp remove: ${operation.name} (codex)`);
      continue;
    }
    if (operation.action === 'conflict') {
      warn(`mcp conflict: ${operation.name} (codex): ${operation.reason}; preserved`);
    }
  }
  if (state.mcp.codexPending && Object.keys(state.mcp.codexPending).length) {
    let changed = false;
    const live = list ? await list() : listCodexMcp({ run, env, home });
    for (const [name, hash] of Object.entries(state.mcp.codexPending)) {
      const entry = live.find(item => item.name === name);
      let stale = !entry;
      if (entry) {
        try {
          const detail = getCodexMcp(name, { run, env });
          const transport = liveTransport(detail);
          stale = !transport || transportHash(transport) !== hash || liveExtras(detail).length > 0;
        } catch {
          stale = true;
        }
      }
      if (stale) {
        delete state.mcp.codexPending[name];
        changed = true;
      }
    }
    if (changed) await save();
    if (!Object.keys(state.mcp.codexPending).length) {
      delete state.mcp.codexPending;
      await save();
    }
  }
  return operations;
}

export async function removeCodexMcp(state, {
  apply = false, run = defaultCodexRun, env = codexEnvironment(state), home = state.codexHome,
  save = async () => {}, log = console.log, warn = console.warn, list,
} = {}) {
  const owned = state.mcp?.codex ?? {};
  const pending = state.mcp?.codexPending ?? {};
  if (!Object.keys(owned).length && !Object.keys(pending).length) {
    return { operations: [], stale: [], stalePending: [] };
  }
  return withLive({ run, env, home, list, readOnly: !apply }, async ({ live, env: liveEnv }) => {
    const details = liveDetails({ owned, pending, live, run, env: liveEnv });
    const plan = buildRemovalPlan({ owned, pending, live, details });
    if (!apply) {
      for (const operation of plan.operations) log(formatOperation(operation));
      return plan;
    }
    state.mcp ||= {};
    state.mcp.codex ||= {};
    state.mcp.codexPending ||= {};
    for (const operation of plan.operations) {
      if (operation.action === 'conflict') {
        warn(`mcp conflict: ${operation.name} (codex): ${operation.reason}; preserved`);
        continue;
      }
      if (operation.action !== 'remove') continue;
      const recorded = state.mcp.codex[operation.name] ?? state.mcp.codexPending[operation.name];
      const check = verifyLive(operation.name, recorded, run, liveEnv);
      if (check.problem) {
        warn(`mcp conflict: ${operation.name} (codex): ${check.problem}; preserved`);
        continue;
      }
      run(['mcp', 'remove', operation.name], { env: liveEnv });
      const liveAfter = list ? await list() : listCodexMcp({ run, env: liveEnv, home });
      if (liveAfter.some(item => item.name === operation.name)) {
        throw new Error(`codex mcp remove ${operation.name} did not remove the server.`);
      }
      delete state.mcp.codex[operation.name];
      delete state.mcp.codexPending[operation.name];
      await save();
      log(`mcp remove: ${operation.name} (codex)`);
    }
    let changed = false;
    for (const name of [...plan.stale, ...plan.stalePending]) {
      if (hasOwn(state.mcp.codex, name)) { delete state.mcp.codex[name]; changed = true; }
      if (hasOwn(state.mcp.codexPending, name)) { delete state.mcp.codexPending[name]; changed = true; }
    }
    if (changed) await save();
    if (!Object.keys(state.mcp.codexPending).length) {
      delete state.mcp.codexPending;
      await save();
    }
    return plan;
  });
}
