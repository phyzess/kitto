import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hosts } from '../lib/host-pins.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/kitto.mjs', import.meta.url));

test('Codex scopes preserve existing hooks and compose with native repo discovery', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'kitto-codex-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const home = join(fixture, 'home');
  const codexHome = join(home, 'codex');
  const dataHome = join(fixture, "data with ' quote");
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, KITTO_HOME: dataHome };
  const original = {
    description: 'Existing hooks',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] },
  };
  const hookPath = join(codexHome, 'hooks.json');
  const workspace = join(fixture, 'workspace');
  const repo = join(workspace, 'repo');

  async function put(path, text) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  async function skill(root, name) {
    await put(join(root, '.agents/skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Example skill\n---\nSkill implementation\n`);
  }
  async function readHooks() {
    return JSON.parse(await readFile(hookPath, 'utf8'));
  }
  async function setup(...args) {
    return run(process.execPath, [cli, 'setup', '--agents', 'codex', ...args], { env });
  }

  await put(hookPath, JSON.stringify(original));
  await put(join(workspace, 'AGENTS.md'), 'workspace-instructions-fixture\n');
  await skill(workspace, 'workspace-skill-fixture');

  await setup('--workspace', workspace, '--dry-run');
  assert.deepEqual(await readHooks(), original);
  await assert.rejects(readFile(join(dataHome, 'scopes.json')), { code: 'ENOENT' });

  const first = await setup('--workspace', workspace);
  assert.match(first.stdout, /trust the Kitto SessionStart hook with \/hooks/);
  const installed = await readHooks();
  assert.deepEqual(installed.hooks.Stop, original.hooks.Stop);
  assert.equal(installed.description, original.description);
  assert.equal(installed.hooks.SessionStart.length, 1);
  await setup('--global');
  await setup('--workspace', workspace);
  assert.deepEqual(await readHooks(), installed);

  const global = join(dataHome, 'global');
  await put(join(global, 'AGENTS.md'), 'global-instructions-fixture\n');
  await skill(global, 'global-skill-fixture');

  const source = join(fixture, 'source');
  await put(join(source, 'AGENTS.md'), 'repo-instructions-fixture\n');
  await skill(source, 'repo-skill-fixture');
  await run('git', ['init', '-q', source]);
  await run('git', ['-C', source, 'add', '.']);
  await run('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture']);
  await run('git', ['clone', '-q', source, repo]);
  const outside = join(fixture, 'workspace-sibling');
  await run('git', ['clone', '-q', source, outside]);

  const nativeEnv = { ...env };
  delete nativeEnv.KITTO_HOME;
  const command = installed.hooks.SessionStart[0].hooks[0].command;
  const adapter = run('sh', ['-c', command], { env: nativeEnv });
  adapter.child.stdin.end(JSON.stringify({ cwd: repo }));
  const scopeContext = JSON.parse((await adapter).stdout).hookSpecificOutput.additionalContext;
  assert.match(scopeContext, /global-instructions-fixture[\s\S]*workspace-instructions-fixture/);
  assert.match(scopeContext, /workspace-skill-fixture/);

  const version = spawnSync('codex', ['--version'], { encoding: 'utf8', env: nativeEnv, timeout: 8000 }).stdout || '';
  if (!version.includes(`codex-cli ${hosts.codex.version}`)) {
    t.diagnostic('Skipping model-request verification without the validated Codex CLI baseline.');
    return;
  }

  let request;
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/responses') {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"data":[],"models":[]}');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    request = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"response.completed","response":{"id":"resp_fixture","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  async function nativePrompt(cwd) {
    request = undefined;
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const provider = `model_providers.fixture={name="Fixture", base_url="${baseUrl}", wire_api="responses", supports_websockets=false, request_max_retries=0, stream_max_retries=0}`;
    const session = run('codex', [
      'exec', '--json', '--ephemeral',
      '--dangerously-bypass-hook-trust', '-c', provider, '-c', 'model_provider=fixture', 'Fixture prompt',
    ], { cwd, env: nativeEnv, timeout: 15000 });
    session.child.stdin.end();
    await session;
    assert.ok(request?.input);
    return JSON.stringify(request.input);
  }

  const project = await nativePrompt(repo);
  assert.match(project, /repo-instructions-fixture/);
  assert.match(project, /repo-skill-fixture/);
  assert.match(project, /global-instructions-fixture/);
  assert.match(project, /global-skill-fixture: Example skill \(file:/);
  assert.match(project, /workspace-instructions-fixture/);
  assert.match(project, /workspace-skill-fixture/);

  const sibling = await nativePrompt(outside);
  assert.match(sibling, /repo-instructions-fixture/);
  assert.match(sibling, /global-instructions-fixture/);
  assert.match(sibling, /global-skill-fixture/);
  assert.doesNotMatch(sibling, /workspace-(?:instructions|skill)-fixture/);
  assert.equal(await readFile(join(repo, 'AGENTS.md'), 'utf8'), 'repo-instructions-fixture\n');
  assert.equal((await run('git', ['-C', repo, 'status', '--porcelain'])).stdout, '');
});
