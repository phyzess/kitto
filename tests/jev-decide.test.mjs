import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hosts } from '../lib/host-pins.mjs';

const script = fileURLToPath(new URL('../skills/jev-decide/scripts/jev.mjs', import.meta.url));
const goEndpoint = 'https://opencode.ai/inference/go/systemone/v1/systemone';
const questions = { decision: { type: 'noul', instructions: 'Synthetic test' } };
const questionText = JSON.stringify(questions);
const state = 'Synthetic state\n';
const inline = ['--state', state, '--questions', questionText];
const noKey = 'jev: no usable OpenCode key: set OPENCODE_API_KEY or OPENCODE_GO_API_KEY explicitly, or check the DSH credential store\n';
const stub = `
  import fs from 'node:fs/promises';
  import { syncBuiltinESMExports } from 'node:module';
  if (process.env.TEST_FORBID_STORE_IO) {
    for (const method of ['open', 'readFile']) {
      const original = fs[method];
      fs[method] = (path, ...args) => {
        if (String(path).endsWith('.credentials.yaml')) process.stderr.write('Unexpected credential file access\\n');
        return original(path, ...args);
      };
    }
    syncBuiltinESMExports();
  }
  globalThis.fetch = async (url, init) => {
    const status = Number(process.env.TEST_HTTP_STATUS || 200);
    const body = JSON.parse(init.body);
    if (status !== 200) {
      // A hostile endpoint may reflect both the authorization header and the input.
      return new Response(JSON.stringify({ authorization: init.headers.authorization, ...body }), { status });
    }
    return new Response(JSON.stringify({ url, method: init.method, headers: init.headers, body }));
  };
`;
const preload = ['--import', `data:text/javascript,${encodeURIComponent(stub)}`];

const installDir = process.env.DSH_INSTALL_DIR;
const dshAvailable = (() => {
  if (!installDir || !isAbsolute(installDir)) return false;
  try {
    createRequire(join(installDir, 'package.json')).resolve('@deepseek-ai/dsh-credentials-local');
    return true;
  } catch {
    return false;
  }
})();
const dshOnly = { skip: dshAvailable ? false : 'DSH parser not installed (set DSH_INSTALL_DIR)' };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'kitto-jev-test-'));
  assert.ok(isAbsolute(dir));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const dsh = join(dir, 'dsh');
  await Promise.all([mkdir(home), mkdir(dsh)]);
  const env = { HOME: home, USERPROFILE: home, DSH_HOME: dsh };
  const filename = join(dsh, '.credentials.yaml');
  const store = async (text, path = filename) => {
    await writeFile(path, text, { mode: 0o600 });
    await chmod(path, 0o600);
  };
  const run = (args = inline, extraEnv = {}, input) => spawnSync(
    process.execPath, [...preload, script, ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8', input, timeout: 4000 },
  );
  return { dir, home, env, filename, store, run };
}

function expectPost(result, key, url = goEndpoint, model = 'jev-1.14') {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    url,
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'user-agent': 'jev-decide/0.1 (+deepseek-harness)',
    },
    body: { state, questions, model },
  });
}

function expectNoKey(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, noKey);
}

test('rejects double stdin immediately with the pipe still open', async t => {
  const { dir, env } = await fixture(t);
  const child = spawn(process.execPath, [...preload, script, '--state', '@-', '--questions', '@-'], {
    cwd: dir, env: { ...env, DSH_INSTALL_DIR: installDir ?? '', TEST_FORBID_STORE_IO: '1' }, timeout: 4000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.equal(stderr, 'jev: only one of --state and --questions may use @- (stdin)\n');
});

test('either single stdin source works with the other inline or in a file', async t => {
  const { dir, run } = await fixture(t);
  await Promise.all([writeFile(join(dir, 'state.md'), state), writeFile(join(dir, 'q.json'), questionText)]);
  for (const [stateArg, questionArg, input] of [
    ['@-', questionText, state], ['@-', '@q.json', state],
    [state, '@-', questionText], ['@state.md', '@-', questionText],
  ]) {
    expectPost(run(['--state', stateArg, '--questions', questionArg], { OPENCODE_API_KEY: 'fake-env', TEST_FORBID_STORE_IO: '1' }, input), 'fake-env');
  }
});

test('env keys take precedence and keep the Go default and explicit endpoint override', async t => {
  const { run, store } = await fixture(t);
  await store('invalid: [synthetic');
  const env = { DSH_INSTALL_DIR: installDir ?? '', TEST_FORBID_STORE_IO: '1', OPENCODE_GO_API_KEY: 'fake-env-go' };
  expectPost(run(inline, { ...env, OPENCODE_API_KEY: 'fake-env-api' }), 'fake-env-api');
  const override = 'https://example.invalid/custom';
  expectPost(run([...inline, '--model', 'gpt-6-luna-decision'], { ...env, JEV_ENDPOINT: override }), 'fake-env-go', override, 'gpt-6-luna-decision');
});

test('HTTP failures report only status and fixed guidance, not reflected credentials or input', async t => {
  const { run } = await fixture(t);
  const key = 'fake-reflected-key';
  const diagnostics = [
    [402, ' — Console credits are empty; use the Go endpoint ($JEV_ENDPOINT) or jev-1.13-free'],
    [403, ' — Request forbidden; if Cloudflare blocked it, keep a product user agent'],
    [500, ''],
  ];
  for (const [status, hint] of diagnostics) {
    const result = run(inline, { OPENCODE_API_KEY: key, TEST_HTTP_STATUS: String(status) });
    assert.ifError(result.error);
    assert.equal(result.status, 3);
    for (const output of [result.stdout, result.stderr]) {
      assert.equal(output.includes(key), false, 'HTTP failure leaked the reflected key');
      assert.equal(output.includes(state.trim()), false, 'HTTP failure leaked the reflected state');
      assert.equal(output.includes(questions.decision.instructions), false, 'HTTP failure leaked the reflected questions');
    }
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `jev: HTTP ${status}${hint}\n`);
  }
});

test('uses direct v1 refs with the host parser and preserves their precedence', dshOnly, async t => {
  const { home, run, store } = await fixture(t);
  const env = { DSH_INSTALL_DIR: installDir };
  await store('{version: 1, refs: {OPENCODE_GO_API_KEY: "fake-store-go", "OPENCODE_API_KEY": \'fake:primary#key\'}}');
  expectPost(run(inline, env), 'fake:primary#key');
  await store('version: 1\nrefs:\n  OPENCODE_GO_API_KEY: "fake-store-go" # comment\nother:\n  OPENCODE_API_KEY: fake-decoy\n');
  expectPost(run(inline, env), 'fake-store-go');
  expectPost(run(inline, { ...env, OPENCODE_GO_API_KEY: 'fake-env-go' }), 'fake-env-go');
  await mkdir(join(home, '.dsh'));
  await store('version: 1\nrefs: {OPENCODE_API_KEY: fake-home}', join(home, '.dsh', '.credentials.yaml'));
  expectPost(run(inline, { ...env, DSH_HOME: '' }), 'fake-home');
});

test('rejects malformed, unsupported, misplaced, or oversized store data without echoing it', dshOnly, async t => {
  const { run, store } = await fixture(t);
  const env = { DSH_INSTALL_DIR: installDir };
  for (const [name, text] of Object.entries({
    malformed: 'version: 1\nrefs: [fake-sensitive',
    duplicate: 'version: 1\nrefs:\n  OPENCODE_API_KEY: fake-sensitive\n  OPENCODE_API_KEY: fake-duplicate\n',
    'missing key': 'version: 1\nrefs: {UNRELATED_KEY: fake-sensitive}',
    'wrong version': 'version: fake-sensitive\nrefs: {OPENCODE_API_KEY: fake-sensitive}',
    'wrong type': 'version: 1\nrefs: {OPENCODE_API_KEY: 123, OPENCODE_GO_API_KEY: fake-sensitive}',
    empty: 'version: 1\nrefs: {OPENCODE_API_KEY: ""}',
    flat: 'OPENCODE_API_KEY: fake-sensitive',
    outside: 'version: 1\nrefs: {UNRELATED_KEY: fake-unrelated}\nother:\n  OPENCODE_API_KEY: fake-sensitive\n',
    nested: 'version: 1\nrefs:\n  NEST:\n    OPENCODE_API_KEY: fake-sensitive\n',
    records: 'version: 1\nrecords: {provider/sample: {kind: api-key, key: fake-sensitive, env: {OPENCODE_API_KEY: fake-decoy}}}',
    merge: '%YAML 1.1\n---\nversion: 1\nother: &other {OPENCODE_API_KEY: fake-sensitive}\nrefs: {<<: *other}',
    alias: 'version: 1\nother: &other fake-sensitive\nrefs: {OPENCODE_API_KEY: *other}',
    oversized: 'version: 1\nrefs: {OPENCODE_API_KEY: fake-sensitive}\n#' + 'x'.repeat(1024 * 1024),
  })) {
    await t.test(name, async () => {
      await store(text);
      expectNoKey(run(inline, env));
    });
  }
  await store('version: 1\nrefs: {OPENCODE_API_KEY: "fake-sensitive\\ninjected"}');
  const result = run(inline, env);
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'jev: OpenCode key is not a usable authorization header\n');
});

test('rejects non-regular and unsafe POSIX credential files without reading them', {
  skip: dshOnly.skip || (process.platform === 'win32' && 'POSIX permission and FIFO checks'),
}, async t => {
  const { dir, filename, run, store } = await fixture(t);
  const env = { DSH_INSTALL_DIR: installDir };
  await store('version: 1\nrefs: {OPENCODE_API_KEY: fake-insecure}');
  await chmod(filename, 0o644);
  expectNoKey(run(inline, env));
  await rm(filename);
  assert.equal(spawnSync('mkfifo', [filename], { timeout: 4000 }).status, 0);
  expectNoKey(run(inline, env));
  await rm(filename);
  const target = join(dir, 'target.yaml');
  await store('version: 1\nrefs: {OPENCODE_API_KEY: fake-symlink}', target);
  await symlink(target, filename);
  expectNoKey(run(inline, env));
});

test('fails closed without the host interface and does not load a NODE_PATH parser', async t => {
  const { dir, run, store } = await fixture(t);
  await store('version: 1\nrefs: {OPENCODE_API_KEY: fake-sensitive}');
  expectNoKey(run());
  const unsupported = join(dir, 'host');
  const decoy = join(dir, 'decoy');
  const parser = '@deepseek-ai/dsh-credentials-local';
  const parserDir = join(unsupported, 'node_modules', parser);
  await Promise.all([mkdir(parserDir, { recursive: true }), mkdir(join(decoy, parser), { recursive: true })]);
  await writeFile(join(unsupported, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: hosts.dsh.version }));
  await writeFile(join(parserDir, 'index.js'), 'module.exports = {};');
  await writeFile(join(decoy, parser, 'index.js'), 'throw Error("Synthetic parser must never execute");');
  expectNoKey(run(inline, { DSH_INSTALL_DIR: unsupported }));
  await rm(join(parserDir, 'index.js'));
  await writeFile(join(decoy, parser, 'index.js'), 'process.stdout.write("Unexpected module execution\\n");');
  expectNoKey(run(inline, { DSH_INSTALL_DIR: unsupported, NODE_PATH: decoy }));
});
