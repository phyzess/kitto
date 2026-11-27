import { test } from 'vitest';
import { subtest } from './helpers/subtest.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpParity, printMcpParity } from '../lib/parity.ts';
import { dshExecutable } from '../integration/scoped-dsh/native.ts';

const dsh = await dshExecutable().catch(() => undefined);

function temp(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kitto-parity-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('Codex parity delegates TOML parsing without writing the real home or emitting transport values', async t => {
  const directory = temp(t);
  const piHome = join(directory, 'pi');
  const codexHome = join(directory, 'codex');
  mkdirSync(piHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(piHome, 'mcp.json'), JSON.stringify({
    mcpServers: { alpha: { command: 'a' }, beta: { command: 'b' } },
  }));
  const toml = `[mcp_servers.alpha] # bare name
command = "a"
[mcp_servers."dot.name"] # quoted name
command = "d"
[mcp_servers.disabled]
command = "not-executed"
enabled = false
[mcp_servers.alpha.env]
TOKEN = "fixture-must-not-leak"
`;
  writeFileSync(join(codexHome, 'config.toml'), toml);
  writeFileSync(join(codexHome, 'auth.json'), 'fixture-must-not-be-copied');
  const codex = join(directory, 'codex-fixture');
  writeFileSync(codex, `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.deepEqual(process.argv.slice(2), ['mcp', 'list', '--json']);
assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(process.env.HOME));
assert.equal(process.env.HOME, process.env.CODEX_HOME);
assert.equal(fs.statSync(process.cwd()).mode & 0o777, 0o700);
assert.deepEqual(fs.readdirSync(process.env.CODEX_HOME), ['config.toml']);
assert.equal(fs.readFileSync('config.toml', 'utf8'), ${JSON.stringify(toml)});
fs.writeFileSync('helper', 'created by fixture');
process.stderr.write('fixture-must-not-leak');
console.log(JSON.stringify([
  {name:'alpha', enabled:true, transport:{env:{TOKEN:'fixture-must-not-leak'}}},
  {name:'dot.name', enabled:true}, {name:'disabled', enabled:false},
]));
`, { mode: 0o700 });
  const state = { agents: ['pi', 'codex'], source: directory, piHome, codexHome };
  const lines = [];
  const parity = await printMcpParity(state, line => lines.push(line), { codex });
  assert.deepEqual(parity.all, ['alpha', 'beta', 'dot.name']);
  assert.deepEqual(parity.hosts.pi, ['alpha', 'beta']);
  assert.deepEqual(parity.hosts.codex, ['alpha', 'dot.name']);
  assert.deepEqual(parity.missing.codex, ['beta']);
  assert(!lines.join('\n').includes('fixture-must-not-leak'));
  assert.deepEqual(readdirSync(codexHome).sort(), ['auth.json', 'config.toml']);
  assert.equal(readFileSync(join(codexHome, 'config.toml'), 'utf8'), toml);
  assert.equal(readFileSync(join(codexHome, 'auth.json'), 'utf8'), 'fixture-must-not-be-copied');
});

test('DSH parity composes enabled declarations over profile then home', { skip: !dsh && 'native DSH YAML and composer unavailable' }, async t => {
  const dshHome = temp(t);
  mkdirSync(join(dshHome, 'profiles/web'), { recursive: true });
  const homePatch = `- insert:
    - id: alpha-home
      name: '@deepseek-ai/dsh-mcp-client'
      config: { serverName: alpha }
    - id: unrelated
      name: another-plugin
      config:
        body: |
          serverName: scalar-ghost
        serverName: unrelated-ghost
    - id: manager
      name: '@deepseek-ai/dsh-mcp-manager'
      config:
        servers:
          declarative: { enabled: true }
          muted: { enabled: false }
- id: disable-me
  disabled: true
`;
  writeFileSync(join(dshHome, 'cordis.patch.yml'), homePatch);
  const profilePatch = `- insert:
    - id: alpha-profile
      name: '@deepseek-ai/dsh-mcp-client'
      config: { serverName: alpha }
    - id: disable-me
      name: '@deepseek-ai/dsh-mcp-client'
      config: { serverName: inactive }
    - id: group
      name: 'cordis:group'
      group: true
      disabled: true
      config:
        - id: inner
          name: '@deepseek-ai/dsh-mcp-client'
          config: { serverName: group-ghost }
`;
  const profileFile = join(dshHome, 'profiles/web/cordis.patch.yml');
  writeFileSync(profileFile, profilePatch);
  const state = { agents: ['dsh'], dshHome, dshProfile: 'web' };
  const parity = await mcpParity(state, { dsh });
  assert.deepEqual(parity.hosts.dsh, ['alpha', 'declarative']);
  assert.deepEqual(parity.unavailable, {});
  assert.equal(readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8'), homePatch);
  assert.equal(readFileSync(profileFile, 'utf8'), profilePatch);
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

test('an unavailable host is not treated as missing every server', async t => {
  const directory = temp(t);
  const piHome = join(directory, 'pi');
  const codexHome = join(directory, 'codex');
  const dshHome = join(directory, 'dsh');
  for (const home of [piHome, codexHome, dshHome]) mkdirSync(home);
  writeFileSync(join(piHome, 'mcp.json'), JSON.stringify({ mcpServers: { alpha: { command: 'a' } } }));
  writeFileSync(join(codexHome, 'config.toml'), 'literal-fixture-secret');
  writeFileSync(join(dshHome, 'cordis.patch.yml'), '- {literal-fixture-secret: [');
  const codex = join(directory, 'codex-fails');
  writeFileSync(codex, '#!/bin/sh\nprintf literal-fixture-secret >&2\nexit 1\n', { mode: 0o700 });
  const lines = [];
  const parity = await printMcpParity({ agents: ['pi', 'codex', 'dsh'], source: directory, piHome, codexHome, dshHome },
    line => lines.push(line), { codex, dsh });
  assert.deepEqual(parity.hosts, { pi: ['alpha'] });
  assert.deepEqual(parity.missing, { pi: [] });
  assert.deepEqual(Object.keys(parity.unavailable), ['codex', 'dsh']);
  assert(lines.some(line => line.startsWith('mcp codex: (unavailable;')));
  assert(lines.some(line => line.startsWith('mcp dsh: (unavailable;')));
  assert(!lines.join('\n').includes('literal-fixture-secret'));
});

test('a dynamic MCP condition is inert and reported unavailable', { skip: !dsh && 'native DSH YAML and composer unavailable' }, async t => {
  const dshHome = temp(t);
  writeFileSync(join(dshHome, 'cordis.patch.yml'), `- insert:
    - name: '@deepseek-ai/dsh-mcp-client'
      disabled: !!js '(() => { throw new Error("fixture-secret") })()'
      config: { serverName: alpha }
`);
  const parity = await mcpParity({ agents: ['dsh'], dshHome }, { dsh });
  assert.equal(parity.hosts.dsh, undefined);
  assert.match(parity.unavailable.dsh, /Cannot read DSH MCP declarations/);
  assert.doesNotMatch(parity.unavailable.dsh, /fixture-secret/);
});

const skipWithoutDsh = !dsh && 'native DSH YAML and composer unavailable';

async function declarationProbe(t, text) {
  const root = temp(t);
  const dshHome = join(root, 'dsh');
  const piHome = join(root, 'pi');
  mkdirSync(dshHome);
  mkdirSync(piHome);
  writeFileSync(join(piHome, 'mcp.json'), '{"mcpServers":{"pi-only":{"command":"fixture"}}}');
  const marker = join(root, 'expression-ran');
  const body = text.replaceAll('EXPRESSION', () => JSON.stringify(
    `(() => { process.getBuiltinModule("fs").writeFileSync(${JSON.stringify(marker)}, "fixture-secret"); return {} })()`,
  ));
  const path = join(dshHome, 'cordis.patch.yml');
  writeFileSync(path, body);
  const lines = [];
  const result = await printMcpParity({ agents: ['pi', 'dsh'], source: root, dshHome, piHome },
    line => lines.push(line), { dsh });
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
  assert(!lines.join('\n').includes('fixture-secret'));
  assert.equal(readFileSync(path, 'utf8'), body);
  return result;
}

function assertDshUnavailable(result) {
  assert.deepEqual(result.hosts, { pi: ['pi-only'] });
  assert.deepEqual(result.all, ['pi-only']);
  assert.deepEqual(result.missing, { pi: [] });
  assert.match(result.unavailable.dsh, /Cannot read DSH MCP declarations/);
}

test('expressions controlling an MCP declaration are unavailable, not fabricated server names', { skip: skipWithoutDsh }, async t => {
  const manager = "name: '@deepseek-ai/dsh-mcp-manager'";
  for (const [label, row] of [
    ['row', '!!js EXPRESSION'],
    ['plugin name', 'name: !!js EXPRESSION'],
    ['group metadata', 'name: unrelated\n      group: !!js EXPRESSION'],
    ['manager config', `${manager}\n      config: !!js EXPRESSION`],
    ['servers mapping', `${manager}\n      config: { servers: !!js EXPRESSION }`],
    ['server entry', `${manager}\n      config: { servers: { declared: !!js EXPRESSION } }`],
    ['server enabled', `${manager}\n      config: { servers: { declared: { enabled: !!js EXPRESSION } } }`],
  ]) {
    await subtest(t, label, async child => assertDshUnavailable(await declarationProbe(child, `- insert:\n    - ${row}\n`)));
  }
});

test('literal mapping keys and irrelevant expressions do not change MCP presence', { skip: skipWithoutDsh }, async t => {
  const result = await declarationProbe(t, `- insert:
    - name: '@deepseek-ai/dsh-mcp-manager'
      config:
        servers:
          dynamic: { enabled: true, command: !!js EXPRESSION }
          literal: { enabled: true, dynamic: true }
          off: { enabled: false, command: !!js EXPRESSION }
    - name: unrelated
      disabled: !!js EXPRESSION
      config: !!js EXPRESSION
`);
  assert.deepEqual(result.hosts.dsh, ['dynamic', 'literal']);
  assert.deepEqual(result.unavailable, {});
});

test('native group carriers without an explicit group flag expose only enabled declarations', { skip: skipWithoutDsh }, async t => {
  const result = await declarationProbe(t, `- insert:
    - name: cordis:group
      config:
        - name: '@deepseek-ai/dsh-mcp-client'
          config: { serverName: short }
    - name: '@deepseek-ai/cordis-plugin-group'
      config:
        - name: '@deepseek-ai/dsh-mcp-client'
          config: { serverName: long }
        - name: cordis:include
          disabled: true
          config: !!js EXPRESSION
    - name: '@deepseek-ai/cordis-plugin-group'
      disabled: true
      config: !!js EXPRESSION
    - name: '@deepseek-ai/cordis-plugin-include'
      disabled: true
      config: { path: /nonexistent/fixture.yml }
`);
  assert.deepEqual(result.hosts.dsh, ['long', 'short']);
  assert.deepEqual(result.unavailable, {});
});

test('active includes and indeterminate carriers are unavailable without reading includes', { skip: skipWithoutDsh }, async t => {
  for (const [label, row] of [
    ['short include', 'name: cordis:include\n      config: { path: /nonexistent/fixture.yml }'],
    ['long include', "name: '@deepseek-ai/cordis-plugin-include'\n      config: { path: /nonexistent/fixture.yml }"],
    ['dynamic include', "name: '@deepseek-ai/cordis-plugin-include'\n      disabled: !!js EXPRESSION"],
    ['dynamic group activation', "name: '@deepseek-ai/cordis-plugin-group'\n      disabled: !!js EXPRESSION\n      config: []"],
    ['dynamic group list', 'name: cordis:group\n      config: !!js EXPRESSION'],
    ['malformed group list', 'name: cordis:group\n      config: { bogus: true }'],
  ]) {
    await subtest(t, label, async child => assertDshUnavailable(await declarationProbe(child, `- insert:\n    - ${row}\n`)));
  }
});
