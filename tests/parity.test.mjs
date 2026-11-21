import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpParity, printMcpParity } from '../lib/parity.mjs';

function temp(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kitto-parity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('mcpParity compares Pi, Codex and DSH native configs', async t => {
  const directory = temp(t);
  const piHome = join(directory, 'pi');
  const codexHome = join(directory, 'codex');
  const dshHome = join(directory, 'dsh');
  mkdirSync(piHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true });
  writeFileSync(join(piHome, 'mcp.json'), JSON.stringify({
    mcpServers: { alpha: { command: 'a' }, beta: { command: 'b' } },
  }));
  writeFileSync(join(codexHome, 'config.toml'),
    '[mcp_servers.alpha]\ncommand = "a"\n\n[mcp_servers."dot.name"]\ncommand = "d"\n');
  writeFileSync(join(dshHome, 'cordis.patch.yml'), '- insert:\n    - id: x\n      config:\n        serverName: alpha\n');
  const state = { agents: ['pi', 'codex', 'dsh'], source: directory, piHome, codexHome, dshHome, dshProfile: 'web' };
  const parity = await mcpParity(state);
  assert.deepEqual(parity.all, ['alpha', 'beta', 'dot.name']);
  assert.deepEqual(parity.hosts.pi, ['alpha', 'beta']);
  assert.deepEqual(parity.hosts.codex, ['alpha', 'dot.name']);
  assert.deepEqual(parity.hosts.dsh, ['alpha']);
  assert.deepEqual(parity.missing.codex, ['beta']);
  assert.deepEqual(parity.missing.dsh, ['beta', 'dot.name']);
});

test('printMcpParity prints one line per host and missing list', async t => {
  const directory = temp(t);
  const state = {
    agents: ['pi', 'codex'], source: directory, piHome: join(directory, 'pi'),
    codexHome: join(directory, 'codex'), codexMcpNames: undefined,
  };
  mkdirSync(state.piHome, { recursive: true });
  writeFileSync(join(state.piHome, 'mcp.json'), JSON.stringify({ mcpServers: { alpha: { command: 'a' } } }));
  const lines = [];
  await printMcpParity(state, line => lines.push(line));
  assert(lines.some(line => line === 'mcp pi: alpha'));
  assert(lines.some(line => line === 'mcp codex: (none)'));
  assert(lines.some(line => line === 'mcp missing on codex: alpha'));
});

test('mcpParity marks the app-managed DSH desktop profile global-only', async t => {
  const directory = temp(t);
  const state = {
    agents: ['pi', 'dsh'], source: directory, piHome: join(directory, 'pi'),
    dshHome: join(directory, 'dsh'), dshProfile: 'desktop',
  };
  mkdirSync(state.piHome, { recursive: true });
  writeFileSync(join(state.piHome, 'mcp.json'), JSON.stringify({ mcpServers: { alpha: { command: 'a' } } }));
  const parity = await mcpParity(state);
  assert.deepEqual(parity.hosts.pi, ['alpha']);
  assert.equal(parity.hosts.dsh, undefined);
  assert.equal(parity.missing.dsh, undefined);
  assert.deepEqual(parity.globalOnly, ['dsh']);
  const lines = [];
  await printMcpParity(state, line => lines.push(line));
  assert(lines.includes('mcp dsh: (global-only; MCP sync disabled)'));
  assert(!lines.some(line => line.startsWith('mcp missing on dsh')));
});
