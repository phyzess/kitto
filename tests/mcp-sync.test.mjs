import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshExecutable, loadDshYaml } from '../integration/scoped-dsh/native.ts';
import { dshMcpNames } from '../lib/parity.ts';
import * as localYaml from 'yaml';
import { get, list } from '../lib/ownership.ts';
import { dshMcpRows, piMcpServers, removeDshMcp, syncDshMcp } from '../lib/mcp-sync.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');

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
    yaml = await loadDshYaml(executable);
  } catch {
    yaml = null;
  }
}
const nativeDsh = Boolean(executable && yaml);

test('native DSH yaml is available when the CI job requires it', { skip: !process.env.KITTO_REQUIRE_NATIVE_DSH }, () => {
  assert.equal(nativeDsh, true, 'native DSH and its bundled yaml module must be available');
});

async function temporary(t, prefix = 'kitto-mcp-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
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
const kittoConfigs = (text, yaml) => new Map(yaml.parseDocument(text).toJS()
  .flatMap(item => item.insert ?? [])
  .filter(row => row.id?.startsWith('kitto-mcp-'))
  .map(row => [row.config.serverName, row.config]));

test('Pi MCP source applies the platform overlay and reads private/local files only when opted in', async t => {
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
  assert.deepEqual(linux.servers.map(server => server.name),
    ['context7', 'api', 'plain', 'envServer', 'headerServer']);
  assert.deepEqual(linux.servers[0], {
    name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@4.7.3'],
  });
  assert.deepEqual(linux.servers[1], { name: 'api', transport: 'streamable-http', url: 'https://example.test/mcp' });
  assert.deepEqual(linux.servers[3], {
    name: 'envServer', transport: 'stdio', command: 'env-server', args: [],
    env: { TOKEN: '${credential:TOKEN}' }, expandTemplates: true,
  });
  assert.deepEqual(linux.servers[4], {
    name: 'headerServer', transport: 'streamable-http', url: 'https://example.test/mcp',
    headers: { Authorization: 'Bearer ${credential:TOKEN}' }, expandTemplates: true,
  });
  assert(linux.skipped.some(item => item.name === 'bad/name'));
  assert(!linux.servers.some(server => ['gitlab', 'localOnly', 'codegraph'].includes(server.name)));

  const withPrivate = await piMcpServers(source, 'linux', { includePrivate: true });
  assert.deepEqual(withPrivate.servers.map(server => server.name),
    ['context7', 'api', 'plain', 'envServer', 'headerServer', 'localOnly', 'gitlab']);

  const macos = await piMcpServers(source, 'darwin');
  assert.deepEqual(macos.servers.map(server => server.name),
    ['context7', 'api', 'plain', 'envServer', 'headerServer', 'computer-use']);
});

test('DSH rows use kitto ids, DSH transport names and credential templates', () => {
  assert.deepEqual(dshMcpRows([
    { name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', 'context7'] },
    { name: 'api', transport: 'streamable-http', url: 'https://example.test/mcp' },
    {
      name: 'env', transport: 'stdio', command: 'env-mcp', args: [],
      env: { TOKEN: '${credential:TOKEN}' }, expandTemplates: true,
    },
    {
      name: 'headers', transport: 'streamable-http', url: 'https://example.test/headers',
      headers: { Authorization: 'Bearer ${credential:AUTH}' }, expandTemplates: true,
    },
  ]), [
    {
      id: 'kitto-mcp-context7', name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'context7', transport: 'stdio', command: 'npx', args: ['-y', 'context7'] },
    },
    {
      id: 'kitto-mcp-api', name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'api', transport: 'streamable-http', url: 'https://example.test/mcp' },
    },
    {
      id: 'kitto-mcp-env', name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'env', transport: 'stdio', command: 'env-mcp', args: [],
        env: { TOKEN: '${credential:TOKEN}' }, expandTemplates: true,
      },
    },
    {
      id: 'kitto-mcp-headers', name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'headers', transport: 'streamable-http', url: 'https://example.test/headers',
        headers: { Authorization: 'Bearer ${credential:AUTH}' }, expandTemplates: true,
      },
    },
  ]);
});

test('reference env/headers become DSH credential templates; literal values are skipped', { skip: !yaml }, async t => {
  const literalToken = `ghp_${'a'.repeat(30)}`;
  const openAiToken = `sk-${'b'.repeat(30)}`;
  const source = await sourceFixture(t, {
    envServer: { command: 'env-server', env: { TOKEN: '${TOKEN}', OTHER: '${OTHER_KEY}' } },
    bearerServer: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
    headerServer: { type: 'http', url: 'https://example.test/mcp', headers: { 'X-Api-Key': '${API_KEY}' } },
    literalEnv: { command: 'literal-env', env: { TOKEN: 'plain-literal' } },
    partialEnv: { command: 'partial-env', env: { TOKEN: 'prefix-${TOKEN}' } },
    literalBearer: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer short-token' } },
    secretHeader: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: `Bearer ${literalToken}` } },
    secretArgs: { command: 'npx', args: [`--token=${openAiToken}`] },
    partialHeader: { type: 'http', url: 'https://example.test/mcp', headers: { 'X-Api-Key': 'prefix-${KEY}' } },
    urlTemplate: { type: 'http', url: 'https://example.test/${TENANT}/mcp' },
    urlUserinfo: { type: 'http', url: 'https://user:pass@example.test/mcp' },
    urlQueryToken: { type: 'http', url: 'https://example.test/mcp?access_token=abcd' },
    urlQueryKey: { type: 'http', url: 'https://example.test/mcp?api-key=abcd' },
    urlQuerySafe: { type: 'http', url: 'https://example.test/mcp?tenant=acme' },
    cmdFlag: { command: 'npx', args: ['--api-key', 'abcd'] },
    cmdAssign: { command: 'npx', args: ['TOKEN=abcd'] },
    cmdHeader: { command: 'npx', args: ['--header', 'Authorization: Bearer abcd'] },
  });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');
  const warnings = [];
  const result = await syncDshMcp({ source, dshHome }, { yaml, warn: line => warnings.push(line) });
  assert.equal(result.changed, true);
  const configs = kittoConfigs(await read(path), yaml);
  assert.deepEqual(configs.get('envServer').env, {
    TOKEN: '${credential:TOKEN}', OTHER: '${credential:OTHER_KEY}',
  });
  assert.equal(configs.get('envServer').expandTemplates, true);
  assert.deepEqual(configs.get('bearerServer').headers, { Authorization: 'Bearer ${credential:TOKEN}' });
  assert.deepEqual(configs.get('headerServer').headers, { 'X-Api-Key': '${credential:API_KEY}' });
  assert.equal(configs.get('bearerServer').expandTemplates, true);
  assert.equal(configs.get('headerServer').expandTemplates, true);
  for (const name of ['literalEnv', 'partialEnv', 'literalBearer', 'secretHeader', 'secretArgs', 'partialHeader',
    'urlTemplate', 'urlUserinfo', 'urlQueryToken', 'urlQueryKey', 'cmdFlag', 'cmdAssign', 'cmdHeader']) {
    assert.equal(configs.has(name), false, name);
  }
  assert.equal(configs.get('urlQuerySafe').url, 'https://example.test/mcp?tenant=acme');
  const joined = warnings.join('\n');
  assert.match(joined, /skipped literalEnv \(env\.TOKEN is a literal value; only \$\{VAR\} references are synced\)/);
  assert.match(joined, /skipped partialEnv \(env\.TOKEN is not a whole \$\{VAR\} reference\)/);
  assert.match(joined, /skipped literalBearer \(headers\.Authorization is not a credential reference/);
  assert.match(joined, /skipped secretHeader \(contains a literal secret \(GitHub token\) at headers\.Authorization\)/);
  assert.match(joined, /skipped secretArgs \(contains a literal secret \(openai-style key\) at args\[0\]\)/);
  assert.match(joined, /skipped partialHeader \(headers\.X-Api-Key is not a whole \$\{VAR\} reference\)/);
  assert.match(joined, /skipped urlTemplate \(url contains a credential template/);
  assert.match(joined, /skipped urlUserinfo \(url contains userinfo credentials; only env\/headers references are synced\)/);
  assert.match(joined, /skipped urlQueryToken \(url has a credential-like query parameter/);
  assert.match(joined, /skipped urlQueryKey \(url has a credential-like query parameter/);
  assert.match(joined, /skipped cmdFlag \(args\[1\] looks like a literal credential/);
  assert.match(joined, /skipped cmdAssign \(args\[0\] looks like a literal credential/);
  assert.match(joined, /skipped cmdHeader \(args\[1\] looks like a sensitive header/);
  assert.doesNotMatch(joined, /plain-literal|short-token|ghp_|sk-|user:pass|abcd/);

  const again = await syncDshMcp({ source, dshHome }, { yaml, warn: () => {} });
  assert.equal(again.changed, false);
});

test('sensitive query keys and header flags are refused without values', { skip: !yaml }, async t => {
  const queryKeys = ['sig', 'signature', 'auth', 'apikey', 'api_key', 'access_token',
    'refresh_token', 'credential', 'token', 'key', 'secret', 'password'];
  const servers = {};
  for (const key of queryKeys) {
    servers[`query_${key}`] = { type: 'http', url: `https://example.test/mcp?${key}=abcd` };
  }
  servers.safeQuery = { type: 'http', url: 'https://example.test/mcp?tenant=acme&monkey=1&author=me&design=plain&signal=ok' };
  servers.headerSeparate = { command: 'npx', args: ['-H', 'X-Key: abcd'] };
  servers.headerInline = { command: 'npx', args: ['--header=X-Key: abcd'] };
  servers.headerNameThenValue = { command: 'npx', args: ['--header', 'X-Key', 'abcd'] };
  servers.headerInlineNameThenValue = { command: 'npx', args: ['--header=X-Key', 'abcd'] };
  servers.headerSafe = { command: 'npx', args: ['-H', 'Accept: application/json'] };
  servers.headerValue = { command: 'npx', args: ['-H', 'X-Custom: some-long-unbroken-value-1234'] };
  servers.flagToken = { command: 'npx', args: ['--token', 'abcd'] };
  servers.flagSecret = { command: 'npx', args: ['--secret=abcd'] };
  const source = await sourceFixture(t, servers);
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const warnings = [];
  await syncDshMcp({ source, dshHome }, { yaml, warn: line => warnings.push(line) });
  const configs = kittoConfigs(await read(join(dshHome, 'cordis.patch.yml')), yaml);
  assert.deepEqual([...configs.keys()], ['safeQuery', 'headerSafe']);
  assert.equal(configs.get('safeQuery').url, 'https://example.test/mcp?tenant=acme&monkey=1&author=me&design=plain&signal=ok');
  const joined = warnings.join('\n');
  for (const key of queryKeys) {
    assert.match(joined, new RegExp(`skipped query_${key} \\(url has a credential-like query parameter`), key);
  }
  assert.match(joined, /skipped headerSeparate \(args\[1\] looks like a sensitive header/);
  assert.match(joined, /skipped headerInline \(args\[0\] looks like a sensitive header/);
  assert.match(joined, /skipped headerNameThenValue \(args\[1\] looks like a sensitive header/);
  assert.match(joined, /skipped headerInlineNameThenValue \(args\[0\] looks like a sensitive header/);
  assert.match(joined, /skipped headerValue \(args\[1\] looks like a credential header value/);
  assert.match(joined, /skipped flagToken \(args\[1\] looks like a literal credential/);
  assert.match(joined, /skipped flagSecret \(args\[0\] looks like a literal credential/);
  assert.doesNotMatch(joined, /abcd/);
});

test('private and local MCP sources are opt-in for DSH sync', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, {
    context7: { command: 'npx' },
    shared: { command: 'shared', args: ['base'] },
  });
  await writeJson(join(source, 'config/pi/local/mcp.json'), { mcpServers: {
    shared: { args: ['local'] },
    localOnly: { command: 'local', env: { LOCAL_TOKEN: '${LOCAL_TOKEN}' } },
  } });
  await writeJson(join(source, 'config/pi/mcp.private.json'), { mcpServers: {
    privateApi: { type: 'http', url: 'https://private.test/mcp', headers: { Authorization: 'Bearer ${PRIVATE_TOKEN}' } },
  } });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');

  await syncDshMcp({ source, dshHome }, { yaml, warn: () => {} });
  let configs = kittoConfigs(await read(path), yaml);
  assert.deepEqual([...configs.keys()], ['context7', 'shared']);
  assert.deepEqual(configs.get('shared').args, ['base']);

  const included = await syncDshMcp({ source, dshHome, includePrivate: true }, { yaml, warn: () => {} });
  assert.equal(included.changed, true);
  configs = kittoConfigs(await read(path), yaml);
  assert.deepEqual([...configs.keys()], ['context7', 'shared', 'localOnly', 'privateApi']);
  assert.deepEqual(configs.get('shared').args, ['local']);
  assert.deepEqual(configs.get('localOnly').env, { LOCAL_TOKEN: '${credential:LOCAL_TOKEN}' });
  assert.deepEqual(configs.get('privateApi').headers, { Authorization: 'Bearer ${credential:PRIVATE_TOKEN}' });

  const excluded = await syncDshMcp({ source, dshHome, includePrivate: false }, { yaml, warn: () => {} });
  assert.equal(excluded.changed, true);
  configs = kittoConfigs(await read(path), yaml);
  assert.deepEqual([...configs.keys()], ['context7', 'shared']);
});

test('removeDshMcp removes credential template rows', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, {
    envServer: { command: 'env-server', env: { TOKEN: '${TOKEN}' } },
    headerServer: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
  });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');
  await syncDshMcp({ source, dshHome }, { yaml, warn: () => {} });
  const preview = await removeDshMcp({ dshHome }, { yaml, dryRun: true, log: () => {} });
  assert.deepEqual(preview.removed, ['envServer', 'headerServer']);
  await removeDshMcp({ dshHome }, { yaml, log: () => {} });
  const after = await read(path);
  assert.doesNotMatch(after, /kitto-mcp-|credential:/);
});

test('KITTO_NO_MCP_SYNC disables the sync', async t => {
  process.env.KITTO_NO_MCP_SYNC = '1';
  t.onTestFinished(() => { delete process.env.KITTO_NO_MCP_SYNC; });
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
  const profileHome = join(dshHome, 'profiles', 'web');
  await mkdir(profileHome, { recursive: true });
  await writeFile(join(profileHome, 'cordis.patch.yml'), '- insert:\n    - id: agent-instructions\n      name: fixture-instructions\n');
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

  const flow = '[{ insert: [{ id: foreign }] }]\n';
  await writeFile(path, flow);
  await assert.rejects(syncDshMcp({ source, dshHome }, { yaml }), /flow-style YAML/);
  assert.equal(await read(path), flow);
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

test('dry-run previews additions and removals without writing', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, { context7: { command: 'npx' } });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');
  const logs = [];
  const preview = await syncDshMcp({ source, dshHome }, { yaml, dryRun: true, log: line => logs.push(line) });
  assert.equal(preview.changed, true);
  assert.equal(await exists(path), false);
  assert(logs.some(line => /would update .* \(1 server\)/.test(line)));

  const before = '# untouched\n[]\n';
  await writeFile(path, before);
  const second = await syncDshMcp({ source, dshHome }, { yaml, dryRun: true });
  assert.equal(second.changed, true);
  assert.equal(await read(path), before);
});

test('a trailing document-end marker stays after the managed rows', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, { context7: { command: 'npx' } });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');
  await writeFile(path, '# keep\n- insert:\n    - id: foreign\n      name: example\n...  # end marker\n# tail comment\n\n');
  await syncDshMcp({ source, dshHome }, { yaml });
  const after = await read(path);
  assert.match(after, /# keep/);
  assert.match(after, /id: foreign/);
  assert.match(after, /kitto-mcp-context7/);
  assert(after.endsWith('...  # end marker\n# tail comment\n\n'));
  assert.equal(after.match(/^\.\.\./gm).length, 1);
  assert.equal(yaml.parseDocument(after).errors.length, 0);
  assert(Array.isArray(yaml.parseDocument(after).toJS()));

  await writeJson(join(source, 'config/pi/mcp.json'), { mcpServers: {} });
  await syncDshMcp({ source, dshHome }, { yaml });
  const cleaned = await read(path);
  assert.doesNotMatch(cleaned, /kitto-mcp-/);
  assert.match(cleaned, /# keep/);
  assert.match(cleaned, /id: foreign/);
  assert(cleaned.endsWith('...  # end marker\n# tail comment\n\n'));
  assert.equal(yaml.parseDocument(cleaned).errors.length, 0);

  const emptyHome = await temporary(t, 'kitto-mcp-dsh-');
  const emptyPath = join(emptyHome, 'cordis.patch.yml');
  await writeFile(emptyPath, '...\n');
  await syncDshMcp({ source: await sourceFixture(t, { context7: { command: 'npx' } }), dshHome: emptyHome }, { yaml });
  const fromMarker = await read(emptyPath);
  assert.match(fromMarker, /kitto-mcp-context7/);
  assert(fromMarker.endsWith('...\n'));
  assert.equal(yaml.parseDocument(fromMarker).errors.length, 0);
});

test('an indented ... inside a block scalar is content, not a document end', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, { context7: { command: 'npx' } });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');
  await writeFile(path, '- insert:\n    - id: foreign\n      name: example\n      config:\n        text: |\n          ...\n');
  await syncDshMcp({ source, dshHome }, { yaml });
  const after = await read(path);
  assert.match(after, /text: \|\n          \.\.\.\n/);
  assert.match(after, /kitto-mcp-context7/);
  assert.equal(yaml.parseDocument(after).toJS()[0].insert[0].config.text, '...\n');
  assert.equal(yaml.parseDocument(after).errors.length, 0);

  await writeJson(join(source, 'config/pi/mcp.json'), { mcpServers: {} });
  await syncDshMcp({ source, dshHome }, { yaml });
  const cleaned = await read(path);
  assert.match(cleaned, /text: \|\n          \.\.\.\n/);
  assert.doesNotMatch(cleaned, /kitto-mcp-/);
});

test('a top-level null patch is treated as an empty list', { skip: !yaml }, async t => {
  for (const [label, content] of [['null', 'null\n'], ['tilde', '~\n'], ['comment', '# keep\nnull\n']]) {
    const source = await sourceFixture(t, { context7: { command: 'npx' } });
    const dshHome = await temporary(t, 'kitto-mcp-dsh-');
    const path = join(dshHome, 'cordis.patch.yml');
    await writeFile(path, content);
    await syncDshMcp({ source, dshHome }, { yaml });
    const after = await read(path);
    assert.doesNotMatch(after, /^(?:null|~)[ \t]*$/m, label);
    assert.match(after, /kitto-mcp-context7/, label);
    const parsed = yaml.parseDocument(after);
    assert.equal(parsed.errors.length, 0, label);
    assert(Array.isArray(parsed.toJS()), label);
    if (label === 'comment') assert.match(after, /# keep/);
    const info = await stat(path);
    assert.equal((await syncDshMcp({ source, dshHome }, { yaml, log: () => {} })).changed, false, label);
    assert.equal((await stat(path)).ino, info.ino, label);
  }
});

test('removing a row whose alias would be left unresolved is refused', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, { context7: { command: 'npx' } });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');
  const before = '- &managed\n  insert:\n    - id: kitto-mcp-stale\n      name: stale\n- insert:\n    - *managed\n';
  await writeFile(path, before);
  await assert.rejects(syncDshMcp({ source, dshHome }, { yaml }), /Refusing to write the DSH home patch: Unresolved alias/);
  assert.equal(await read(path), before);
});

test('profile patches and mcp-manager servers count as declared names', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, {
    context7: { command: 'npx' },
    alpha: { command: 'alpha' },
    beta: { command: 'beta' },
    delta: { command: 'delta' },
    gamma: { command: 'gamma' },
    epsilon: { command: 'epsilon' },
  });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');
  const profileDir = join(dshHome, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  const profilePath = join(profileDir, 'cordis.patch.yml');
  await writeFile(profilePath, yaml.stringify([
    { insert: [{ id: 'profile-a', name: 'example' }] },
    { insert: [{ id: 'profile-b', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'alpha' } }] },
    { insert: [{ id: 'profile-manager', name: '@deepseek-ai/dsh-mcp-manager', config: { servers: {
      epsilon: { transport: 'stdio', command: 'epsilon' },
    } } }] },
  ], { lineWidth: 0 }));
  await writeFile(path, yaml.stringify([
    { insert: [{ id: 'home-client', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'context7' } }] },
    { id: 'mcp-manager', config: { servers: {
      beta: { transport: 'stdio', command: 'beta' },
      gamma: { transport: 'stdio', command: 'gamma', enabled: false },
    } } },
    { insert: [{ id: 'home-other', name: 'example' }] },
  ], { lineWidth: 0 }));

  const warnings = [];
  const result = await syncDshMcp({ source, dshHome }, { yaml, warn: line => warnings.push(line) });
  assert.equal(result.changed, true);
  assert(warnings.some(line => /skipped context7 \(already declared in .*cordis\.patch\.yml\)/.test(line)));
  assert(warnings.some(line => /skipped alpha \(already declared in .*profiles\/web\/cordis\.patch\.yml\)/.test(line)));
  assert(warnings.some(line => /skipped beta \(already declared in .*cordis\.patch\.yml \(mcp-manager\)\)/.test(line)));
  assert(warnings.some(line => /skipped epsilon \(already declared in .*profiles\/web\/cordis\.patch\.yml \(mcp-manager\)\)/.test(line)));
  const after = await read(path);
  assert.match(after, /kitto-mcp-delta/);
  assert.match(after, /kitto-mcp-gamma/);
  assert.doesNotMatch(after, /kitto-mcp-context7/);
  assert.doesNotMatch(after, /kitto-mcp-alpha/);
  assert.doesNotMatch(after, /kitto-mcp-beta/);
  assert.doesNotMatch(after, /kitto-mcp-epsilon/);
  assert.equal(after.match(/serverName: context7/g).length, 1);
  assert.equal(yaml.parseDocument(after).errors.length, 0);

  const again = await syncDshMcp({ source, dshHome }, { yaml, warn: () => {} });
  assert.equal(again.changed, false);
  assert.equal(await read(path), after);
});

test('removeDshMcp previews and removes only Kitto-owned rows without a source', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, { context7: { command: 'npx' }, api: { type: 'http', url: 'https://example.test/mcp' } });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');
  await writeFile(path, '# keep\n- id: agent-instructions\n  config:\n    enabled: !!js process.env.KITTO_INSTRUCTIONS\n');
  await syncDshMcp({ source, dshHome }, { yaml });
  const before = await read(path);

  const logs = [];
  const preview = await removeDshMcp({ dshHome }, { yaml, dryRun: true, log: line => logs.push(line) });
  assert.equal(preview.changed, true);
  assert.deepEqual(preview.removed, ['context7', 'api']);
  assert(logs.some(line => /would remove 2 Kitto MCP servers/.test(line)));
  assert.equal(await read(path), before);

  const applied = await removeDshMcp({ dshHome }, { yaml });
  assert.equal(applied.changed, true);
  const after = await read(path);
  assert.doesNotMatch(after, /kitto-mcp-/);
  assert.match(after, /# keep/);
  assert.match(after, /!!js process\.env\.KITTO_INSTRUCTIONS/);
  assert.equal(yaml.parseDocument(after).errors.length, 0);

  const again = await removeDshMcp({ dshHome }, { yaml, log: () => {} });
  assert.equal(again.changed, false);
});

test('multiple Kitto insert items are normalized and stale rows removed', { skip: !yaml }, async t => {
  const source = await sourceFixture(t, { alpha: { command: 'next' } });
  const dshHome = await temporary(t, 'kitto-mcp-dsh-');
  const path = join(dshHome, 'cordis.patch.yml');
  const stale = (name, command) => ({ insert: [{
    id: `kitto-mcp-${name}`, name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: name, transport: 'stdio', command, args: [] },
  }] });
  await writeFile(path, yaml.stringify([
    { insert: [{ id: 'foreign', name: 'example' }] },
    stale('alpha', 'old'),
    stale('beta', 'old'),
  ], { lineWidth: 0 }) + '...  # end marker\n# tail comment\n\n');
  await syncDshMcp({ source, dshHome }, { yaml });
  const after = await read(path);
  assert.equal(after.match(/kitto-mcp-alpha/g).length, 1);
  assert.doesNotMatch(after, /kitto-mcp-beta/);
  assert.match(after, /command: next/);
  assert.match(after, /id: foreign/);
  assert(after.endsWith('...  # end marker\n# tail comment\n\n'));
  assert.equal(yaml.parseDocument(after).errors.length, 0);
  assert(Array.isArray(yaml.parseDocument(after).toJS()));
});

test('removeDshMcp warns and keeps unreadable patch shapes', { skip: !yaml }, async t => {
  const cases = [
    ['invalid', '- insert: [\n'],
    ['flow', '[{ insert: [{ id: foreign }] }]\n'],
    ['mixed', '- insert:\n    - id: kitto-mcp-old\n    - id: foreign\n'],
    ['mapping', 'serverName: context7\n'],
  ];
  for (const [label, content] of cases) {
    const dshHome = await temporary(t, 'kitto-mcp-dsh-');
    const path = join(dshHome, 'cordis.patch.yml');
    await writeFile(path, content);
    const warnings = [];
    const result = await removeDshMcp({ dshHome }, { yaml, warn: line => warnings.push(line) });
    assert.equal(result.changed, false, label);
    assert(warnings.some(line => /skipped removal/.test(line)), label);
    assert.equal(await read(path), content, label);
  }
});

test('maintain remove cleans Kitto MCP rows for a DSH home', { skip: !nativeDsh, timeout: 60_000 }, async t => {
  const source = await sourceFixture(t, { context7: { command: 'npx' } });
  const home = await temporary(t, 'kitto-mcp-native-');
  const dshHome = join(home, '.dsh');
  const kittoHome = join(home, 'kitto');
  const path = join(dshHome, 'cordis.patch.yml');
  await mkdir(dshHome, { recursive: true });
  await mkdir(kittoHome, { recursive: true });
  await writeFile(path, '# keep\n- insert:\n    - id: foreign\n      name: example\n');
  await syncDshMcp({ source, dshHome }, { yaml });
  const statePath = join(kittoHome, 'state.json');
  await writeFile(statePath, JSON.stringify({
    schema: 1, ready: true, detached: false, removing: false, removedAgents: [],
    source, agents: ['dsh'], dshProfile: 'web',
    agentsHome: join(home, '.agents'), piHome: join(home, '.pi'), codexHome: join(home, '.codex'),
    dshHome, version: '0.2.1',
  }, null, 2) + '\n');
  const run = (...args) => execFileSync(process.execPath, [join(dist, 'bin/maintain.mjs'), 'remove', ...args], {
    encoding: 'utf8',
    timeout: 45_000,
    env: {
      ...process.env,
      HOME: home,
      KITTO_HOME: kittoHome,
      DSH_HOME: dshHome,
      DSH_AGENTS_HOME: join(home, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      PATH: `${dirname(executable)}${delimiter}${process.env.PATH}`,
    },
  });

  const before = await read(path);
  const stateBefore = await read(statePath);
  assert.match(run(), /would remove 1 Kitto MCP server/);
  assert.equal(await read(path), before);
  assert.equal(await read(statePath), stateBefore);

  run('--apply');
  const after = await read(path);
  assert.doesNotMatch(after, /kitto-mcp-/);
  assert.match(after, /# keep/);
  assert.match(after, /id: foreign/);
  assert.equal(JSON.parse(await read(statePath)).detached, true);
});

test('maintain remove continues when the home patch cannot be updated', { skip: !nativeDsh, timeout: 60_000 }, async t => {
  const source = await sourceFixture(t, { context7: { command: 'npx' } });
  const home = await temporary(t, 'kitto-mcp-native-');
  const dshHome = join(home, '.dsh');
  const kittoHome = join(home, 'kitto');
  const path = join(dshHome, 'cordis.patch.yml');
  await mkdir(dshHome, { recursive: true });
  await mkdir(kittoHome, { recursive: true });
  const broken = '- insert: [\n';
  await writeFile(path, broken);
  const statePath = join(kittoHome, 'state.json');
  await writeFile(statePath, JSON.stringify({
    schema: 1, ready: true, detached: false, removing: false, removedAgents: [],
    source, agents: ['dsh'], dshProfile: 'web',
    agentsHome: join(home, '.agents'), piHome: join(home, '.pi'), codexHome: join(home, '.codex'),
    dshHome, version: '0.2.1',
  }, null, 2) + '\n');
  const result = spawnSync(process.execPath, [join(dist, 'bin/maintain.mjs'), 'remove', '--apply'], {
    encoding: 'utf8',
    timeout: 45_000,
    env: {
      ...process.env,
      HOME: home,
      KITTO_HOME: kittoHome,
      DSH_HOME: dshHome,
      DSH_AGENTS_HOME: join(home, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      PATH: `${dirname(executable)}${delimiter}${process.env.PATH}`,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /skipped removal/);
  assert.equal(await read(path), broken);
  assert.equal(JSON.parse(await read(statePath)).detached, true);
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

test('the native DSH loader accepts credential template rows', { skip: !nativeDsh, timeout: 60_000 }, async t => {
  const source = await sourceFixture(t, {
    envServer: { command: 'env-server', env: { TOKEN: '${TOKEN}' } },
    headerServer: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
  });
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
  assert.match(output, /id: kitto-mcp-envServer/);
  assert.match(output, /id: kitto-mcp-headerServer/);
  assert.match(output, /expandTemplates: true/);
  assert.match(output, /\$\{credential:TOKEN\}/);
  assert.match(output, /Bearer \$\{credential:TOKEN\}/);
  assert.doesNotMatch(output, /literal secret/i);
});

async function ledgerFixture(t) {
  const source = await sourceFixture(t, { alpha: { command: 'alpha-mcp' }, beta: { command: 'beta-mcp' } });
  const home = await temporary(t, 'kitto-mcp-ledger-');
  const dshHome = join(home, '.dsh');
  await mkdir(dshHome, { recursive: true });
  const path = join(dshHome, 'cordis.patch.yml');
  const messages = [];
  const options = { yaml: localYaml, log: () => {}, warn: message => messages.push(message) };
  return { state: { schema: 2, source, dshHome }, path, messages, options };
}

test('DSH sync records owned rows with fingerprints; preview records nothing', async t => {
  const f = await ledgerFixture(t);
  await syncDshMcp(f.state, { ...f.options, dryRun: true });
  assert.deepEqual(list(f.state, 'mcp', 'dsh'), []);
  await syncDshMcp(f.state, f.options);
  assert.deepEqual(list(f.state, 'mcp', 'dsh', 'owned').map(entry => entry.name), ['kitto-mcp-alpha', 'kitto-mcp-beta']);
  assert.match(get(f.state, 'mcp', 'dsh', 'kitto-mcp-alpha').hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(f.messages, []);
});

test('DSH sync preserves a row changed outside Kitto and warns', async t => {
  const f = await ledgerFixture(t);
  await syncDshMcp(f.state, f.options);
  const edited = (await read(f.path)).replace('alpha-mcp', 'user-alpha');
  await writeFile(f.path, edited);
  const recorded = get(f.state, 'mcp', 'dsh', 'kitto-mcp-alpha').hash;
  await syncDshMcp(f.state, f.options);
  assert.match(await read(f.path), /user-alpha/);
  assert.match(f.messages.join('\n'), /preserved kitto-mcp-alpha/);
  assert.equal(get(f.state, 'mcp', 'dsh', 'kitto-mcp-alpha').hash, recorded);
  await syncDshMcp(f.state, f.options);
  assert.equal((await read(f.path)).match(/kitto-mcp-alpha/g).length, 1, 'the preserved row is never duplicated');
});

test('DSH removal keeps a changed row and releases the rest', async t => {
  const f = await ledgerFixture(t);
  await syncDshMcp(f.state, f.options);
  await writeFile(f.path, (await read(f.path)).replace('beta-mcp', 'user-beta'));
  await removeDshMcp(f.state, { ...f.options, dryRun: true });
  assert.equal(list(f.state, 'mcp', 'dsh').length, 2, 'preview leaves the ledger alone');
  await removeDshMcp(f.state, f.options);
  const after = await read(f.path);
  assert.doesNotMatch(after, /kitto-mcp-alpha/);
  assert.match(after, /kitto-mcp-beta/);
  assert.match(f.messages.join('\n'), /preserved kitto-mcp-beta/);
  assert.deepEqual(list(f.state, 'mcp', 'dsh').map(entry => entry.name), ['kitto-mcp-beta']);
});

test('DSH rows without a ledger entry keep the namespace-only behavior', async t => {
  const f = await ledgerFixture(t);
  await syncDshMcp(f.state, f.options);
  const legacy = { schema: 2, source: f.state.source, dshHome: f.state.dshHome };
  await writeFile(f.path, (await read(f.path)).replace('alpha-mcp', 'user-alpha'));
  await syncDshMcp(legacy, f.options);
  assert.doesNotMatch(await read(f.path), /user-alpha/);
  assert.deepEqual(f.messages, []);
  assert.equal(list(legacy, 'mcp', 'dsh', 'owned').length, 2);
});
