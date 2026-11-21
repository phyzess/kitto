import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { dshExecutable } from '../lib/scope-dsh.mjs';
import { importFromDsh } from '../integration/scoped-dsh/native.mjs';
import { dshMcpNames } from '../lib/parity.mjs';
import { dshMcpRows, piMcpServers, syncDshMcp } from '../lib/mcp-sync.mjs';

async function executablePath() {
  try {
    return await dshExecutable();
  } catch {
    return null;
  }
}

const executable = await executablePath();
let yaml = null;
if (executable) {
  try {
    yaml = await importFromDsh(executable, 'yaml');
  } catch {
    yaml = null;
  }
}
const nativeDsh = Boolean(executable && yaml);

async function temporary(t, prefix = 'kitto-mcp-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

async function sourceFixture(t, servers, { linux, macos } = {}) {
  const source = await temporary(t, 'kitto-mcp-source-');
  await writeJson(join(source, 'config/pi/mcp.json'), { mcpServers: servers });
  if (linux !== undefined) await writeJson(join(source, 'config/pi/platform/linux/mcp.json'), { mcpServers: linux });
  if (macos !== undefined) await writeJson(join(source, 'config/pi/platform/macos/mcp.json'), { mcpServers: macos });
  return source;
}

const read = path => readFile(path, 'utf8');
const exists = async path => {
  try { await access(path); return true; } catch { return false; }
};
const conflictRow = serverName => ({
  insert: [{ id: `mcp-${serverName}`, name: '@deepseek-ai/dsh-mcp-client', config: { serverName, transport: 'stdio', command: serverName } }],
});

test('Pi MCP source applies the platform overlay and ignores private/local files', async t => {
  const source = await sourceFixture(t, {
    _comment: 'not a server',
    context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.7.3'], directTools: true, lifecycle: 'lazy' },
    codegraph: { command: 'codegraph', args: ['serve', '--mcp'], lifecycle: 'lazy' },
    api: { type: 'http', url: 'https://example.test/mcp', toolExposure: 'auto' },
    plain: { command: 'plain' },
    envServer: { command: 'env-server', env: { TOKEN: '${TOKEN}' } },
    headerServer: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
    'bad/name': { command: 'bad' },
  }, {
    linux: { codegraph: { enabled: false } },
    macos: { codegraph: { enabled: false }, 'computer-use': { command: 'npx', args: ['computer-use'] } },
  });
  await writeJson(join(source, 'config/pi/mcp.private.json'), { mcpServers: { gitlab: { url: 'https://example.test/mcp' } } });
  await writeJson(join(source, 'config/pi/local/mcp.json'), { mcpServers: { localOnly: { command: 'local' } } });

  const linux = await piMcpServers(source, 'linux');
  assert.deepEqual(linux.servers.map(server => server.name), ['context7', 'api', 'plain']);
  assert.deepEqual(linux.servers[0], {
    name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@4.7.3'],
  });
  assert.deepEqual(linux.servers[1], { name: 'api', transport: 'streamable-http', url: 'https://example.test/mcp' });
  assert(linux.skipped.some(item => item.name === 'envServer' && /env/.test(item.reason)));
  assert(linux.skipped.some(item => item.name === 'headerServer' && /headers/.test(item.reason)));
  assert(linux.skipped.some(item => item.name === 'bad/name'));
  assert(!linux.servers.some(server => ['gitlab', 'localOnly', 'codegraph'].includes(server.name)));

  const macos = await piMcpServers(source, 'darwin');
  assert.deepEqual(macos.servers.map(server => server.name), ['context7', 'api', 'plain', 'computer-use']);
});

test('DSH rows use kitto ids and the DSH transport names', () => {
  assert.deepEqual(dshMcpRows([
    { name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', 'context7'] },
    { name: 'api', transport: 'streamable-http', url: 'https://example.test/mcp' },
  ]), [
    {
      id: 'kitto-mcp-context7', name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'context7', transport: 'stdio', command: 'npx', args: ['-y', 'context7'] },
    },
    {
      id: 'kitto-mcp-api', name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'api', transport: 'streamable-http', url: 'https://example.test/mcp' },
    },
  ]);
});

test('servers with env or headers are warned about and left out of the DSH patch', async t => {
  const source = await sourceFixture(t, {
    envServer: { command: 'env-server', env: { TOKEN: '${TOKEN}' } },
    headerServer: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
  });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const warnings = [];
  const result = await syncDshMcp({ source, dshHome }, { warn: line => warnings.push(line) });
  assert.equal(result.changed, false);
  assert.equal(await exists(join(dshHome, 'cordis.patch.yml')), false);
  assert(warnings.some(line => /skipped envServer \(env is not synced\)/.test(line)));
  assert(warnings.some(line => /skipped headerServer \(headers is not synced\)/.test(line)));
});

test('KITTO_NO_MCP_SYNC disables the sync', async t => {
  process.env.KITTO_NO_MCP_SYNC = '1';
  t.after(() => { delete process.env.KITTO_NO_MCP_SYNC; });
  const lines = [];
  const result = await syncDshMcp({ source: '/missing', dshHome: '/missing' }, { log: line => lines.push(line) });
  assert.equal(result.disabled, true);
  assert.match(lines.join('\n'), /KITTO_NO_MCP_SYNC=1/);
});

test('sync preserves unrelated YAML, comments and !!js, then leaves a clean file alone', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, {
    context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.7.3'] },
    api: { type: 'http', url: 'https://example.test/mcp' },
  });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');
  const before = `# Home patch comments stay.
- insert:
    - id: mcp-codegraph
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: codegraph

- id: agent-instructions
  config:
    enabled: !!js process.env.KITTO_INSTRUCTIONS
`;
  await writeFile(path, before);

  const first = await syncDshMcp({ source, dshHome }, { yaml });
  assert.equal(first.changed, true);
  const after = await read(path);
  assert(after.startsWith(before.trimEnd()));
  assert.match(after, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(after, /# Home patch comments stay\./);
  assert.match(after, /!!js process\.env\.KITTO_INSTRUCTIONS/);
  assert.match(after, /serverName: codegraph/);
  const parsed = yaml.parseDocument(after);
  assert.equal(parsed.errors.length, 0);
  const values = parsed.toJS();
  assert.deepEqual(values.flatMap(item => item.insert ?? []).filter(row => row.id?.startsWith('kitto-mcp-')).map(row => row.config.serverName), ['context7', 'api']);
  assert.deepEqual(values.flatMap(item => item.insert ?? []).filter(row => row.id === 'mcp-codegraph').map(row => row.config.serverName), ['codegraph']);
  assert.deepEqual(await dshMcpNames(dshHome), ['api', 'codegraph', 'context7']);

  const info = await stat(path);
  const logs = [];
  const second = await syncDshMcp({ source, dshHome }, { yaml, log: line => logs.push(line) });
  assert.equal(second.changed, false);
  assert.equal((await stat(path)).ino, info.ino);
  assert.equal(await read(path), after);
  assert(logs.some(line => /up to date/.test(line)));
});

test('sync removes only stale kitto rows and keeps foreign entries', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, { alpha: { command: 'alpha' }, beta: { command: 'beta' } });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');
  await writeFile(path, `# keep
- insert:
    - id: foreign
      name: example
`);
  await syncDshMcp({ source, dshHome }, { yaml });
  let after = await read(path);
  assert.match(after, /kitto-mcp-alpha/);
  assert.match(after, /kitto-mcp-beta/);
  assert.match(after, /# keep/);
  assert.match(after, /id: foreign/);

  await writeJson(join(source, 'config/pi/mcp.json'), { mcpServers: { alpha: { command: 'alpha' } } });
  await syncDshMcp({ source, dshHome }, { yaml });
  after = await read(path);
  assert.match(after, /kitto-mcp-alpha/);
  assert.doesNotMatch(after, /kitto-mcp-beta/);
  assert.match(after, /# keep/);
  assert.match(after, /id: foreign/);
  assert.equal(yaml.parseDocument(after).errors.length, 0);

  await writeJson(join(source, 'config/pi/mcp.json'), { mcpServers: {} });
  await syncDshMcp({ source, dshHome }, { yaml });
  after = await read(path);
  assert.doesNotMatch(after, /kitto-mcp-/);
  assert.match(after, /id: foreign/);
  assert.equal(yaml.parseDocument(after).errors.length, 0);
});

test('a serverName declared outside Kitto is skipped, never duplicated', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, { context7: { command: 'npx' }, alpha: { command: 'alpha' } });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');
  const foreign = yaml.stringify([conflictRow('context7')], { lineWidth: 0 });
  await writeFile(path, foreign);
  const warnings = [];
  const result = await syncDshMcp({ source, dshHome }, { yaml, warn: line => warnings.push(line) });
  assert.equal(result.changed, true);
  assert(warnings.some(line => /skipped context7 \(already declared in .*cordis\.patch\.yml\)/.test(line)));
  const after = await read(path);
  assert.equal(after.match(/serverName: context7/g).length, 1);
  assert.match(after, /kitto-mcp-alpha/);

  const onlyConflict = await sourceFixture(t, { context7: { command: 'npx' } });
  const foreignOnlyHome = await temporary(t, 'kitto-mcp-dsh-');
  const foreignOnly = join(foreignOnlyHome, 'cordis.patch.yml');
  await writeFile(foreignOnly, yaml.stringify([conflictRow('context7')], { lineWidth: 0 }));
  const unchanged = await read(foreignOnly);
  const empty = await syncDshMcp({ source: onlyConflict, dshHome: foreignOnlyHome }, { yaml, warn: () => {} });
  assert.equal(empty.changed, false);
  assert.equal(await read(foreignOnly), unchanged);
});

test('invalid YAML, mixed kitto rows and non-sequence patches are rejected without writes', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, { context7: { command: 'npx' } });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');

  await writeFile(path, '- insert: [\n');
  await assert.rejects(syncDshMcp({ source, dshHome }, { yaml }), /not valid YAML/);
  assert.equal(await read(path), '- insert: [\n');

  const mixed = '- insert:\n    - id: kitto-mcp-old\n    - id: mcp-foreign\n';
  await writeFile(path, mixed);
  await assert.rejects(syncDshMcp({ source, dshHome }, { yaml }), /mixes kitto-mcp-\* rows/);
  assert.equal(await read(path), mixed);

  const mapping = 'serverName: context7\n';
  await writeFile(path, mapping);
  await assert.rejects(syncDshMcp({ source, dshHome }, { yaml }), /top-level YAML sequence/);
  assert.equal(await read(path), mapping);
});

test('an empty flow-style home patch becomes a block sequence', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, { context7: { command: 'npx' } });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');
  await writeFile(path, '# empty for now\n[]\n');
  await syncDshMcp({ source, dshHome }, { yaml });
  const after = await read(path);
  assert.match(after, /# empty for now/);
  const values = yaml.parseDocument(after).toJS();
  assert(Array.isArray(values));
  assert.deepEqual(values.filter(item => item.insert?.[0]?.id === 'kitto-mcp-context7').length, 1);
});

test('the native DSH loader accepts the synced home patch', { skip: !nativeDsh, timeout: 60_000 }, async t => {
  const source = await sourceFixture(t, { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.7.3'] } });
  const home = await temporary(t, 'kitto-mcp-native-');
  const dshHome = join(home, '.dsh');
  await syncDshMcp({ source, dshHome }, { yaml });
  const output = execFileSync(executable, ['web', '--dump-config'], {
    encoding: 'utf8',
    timeout: 45_000,
    env: {
      ...process.env,
      HOME: home,
      DSH_HOME: dshHome,
      DSH_AGENTS_HOME: join(home, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      PATH: `${dirname(executable)}${delimiter}${process.env.PATH}`,
    },
  });
  assert.match(output, /id: kitto-mcp-context7/);
  assert.match(output, /serverName: context7/);
  assert.match(output, /transport: stdio/);
});
