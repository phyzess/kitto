import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { probeDesktopProfile } from '../lib/dsh-profile.ts';
import { composeInstructions } from '../lib/host-config.ts';
import { hosts, meetsBaseline, parseOptions, pnpmVersion, replaceDirectory } from '../lib/kitto.ts';
import { newerStable, updateNotice } from '../lib/update-notice.ts';
import { skillNames, root, command, fixture, good, readJson } from './helpers/kitto-fixture.ts';
import { requireEnv, hostCallsOf } from './helpers/kitto-suite.ts';

test('public options reject unknown hosts, flags and missing values', () => {
  assert.deepEqual(parseOptions(['--agents', 'pi,codex,pi']).agents, ['pi', 'codex']);
  for (const args of [['--agents', 'other'], ['--source'], ['--run'], ['--agents', 'pi,'], ['--recover', '--agents', 'pi']])
    assert.throws(() => parseOptions(args));
});

test('private MCP sources are an explicit opt-in option', () => {
  assert.equal(parseOptions(['--include-private'])['include-private'], true);
  assert.equal(parseOptions(['--no-include-private'])['no-include-private'], true);
  assert.throws(() => parseOptions(['--include-private', '--no-include-private']), /Choose either/);
  assert.throws(() => parseOptions(['--recover', '--include-private']), /only accepts/);
});

test('host baseline comparison orders prereleases', () => {
  assert.equal(meetsBaseline(hosts.dsh.version, '0.2.2-rc.2'), true, 'the DSH baseline must support credential templates');
  assert.equal(meetsBaseline('0.2.2-rc.2', '0.2.2-rc.2'), true);
  assert.equal(meetsBaseline('0.2.2-rc.1', '0.2.2-rc.2'), false, 'rc.1 is older than rc.2');
  assert.equal(meetsBaseline('0.2.2-rc.10', '0.2.2-rc.2'), true, 'numeric prerelease identifiers compare as numbers');
  assert.equal(meetsBaseline('0.2.2', '0.2.2-rc.2'), true);
  assert.equal(meetsBaseline('0.2.2-rc.2', '0.2.2'), false);
  assert.equal(meetsBaseline('0.2.1', '0.2.2-rc.2'), false);
  assert.equal(meetsBaseline('0.3.0-rc.1', '0.2.2-rc.2'), true);
  assert.equal(meetsBaseline('not-a-version', '0.2.2-rc.2'), false);
});

test('missing host installation preflight requires stable Node at the minimum version', (t) => {
  const emptyPath = mkdtempSync(join(tmpdir(), 'kitto-node-preflight-'));
  t.onTestFinished(() => rmSync(emptyPath, { recursive: true, force: true }));
  const probe = (version: string) =>
    command(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { checkSelectedHosts } from './lib/kitto.ts';
    Object.defineProperty(process.versions, 'node', { value: process.argv[1] });
    checkSelectedHosts(['pi'], true);
  `,
        version,
      ],
      { HOME: emptyPath, PATH: emptyPath },
    );
  const minimum = hosts.pi.node;
  assert.ok(minimum);
  const candidate = probe(`${minimum}-rc.1`);
  assert.equal(candidate.status, 1, candidate.stdout + candidate.stderr);
  assert(candidate.stderr.includes(`Installing pi through npm requires Node >=${minimum}.`));
  assert.doesNotMatch(candidate.stdout, /Install missing CLI/);
  const stable = probe(minimum);
  good(stable);
  assert(stable.stdout.includes(`Install missing CLI: ${hosts.pi.package}@${hosts.pi.version}`));
});

test('skill directory replacement is atomic and leaves no backup', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'kitto-replace-'));
  t.onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const source = join(temp, 'source'),
    target = join(temp, 'target');
  mkdirSync(source);
  writeFileSync(join(source, 'SKILL.md'), 'new');
  mkdirSync(target);
  writeFileSync(join(target, 'SKILL.md'), 'old');
  await replaceDirectory(source, target);
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'new');
  assert.deepEqual(readdirSync(temp).sort(), ['source', 'target']);
});

test('Codex and DSH i-have-adhd skills are model-invocable and loaded at startup', () => {
  for (const host of ['codex', 'dsh']) {
    const skill = readFileSync(join(root, `config/${host}/skills/i-have-adhd/SKILL.md`), 'utf8');
    assert.doesNotMatch(skill, /disable-model-invocation/);
  }
  const common = readFileSync(join(root, 'config/instructions/common.md'), 'utf8');
  assert.match(common, /每次会话开始先加载 `i-have-adhd` skill/);
  assert.match(common, /每次会话开始先加载 `hindsight` skill/);
  assert.match(common, /发布、外部消息、不可逆或破坏性操作在最终执行前确认/);
  const codex = readFileSync(join(root, 'config/codex/AGENTS.md'), 'utf8');
  assert.match(codex, /\$CODEX_HOME/);
  const dsh = readFileSync(join(root, 'config/dsh/AGENTS.md'), 'utf8');
  assert.match(dsh, /\$DSH_HOME/);
  const policy = readFileSync(join(root, 'config/codex/skills/i-have-adhd/agents/openai.yaml'), 'utf8');
  assert.match(policy, /allow_implicit_invocation: true/);
});

test('composeInstructions normalizes BOM and CRLF and joins sections at the boundary', () => {
  const expected = '# 共享\n\n- 规则一\n\n- 规则二\n\n<!-- kitto:host-addendum -->\n\n## Host\n\n- 宿主规则\n';
  assert.equal(composeInstructions('\uFEFF# 共享\r\n\r\n- 规则一\r\n\r\n- 规则二\r\n', '## Host\r\n\r\n- 宿主规则\r\n'), expected);
});

test('a source without the shared layer fails before deploying Codex or DSH rules', (t) => {
  const f = fixture(t);
  rmSync(join(f.source, 'config/instructions'), { recursive: true });
  const result = f.cli('setup', '--agents', 'codex,dsh', '--source', f.source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /config\/instructions\/common\.md/);
});

test('shared rules compose into all three hosts with addenda kept host-specific', (t) => {
  const f = fixture(t);
  for (const [host, text] of [
    ['pi', 'Pi addendum only'],
    ['codex', 'Codex addendum only'],
    ['dsh', 'DSH addendum only'],
  ]) {
    mkdirSync(join(f.source, 'config', host), { recursive: true });
    writeFileSync(join(f.source, 'config', host, 'AGENTS.md'), text);
  }
  good(f.cli('setup', '--agents', 'pi,codex,dsh', '--source', f.source));
  const common = readFileSync(join(f.source, 'config/instructions/common.md'), 'utf8').trim();
  const files = {
    pi: join(requireEnv(f.env, 'PI_CODING_AGENT_DIR'), 'AGENTS.md'),
    codex: join(requireEnv(f.env, 'CODEX_HOME'), 'AGENTS.md'),
    dsh: join(requireEnv(f.env, 'DSH_HOME'), 'AGENTS.md'),
  };
  const addenda: Record<string, string> = { pi: 'Pi addendum only', codex: 'Codex addendum only', dsh: 'DSH addendum only' };
  for (const [host, file] of Object.entries(files)) {
    const text = readFileSync(file, 'utf8');
    assert.equal(text.split(common).length - 1, 1, `${host}: shared rules must appear once`);
    assert.equal(text.split('<!-- kitto:host-addendum -->').length - 1, 1, `${host}: one shared/host boundary`);
    assert.equal(text.split(addenda[host]).length - 1, 1, `${host}: own addendum must appear once`);
    for (const [other, addendum] of Object.entries(addenda)) {
      if (other !== host) assert.equal(text.includes(addendum), false, `${host} must not contain ${other}'s addendum`);
    }
  }
  const pi = readFileSync(files.pi, 'utf8');
  assert(pi.startsWith(common), 'the Pi file starts with the shared rules');
  assert.doesNotMatch(pi, /kitto:begin|kitto:end/, 'Pi keeps a whole-file deployment');
  assert.match(readFileSync(files.codex, 'utf8'), /<!-- kitto:begin -->[\s\S]*<!-- kitto:end -->/);
  assert.match(readFileSync(files.dsh, 'utf8'), /<!-- kitto:begin -->[\s\S]*<!-- kitto:end -->/);
});

test('shared rule edits redeploy to every host and preserve block-external content', (t) => {
  const f = fixture(t);
  mkdirSync(join(requireEnv(f.env, 'CODEX_HOME')), { recursive: true });
  mkdirSync(join(requireEnv(f.env, 'DSH_HOME')), { recursive: true });
  writeFileSync(join(requireEnv(f.env, 'CODEX_HOME'), 'AGENTS.md'), 'Local Codex note\n');
  writeFileSync(join(requireEnv(f.env, 'DSH_HOME'), 'AGENTS.md'), 'Local DSH note\n');
  good(f.cli('setup', '--agents', 'pi,codex,dsh', '--source', f.source));
  const commonPath = join(f.source, 'config/instructions/common.md');
  writeFileSync(commonPath, readFileSync(commonPath, 'utf8').replace('shared-marker', 'shared-marker-v2'));
  good(f.maintain('sync', '--apply'));
  const files = [
    join(requireEnv(f.env, 'PI_CODING_AGENT_DIR'), 'AGENTS.md'),
    join(requireEnv(f.env, 'CODEX_HOME'), 'AGENTS.md'),
    join(requireEnv(f.env, 'DSH_HOME'), 'AGENTS.md'),
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /shared-marker-v2/);
    assert.doesNotMatch(text, /shared-marker(?!-v2)/);
  }
  assert.match(readFileSync(files[1], 'utf8'), /^Local Codex note\n/);
  assert.match(readFileSync(files[2], 'utf8'), /^Local DSH note\n/);
  assert.match(readFileSync(files[0], 'utf8'), /Pi instructions/);
});

test('Pi export writes only the Pi addendum back to the source', (t) => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const deployed = join(requireEnv(f.env, 'PI_CODING_AGENT_DIR'), 'AGENTS.md');
  const addendumPath = join(f.source, 'config/pi/AGENTS.md');
  writeFileSync(deployed, readFileSync(deployed, 'utf8').replace('Pi instructions', 'Pi instructions from machine'));
  good(f.maintain('export', '--apply'));
  const exported = readFileSync(addendumPath, 'utf8');
  assert.equal(exported, 'Pi instructions from machine\n');
  assert.doesNotMatch(exported, /共享规则|shared-marker/);

  writeFileSync(deployed, '# legacy full AGENTS\n');
  const result = f.maintain('export', '--apply');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /host-specific section/);
  assert.equal(readFileSync(addendumPath, 'utf8'), exported);
});

test('self-update notice is rate-limited, ignores prereleases, and tolerates offline', async (t) => {
  const f = fixture(t),
    cache = join(f.home, 'notice');
  assert.equal(newerStable('0.2.0-rc.1', '0.1.0'), false);
  assert.equal(newerStable('0.1.0', '0.1.0-dev.0'), true);
  assert.equal(newerStable('0.1.0', '0.2.0'), false);
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response(JSON.stringify({ version: '0.2.0' }));
  };
  const notice = await updateNotice(cache, '0.1.0', { fetcher, now: 100 });
  assert.ok(notice);
  assert.match(notice, /0.2.0/);
  assert.equal(await updateNotice(cache, '0.1.0', { fetcher, now: 200 }), undefined);
  assert.equal(calls, 1);
  assert.equal(
    await updateNotice(cache, '0.1.0', {
      fetcher: async () => {
        throw new Error('offline');
      },
      now: 86_400_101,
    }),
    undefined,
  );
});

test('self-update notice recovers from a null cache file', async (t) => {
  const f = fixture(t),
    cache = join(f.home, 'notice-null');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'update-check.json'), 'null');
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response(JSON.stringify({ version: '0.2.0' }));
  };
  const notice = await updateNotice(cache, '0.1.0', { fetcher, now: 100 });
  assert.ok(notice);
  assert.match(notice, /0.2.0/);
  assert.equal(calls, 1);
});

test('setup preview leaves home and source unchanged', (t) => {
  const f = fixture(t);
  const before = readdirSync(f.home);
  good(f.cli('setup', '--agents', 'pi,codex,dsh', '--source', f.source, '--dry-run'));
  assert.deepEqual(readdirSync(f.home), before);
  assert.equal(command('git', ['status', '--porcelain'], f.env, f.source).stdout, '');
  const calls = readFileSync(f.log, 'utf8');
  assert.doesNotMatch(calls, /"install"|"marketplace"/);
});

test('missing DSH package manager is detected before writes and included in installation preview', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.temp, 'bin/pnpm'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
  const result = f.cli('setup', '--agents', 'dsh', '--source', f.source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /require pnpm/);
  assert.equal(existsSync(requireEnv(f.env, 'KITTO_HOME')), false);
  const preview = f.cli('setup', '--agents', 'dsh', '--source', f.source, '--install-agents', '--dry-run');
  good(preview);
  assert.ok(preview.stdout.includes(`Install missing DSH prerequisite: pnpm@${pnpmVersion}`));
  assert.equal(existsSync(requireEnv(f.env, 'KITTO_HOME')), false);
});

test('DSH desktop setup deploys global rules and skills without pnpm, bundle or profile patch', (t) => {
  const f = fixture(t);
  const hostSkill = join(f.source, 'config/dsh/skills/desktop-example');
  mkdirSync(hostSkill, { recursive: true });
  writeFileSync(join(hostSkill, 'SKILL.md'), 'Desktop host skill');
  writeFileSync(join(f.source, 'config/dsh/AGENTS.md'), 'Desktop portable rules');
  writeFileSync(join(f.temp, 'bin/pnpm'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });

  const result = f.cli('setup', '--agents', 'dsh', '--dsh-profile', 'desktop', '--source', f.source);
  good(result);
  assert.match(result.stdout, /global-only; managed by the Desktop app/);
  assert.match(result.stdout, /use --dsh-profile web/);
  assert.doesNotMatch(result.stdout, /Connect native Kitto integrations/);
  assert.match(result.stderr, /has not been initialized/);
  assert.match(readFileSync(join(requireEnv(f.env, 'DSH_HOME'), 'AGENTS.md'), 'utf8'), /Desktop portable rules/);
  assert.equal(readFileSync(join(requireEnv(f.env, 'DSH_HOME'), 'skills/desktop-example/SKILL.md'), 'utf8'), 'Desktop host skill');
  assert.match(readFileSync(join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example/SKILL.md'), 'utf8'), /Example body/);
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).dshProfile, 'desktop');
  assert.equal(existsSync(join(requireEnv(f.env, 'DSH_HOME'), 'profiles/desktop')), false);
  let calls = hostCallsOf(f);
  assert(!calls.some((c) => c.command === 'dsh'));
  assert(!calls.some((c) => c.command === 'pnpm'));
  const versions = f.maintain('versions');
  good(versions);
  assert.match(versions.stdout, /app-managed/);

  good(f.maintain('remove', '--apply'));
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).detached, true);
  assert.match(readFileSync(join(requireEnv(f.env, 'DSH_HOME'), 'AGENTS.md'), 'utf8'), /Desktop portable rules/);
  calls = hostCallsOf(f);
  assert(!calls.some((c) => c.command === 'dsh' && c.args.includes('remove')));
});

test('DSH desktop detection reports an uninitialized profile, the npm CLI and a working in-app CLI', (t) => {
  const f = fixture(t);
  const profile = join(requireEnv(f.env, 'DSH_HOME'), 'profiles/desktop');
  const args = ['setup', '--agents', 'dsh', '--dsh-profile', 'desktop', '--source', f.source, '--dry-run'];
  const probeCalls = () => hostCallsOf(f).filter((c) => c.command === 'dsh' && c.args.includes('version-exemptions'));

  const uninitialized = f.cli(...args);
  good(uninitialized);
  assert.match(uninitialized.stderr, /has not been initialized/);
  assert.match(uninitialized.stderr, /Start DeepSeek Harness Desktop once/);
  assert.doesNotMatch(uninitialized.stdout, /Connect native Kitto integrations/);
  assert.equal(probeCalls().length, 0);
  assert.equal(existsSync(requireEnv(f.env, 'KITTO_HOME')), false);

  mkdirSync(profile, { recursive: true });
  const manifest = { dependencies: {}, dsh: { profile: { bundles: [] } } };
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest));
  f.env.FAKE_DSH_CLI = 'npm';
  const npm = f.cli(...args);
  good(npm);
  assert.match(npm.stderr, /npm CLI and cannot manage the desktop profile/);
  assert.doesNotMatch(npm.stderr, /Manage dsh Command/);
  assert.equal(probeCalls().length, 1);

  delete f.env.FAKE_DSH_CLI;
  const ready = f.cli(...args);
  good(ready);
  assert.match(ready.stdout, /initialized profile detected \(probe ran against a temporary copy\)/);
  assert.deepEqual(readJson(join(profile, 'package.json')), manifest);
  assert.deepEqual(readdirSync(profile), ['package.json']);
  assert.equal(probeCalls().length, 2);
});

test('DSH desktop setup skips CLI checks and never installs the npm dsh CLI', (t) => {
  const f = fixture(t);
  const bin = join(f.temp, 'bin');
  const git = command('which', ['git'], f.env).stdout.trim();
  rmSync(join(bin, 'dsh'));
  symlinkSync(git, join(bin, 'git'));
  f.env.PATH = bin;
  const profile = join(requireEnv(f.env, 'DSH_HOME'), 'profiles/desktop');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
  mkdirSync(join(f.source, 'config/dsh'), { recursive: true });
  writeFileSync(join(f.source, 'config/dsh/AGENTS.md'), 'Desktop portable rules');
  const npm = join(bin, 'npm');
  writeFileSync(
    npm,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.CALL_LOG, JSON.stringify({ command: 'npm', args: process.argv.slice(2) }) + '\\n');\n`,
    { mode: 0o755 },
  );

  const result = f.cli('setup', '--agents', 'dsh', '--dsh-profile', 'Desktop', '--source', f.source, '--install-agents');
  good(result);
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).dshProfile, 'desktop');
  assert.match(result.stderr, /No dsh CLI was found on PATH/);
  assert.match(readFileSync(join(requireEnv(f.env, 'DSH_HOME'), 'AGENTS.md'), 'utf8'), /Desktop portable rules/);
  assert.deepEqual(readdirSync(profile), ['package.json']);
  const calls = hostCallsOf(f);
  assert(!calls.some((c) => c.command === 'npm' || c.command === 'dsh'));
});

test('DSH desktop probe copies the profile, tolerates a read-only home and reports timeouts', (t) => {
  const f = fixture(t);
  const profile = join(requireEnv(f.env, 'DSH_HOME'), 'profiles/desktop');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));

  assert.equal(probeDesktopProfile({ dshHome: requireEnv(f.env, 'DSH_HOME'), env: f.env }).kind, 'desktop-cli');
  assert.deepEqual(readdirSync(profile), ['package.json']);

  chmodSync(profile, 0o555);
  try {
    assert.equal(probeDesktopProfile({ dshHome: requireEnv(f.env, 'DSH_HOME'), env: f.env }).kind, 'desktop-cli');
    assert.deepEqual(readdirSync(profile), ['package.json']);
  } finally {
    chmodSync(profile, 0o755);
  }

  f.env.FAKE_DSH_PROBE_DELAY_MS = '1000';
  assert.equal(probeDesktopProfile({ dshHome: requireEnv(f.env, 'DSH_HOME'), env: f.env, timeoutMs: 150 }).kind, 'timeout');
  delete f.env.FAKE_DSH_PROBE_DELAY_MS;
  assert.deepEqual(readdirSync(profile), ['package.json']);
});

test('shared-rules-only setup is rejected for the DSH desktop profile', (t) => {
  const f = fixture(t);
  const result = command(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { runEnvironmentSetup } from './lib/environment-setup.ts';
     await runEnvironmentSetup(${JSON.stringify({
       agents: ['dsh'],
       source: false,
       installAgents: false,
       deps: false,
       dshProfile: 'desktop',
       dryRun: true,
     })});`,
    ],
    f.env,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a configuration source/);
  assert.equal(existsSync(requireEnv(f.env, 'KITTO_HOME')), false);
});

test('setup persists code, keeps private assets out, and registers all native integrations', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, 'config/pi/mcp.private.json'), '{"YOUR_SECRET":"fixture"}');
  good(f.cli('setup', '--agents', 'pi,codex,dsh', '--source', f.source));
  const runtime = join(requireEnv(f.env, 'KITTO_HOME'), 'runtime');
  assert.equal(existsSync(join(runtime, 'config')), false);
  assert.equal(existsSync(join(runtime, 'skills')), false);
  const skill = readFileSync(join(runtime, 'integration/skills/kitto/SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /KITTO_RUNNER/);
  assert.match(skill, /'\\''/);
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).ready, true);
  good(f.maintain('status'));
  good(f.cli('setup'));
  const calls = readFileSync(f.log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(calls.some((c) => c.command === 'pi' && c.args[0] === 'install' && c.args[1] === runtime));
  assert(calls.some((c) => c.command === 'codex' && c.args.join(' ') === 'plugin add kitto@phyzess-kitto'));
  assert(calls.some((c) => c.command === 'dsh' && c.args.join(' ') === `plugin --profile web add ${runtime}`));
});

test('deployed routing help uses the bound CLI without relying on PATH', (t) => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'dsh', '--source', f.source));
  const runtime = join(requireEnv(f.env, 'KITTO_HOME'), 'runtime');
  const skill = readFileSync(join(runtime, 'integration/skills/kitto/SKILL.md'), 'utf8');
  const help = skill.match(/^'.*kitto-node' .* route --help$/m)?.[0];
  assert.ok(help && !help.includes('KITTO_CLI'), 'The deployed skill must show the bound routing command.');

  const bin = join(f.temp, 'bin');
  assert.equal(existsSync(join(bin, 'kitto')), false);
  symlinkSync(process.execPath, join(bin, 'node'));
  const probe = () => command('/bin/sh', ['-c', help], { ...f.env, PATH: bin });
  const offline = probe();
  good(offline);
  assert.match(offline.stdout, /kitto route plan/);

  writeFileSync(join(bin, 'kitto'), '#!/bin/sh\nexit 77\n', { mode: 0o755 });
  good(probe());
  const entry = join(runtime, 'bin/kitto.mjs');
  assert.equal(resolve(entry), join(resolve(f.temp), 'home/kitto/runtime/bin/kitto.mjs'));
  rmSync(entry);
  const missing = probe();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /MODULE_NOT_FOUND/);
});

test('a conflicting existing shared skill stops setup before runtime or host changes', (t) => {
  const f = fixture(t),
    target = join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'SKILL.md'), 'local work');
  const result = f.cli('setup', '--agents', 'codex', '--source', f.source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Skill conflict/);
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'local work');
  assert.equal(existsSync(join(requireEnv(f.env, 'KITTO_HOME'), 'runtime')), false);
});

test('guided setup keeps divergent unowned skills through later Pi syncs', (t) => {
  const f = fixture(t);
  const local = join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example');
  const owned = join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/managed/SKILL.md');
  const source = join(f.source, 'skills/example/SKILL.md');
  const hostLocal = join(requireEnv(f.env, 'PI_CODING_AGENT_DIR'), 'skills/host-example');
  const hostSource = join(f.source, 'config/pi/skills/host-example');
  const state = join(requireEnv(f.env, 'KITTO_HOME'), 'state.json');
  for (const dir of [local, hostSource, join(f.source, 'skills/managed')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(local, 'SKILL.md'), 'local shared skill');
  writeFileSync(join(f.source, 'skills/managed/SKILL.md'), 'managed skill');
  writeFileSync(join(hostSource, 'SKILL.md'), 'host skill from source');
  mkdirSync(join(requireEnv(f.env, 'PI_CODING_AGENT_DIR'), 'skills'), { recursive: true });
  symlinkSync(local, hostLocal, 'dir');

  const setup = command(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { setup } from './dist/lib/kitto.mjs';
     await setup(${JSON.stringify({ source: f.source, agents: ['pi'], keepExistingSkills: true })});`,
    ],
    f.env,
  );
  good(setup);
  assert.match(setup.stdout, /skill keep: example \(shared\)/);
  assert.equal(readFileSync(join(local, 'SKILL.md'), 'utf8'), 'local shared skill');
  assert.equal(readJson(state).keepExistingSkills, true);
  assert.equal(readJson(state).schema, 2);
  assert.deepEqual(skillNames(readJson(state), 'shared', 'kept'), ['example']);
  assert.deepEqual(skillNames(readJson(state), 'pi', 'kept'), ['host-example']);
  assert.deepEqual(skillNames(readJson(state), 'shared', 'owned'), ['managed']);

  rmSync(source);
  good(f.maintain('sync', '--apply'));
  assert.deepEqual(skillNames(readJson(state), 'shared', 'kept'), ['example']);
  writeFileSync(source, 'local shared skill');
  good(f.maintain('sync', '--apply'));
  assert.deepEqual(skillNames(readJson(state), 'shared', 'owned'), ['managed']);
  writeFileSync(source, 'new source body');
  good(f.maintain('sync', '--apply'));
  assert.equal(readFileSync(join(local, 'SKILL.md'), 'utf8'), 'local shared skill');
  assert.equal(readFileSync(join(hostLocal, 'SKILL.md'), 'utf8'), 'local shared skill');
  writeFileSync(owned, 'local edit of managed skill');
  assert.match(f.maintain('sync', '--apply').stderr, /Skill conflict/);
  assert.equal(readFileSync(owned, 'utf8'), 'local edit of managed skill');
});

test('owned skill updates and removals apply, local modifications stop sync', (t) => {
  const f = fixture(t),
    target = join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example/SKILL.md');
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'new shared body');
  good(f.maintain('sync'));
  assert.doesNotMatch(readFileSync(target, 'utf8'), /new shared/);
  good(f.maintain('sync', '--apply'));
  assert.equal(readFileSync(target, 'utf8'), 'new shared body');
  writeFileSync(target, 'local edit');
  assert.notEqual(f.maintain('sync', '--apply').status, 0);
  assert.equal(readFileSync(target, 'utf8'), 'local edit');
  writeFileSync(target, 'new shared body');
  rmSync(join(f.source, 'skills/example'), { recursive: true });
  good(f.maintain('sync', '--apply'));
  assert.equal(existsSync(target), false);
});

test('foreign symlinks are preserved and rejected', (t) => {
  const f = fixture(t),
    target = join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example');
  mkdirSync(join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills'), { recursive: true });
  symlinkSync(f.temp, target);
  const result = f.cli('setup', '--agents', 'codex', '--source', f.source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /links elsewhere/);
});

test('failed native registration is resumable and holds no stale lock', (t) => {
  const f = fixture(t);
  f.env.FAIL_HOST = 'codex';
  assert.notEqual(f.cli('setup', '--agents', 'codex', '--source', f.source).status, 0);
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).ready, false);
  assert.equal(existsSync(join(requireEnv(f.env, 'KITTO_HOME'), '.lock')), false);
  delete f.env.FAIL_HOST;
  good(f.cli('setup'));
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).ready, true);
});
