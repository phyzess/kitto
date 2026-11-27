import { deepStrictEqual, doesNotMatch, equal, match, notEqual, rejects } from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

function testExecutable() {
  if (process.env.DSH_TEST_BIN) return process.env.DSH_TEST_BIN;
  try {
    return execFileSync('mise', ['which', 'dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim() || 'dsh';
  } catch {
    return 'dsh';
  }
}

const executable = testExecutable();
const root = process.env.KITTO_TEST_PACKAGE_ROOT ? resolve(process.env.KITTO_TEST_PACKAGE_ROOT) : fileURLToPath(new URL('../', import.meta.url));

function available() {
  try {
    execFileSync(executable, ['--version'], { env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

const nativeDshAvailable = available();

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'kitto-scope-dsh-')));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const env = {
    HOME: home,
    USERPROFILE: home,
    LANG: process.env.LANG ?? 'C.UTF-8',
    XDG_STATE_HOME: join(home, 'state'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    DSH_HOME: join(home, '.dsh'),
    DSH_AGENTS_HOME: join(home, '.agents'),
    DSH_TELEMETRY_DISABLED: '1',
    KITTO_HOME: join(home, 'kitto'),
    PATH: executable !== 'dsh'
      ? dirname(executable) + delimiter + process.env.PATH : process.env.PATH,
  };
  const setup = (options = {}) => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { installDshScope } from './lib/scope-dsh.mjs';
     await installDshScope(${JSON.stringify({ home, ...options })});`,
  ], { env, cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { home, env, setup };
}

test('DSH scoped setup preserves an existing profile and is idempotent', { skip: !nativeDshAvailable }, async t => {
  const { env, setup } = await fixture(t);
  const profile = join(env.DSH_HOME, 'profiles', 'custom');
  await mkdir(profile, { recursive: true });
  const path = join(profile, 'cordis.patch.yml');
  const before = '# user comment\n- id: agent-instructions\n  config:\n    maxBytes: 65536\n';
  await writeFile(join(profile, 'package.json'), '{}');
  await writeFile(path, before);
  setup({ dshProfile: 'custom', dryRun: true });
  equal(await readFile(path, 'utf8'), before);
  setup({ dshProfile: 'custom' });
  const after = await readFile(path, 'utf8');
  match(after, /^# user comment\n- id: agent-instructions\n  config:\n    maxBytes: 65536\n/);
  equal(after.match(/phyzess-kitto-scopes/g).length, 1);
  setup({ dshProfile: 'custom' });
  equal(await readFile(path, 'utf8'), after);
  await writeFile(path, after.replace('/index.mjs', '/foreign.mjs'));
  await rejects(async () => setup({ dshProfile: 'custom', dryRun: true }), /different phyzess-kitto-scopes entry/);
  await rejects(async () => setup({ dshProfile: 'missing', dryRun: true }), /Initialize the native DSH profile missing/);
});

test('DSH Web uses each session workspace to resolve scopes', { skip: !nativeDshAvailable, timeout: 65_000 }, async t => {
  const { home, env, setup } = await fixture(t);
  const scoped = join(home, 'workspace');
  const repo = join(scoped, 'new-clone');
  const unrelated = join(home, 'unrelated');
  const global = join(env.KITTO_HOME, 'global');
  await Promise.all([repo, unrelated].map(path => mkdir(join(path, '.git'), { recursive: true })));
  for (const [dir, name, text] of [
    [global, 'kitto-global-fixture', 'global guidance'],
    [scoped, 'kitto-workspace-fixture', 'workspace guidance'],
  ]) {
    const skills = join(dir, '.agents', 'skills', name);
    await mkdir(skills, { recursive: true });
    await writeFile(join(dir, 'AGENTS.md'), text);
    await writeFile(join(skills, 'SKILL.md'), `---\nname: ${name}\ndescription: Scope fixture.\n---\n${text}\n`);
  }
  await writeFile(join(env.KITTO_HOME, 'scopes.json'), JSON.stringify({
    version: 1, global: true, workspaces: [scoped],
  }));
  setup();

  const probe = join(home, 'probe.mjs');
  await writeFile(probe, `
export const inject = ['agents', 'workspaceRegistry', 'sessionController', 'sessionSkillCatalog', 'systemPrompt', 'skills'];
export async function apply(ctx) {
  await new Promise(resolve => setTimeout(resolve, 300));
  const results = [];
  for (const cwd of ${JSON.stringify([repo, unrelated, scoped])}) {
    const workspace = await ctx.workspaceRegistry.create(cwd);
    const { sessionId } = await ctx.sessionController.create({ workspaceId: workspace.id });
    const agent = ctx.agents.get(sessionId);
    const prompt = await ctx.systemPrompt.assemble({ agent, scope: agent });
    const catalog = await ctx.sessionSkillCatalog.list({ sessionId }, new AbortController().signal);
    const skill = await ctx.skills.get('kitto-workspace-fixture', { cwd, scope: agent });
    results.push({
      instructions: prompt.contexts.filter(item => item.name === 'phyzess-kitto-scopes').map(item => item.text).join(''),
      skills: catalog.skills.map(item => item.name).filter(name => name.endsWith('-fixture')),
      body: skill?.content,
    });
  }
  console.log('KITTO_SCOPE_TEST ' + JSON.stringify(results));
}
`);
  const patch = join(home, 'probe.yml');
  await writeFile(patch, JSON.stringify([{ insert: [{ id: 'kitto-scope-test', name: probe }] }]));
  const child = spawn(executable, ['web', '--patch', patch, '--port', '0', '--no-open'], {
    cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const results = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(output || 'DSH Web probe timed out')); }, 60_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => {
      clearTimeout(timer);
      const line = output.split('\n').find(item => item.startsWith('KITTO_SCOPE_TEST '));
      if (line) resolve(JSON.parse(line.slice('KITTO_SCOPE_TEST '.length)));
      else reject(new Error(output || 'DSH Web exited before the scope probe'));
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (/^KITTO_SCOPE_TEST .+\n/m.test(output)) child.kill();
    });
  });
  match(results[0].instructions, /global guidance[\s\S]*workspace guidance/);
  deepStrictEqual(results[0].skills, ['kitto-global-fixture', 'kitto-workspace-fixture']);
  equal(results[0].body, 'workspace guidance');
  match(results[1].instructions, /global guidance/);
  doesNotMatch(results[1].instructions, /workspace guidance/);
  deepStrictEqual(results[1].skills, ['kitto-global-fixture']);
  equal(results[1].body, undefined);
  match(results[2].instructions, /global guidance/);
  doesNotMatch(results[2].instructions, /workspace guidance/);
  deepStrictEqual(results[2].skills, ['kitto-global-fixture', 'kitto-workspace-fixture']);
});

test('DSH scoped setup rejects the app-managed desktop profile without writing a patch', async t => {
  const { home, env } = await fixture(t);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { installDshScope } from './lib/scope-dsh.mjs';
     await installDshScope(${JSON.stringify({ home, dshProfile: 'desktop' })});`,
  ], { env, cwd: root, encoding: 'utf8', timeout: 30_000 });
  notEqual(result.status, 0);
  match(result.stderr, /desktop profile is managed/);
  await rejects(readFile(join(env.DSH_HOME, 'profiles/desktop/cordis.patch.yml'), 'utf8'), { code: 'ENOENT' });
});
