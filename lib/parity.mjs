import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { piServers } from './dependencies.mjs';

const CODEX_SECTION = /^\[mcp_servers\.("?)([A-Za-z0-9_-]+)\1\]\s*$/gm;
const DSH_SERVER = /^\s*serverName:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/gm;

async function optionalText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function names(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map(match => match[2] ?? match[1]))].sort();
}

export async function codexMcpNames(home) {
  if (!home) return [];
  return names(await optionalText(join(home, 'config.toml')), CODEX_SECTION);
}

export async function dshMcpNames(home, profile = 'web') {
  if (!home) return [];
  const files = [join(home, 'cordis.patch.yml'), join(home, 'profiles', profile, 'cordis.patch.yml')];
  const found = new Set();
  for (const file of files) for (const name of names(await optionalText(file), DSH_SERVER)) found.add(name);
  return [...found].sort();
}

/** Compare the MCP server names each selected host actually loads. */
export async function mcpParity(state) {
  const hosts = {};
  if (state.agents?.includes('pi')) hosts.pi = Object.keys(await piServers(state)).sort();
  if (state.agents?.includes('codex')) hosts.codex = await codexMcpNames(state.codexHome);
  if (state.agents?.includes('dsh')) hosts.dsh = await dshMcpNames(state.dshHome, state.dshProfile || 'web');
  const all = [...new Set(Object.values(hosts).flat())].sort();
  const missing = {};
  for (const [host, entries] of Object.entries(hosts)) missing[host] = all.filter(name => !entries.includes(name));
  return { hosts, all, missing };
}

export async function printMcpParity(state, log = console.log) {
  const parity = await mcpParity(state);
  if (Object.keys(parity.hosts).length === 0) return parity;
  for (const [host, entries] of Object.entries(parity.hosts)) {
    log(`mcp ${host}: ${entries.length ? entries.join(', ') : '(none)'}`);
  }
  for (const [host, entries] of Object.entries(parity.missing)) {
    if (entries.length) log(`mcp missing on ${host}: ${entries.join(', ')}`);
  }
  return parity;
}
