import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { root, dist, cliTimeout, command, fixture, good, readJson } from './helpers/kitto-fixture.ts';
import { type ComponentRow, requireEnv } from './helpers/kitto-suite.ts';

test('native removal is previewable and repeatable, preserves personal assets and allows reinstall', (t) => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex,dsh', '--source', f.source));
  good(f.maintain('sync', '--apply'));
  const codexFile = join(requireEnv(f.env, 'CODEX_HOME'), '_fake-codex.json'),
    other = readJson(codexFile);
  other.installed.push({ pluginId: 'other@personal', marketplaceName: 'personal' });
  other.marketplaces.push({ name: 'personal', root: '/other' });
  writeFileSync(codexFile, JSON.stringify(other));
  const dshFile = join(requireEnv(f.env, 'DSH_HOME'), 'profiles/web/package.json'),
    profile = readJson(dshFile);
  profile.dependencies.other = '1.0.0';
  profile.dsh.profile.bundles.push('other');
  writeFileSync(dshFile, JSON.stringify(profile));
  const sourceHead = command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout;
  const files = [
    codexFile,
    dshFile,
    join(requireEnv(f.env, 'PI_CODING_AGENT_DIR'), 'settings.json'),
    join(requireEnv(f.env, 'KITTO_HOME'), 'state.json'),
  ];
  const before = files.map((file) => readFileSync(file, 'utf8'));
  good(f.maintain('remove'));
  assert.deepEqual(
    files.map((file) => readFileSync(file, 'utf8')),
    before,
  );
  good(f.maintain('remove', '--apply'));
  good(f.maintain('remove', '--apply'));
  assert.equal(readJson(files[3]).detached, true);
  assert.deepEqual(
    readJson(codexFile).installed.map((x: { pluginId: string }) => x.pluginId),
    ['other@personal'],
  );
  assert.deepEqual(
    readJson(codexFile).marketplaces.map((x: { name: string }) => x.name),
    ['personal'],
  );
  assert.equal(readJson(dshFile).dependencies.other, '1.0.0');
  assert(readJson(dshFile).dsh.profile.bundles.includes('other'));
  assert.equal(readJson(files[2]).packages.length, 0);
  assert.doesNotMatch(readFileSync(join(f.source, 'config/pi/local/packages.txt'), 'utf8'), /kitto\/runtime/);
  assert.equal(command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout, sourceHead);
  assert(existsSync(join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example/SKILL.md')));
  assert.match(f.maintain('sync', '--apply').stderr, /detached/);
  good(f.cli('setup'));
  assert.equal(readJson(files[3]).ready, true);
  assert.equal(readJson(files[3]).detached, false);
  assert(readJson(codexFile).installed.some((x: { pluginId: string }) => x.pluginId === 'kitto@phyzess-kitto'));
});

test('partially completed removal resumes after a native failure without needing the source checkout', (t) => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex,dsh', '--source', f.source));
  f.env.FAIL_HOST = 'codex';
  f.env.FAIL_ACTION = 'remove';
  f.env.FAIL_STAGE = 'marketplace';
  assert.notEqual(f.maintain('remove', '--apply').status, 0);
  const path = join(requireEnv(f.env, 'KITTO_HOME'), 'state.json');
  assert.deepEqual(readJson(path).removedAgents, ['pi']);
  assert.equal(readJson(path).removing, true);
  assert.equal(existsSync(join(requireEnv(f.env, 'KITTO_HOME'), '.lock')), false);
  rmSync(f.source, { recursive: true });
  delete f.env.FAIL_HOST;
  good(f.maintain('remove', '--apply'));
  assert.equal(readJson(path).detached, true);
  const calls = readFileSync(f.log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(calls.filter((x) => x.command === 'pi' && x.args[0] === 'remove').length, 1);
  good(f.maintain('status'));
});

test('foreign native registration stops removal before detaching any host', (t) => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'pi,codex', '--source', f.source));
  const file = join(requireEnv(f.env, 'CODEX_HOME'), '_fake-codex.json'),
    data = readJson(file);
  data.marketplaces[0].root = '/foreign';
  writeFileSync(file, JSON.stringify(data));
  assert.match(f.maintain('remove', '--apply').stderr, /another location/);
  assert.equal(readJson(join(requireEnv(f.env, 'PI_CODING_AGENT_DIR'), 'settings.json')).packages.length, 1);
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).ready, true);
  const alias = join(f.temp, 'kitto-alias');
  symlinkSync(requireEnv(f.env, 'KITTO_HOME'), alias);
  data.marketplaces[0].root = alias;
  writeFileSync(file, JSON.stringify(data));
  good(f.maintain('remove', '--apply'));
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).detached, true);
});

for (const agent of ['codex', 'dsh']) {
  test(`${agent}-only setup, sync and versions work without unneeded Pi files, Bash or Python`, (t) => {
    const f = fixture(t);
    if (agent === 'codex') {
      for (const name of ['settings.json', 'AGENTS.md', 'i-have-adhd-always']) rmSync(join(f.source, `config/pi/${name}`));
    } else rmSync(join(f.source, 'config/pi'), { recursive: true });
    const bin = join(f.temp, 'bin');
    const git = command('which', ['git'], f.env).stdout.trim();
    symlinkSync(git, join(bin, 'git'));
    f.env.PATH = bin;
    const home = requireEnv(f.env, agent === 'codex' ? 'CODEX_HOME' : 'DSH_HOME');
    mkdirSync(join(f.source, 'config', agent, 'skills/host-example'), { recursive: true });
    writeFileSync(join(f.source, 'config', agent, 'skills/host-example/SKILL.md'), 'Host only');
    const source = join(f.source, 'config', agent, 'AGENTS.md');
    writeFileSync(source, 'Portable rules');
    mkdirSync(home, { recursive: true });
    const instructions = join(home, 'AGENTS.md');
    writeFileSync(instructions, 'My local rules\n');
    const options = agent === 'dsh' ? ['--dsh-profile', 'headless'] : [];
    good(f.cli('setup', '--agents', agent, '--source', f.source, ...options));
    assert.match(readFileSync(instructions, 'utf8'), /My local rules\n[\s\S]*Portable rules/);
    assert.equal(readFileSync(join(home, 'skills/host-example/SKILL.md'), 'utf8'), 'Host only');
    assert(!existsSync(join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/host-example')));
    const versions = f.maintain('versions');
    good(versions);
    const report = JSON.parse(versions.stdout);
    assert(report.components.some((row: ComponentRow) => row.owner === agent && row.tested));
    assert(!report.components.some((row: ComponentRow) => row.owner === 'pi' || row.upstream));
    assert(report.components.some((row: ComponentRow) => row.owner === agent && row.kind === 'skill' && row.contentSha256));
    good(f.maintain('deps', '--apply'));
    assert(!existsSync(requireEnv(f.env, 'PI_CODING_AGENT_DIR')));
    writeFileSync(source, 'Updated portable rules');
    good(f.maintain('sync', '--apply'));
    assert.match(readFileSync(instructions, 'utf8'), /My local rules\n[\s\S]*Updated portable rules/);
    const updated = readFileSync(instructions, 'utf8');
    writeFileSync(instructions, updated.replace('Updated portable rules', 'Edited locally'));
    assert.match(f.maintain('sync', '--apply').stderr, /Local changes inside/);
    assert.match(readFileSync(instructions, 'utf8'), /Edited locally/);
    if (agent === 'dsh') {
      writeFileSync(instructions, updated);
      const path = join(home, 'profiles/headless/package.json');
      assert(readJson(path).dependencies['@phyzess/kitto']);
      assert(report.components.some((row: ComponentRow) => row.profile === 'headless' && row.name === '@phyzess/kitto'));
      good(f.cli('setup'));
      good(f.maintain('remove', '--apply'));
      assert(!readJson(path).dependencies['@phyzess/kitto']);
      assert(!existsSync(join(home, 'profiles/web')));
    }
  });
}

test('dependency previews use enabled Pi MCP commands and deduplicate shared tools', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.source, 'skills/codegraph'));
  writeFileSync(join(f.source, 'skills/codegraph/SKILL.md'), 'CodeGraph skill');
  writeFileSync(
    join(f.source, 'config/dependencies.json'),
    JSON.stringify([
      { skill: 'codegraph', executable: 'codegraph' },
      { piCommand: 'codegraph', executable: 'codegraph' },
      { piCommand: 'dap-mcp-server', executable: 'dap-mcp-server', install: { mise: 'npm:dap-mcp-server@0.1.17' } },
    ]),
  );
  writeFileSync(
    join(f.source, 'config/pi/mcp.json'),
    JSON.stringify({
      mcpServers: {
        codegraph: { command: 'codegraph' },
        debug: { command: 'dap-mcp-server', enabled: false },
      },
    }),
  );
  good(f.cli('setup', '--agents', 'pi,codex', '--source', f.source));
  const preview = f.maintain('deps');
  good(preview);
  assert.equal(preview.stdout.match(/(?:Missing|Available): codegraph/g)?.length, 1);
  assert.match(preview.stdout, /shared skill codegraph, Pi MCP codegraph/);
  assert.doesNotMatch(preview.stdout, /dap-mcp-server/);
  const file = join(requireEnv(f.env, 'PI_CODING_AGENT_DIR'), 'mcp.json');
  const config = readJson(file);
  config.mcpServers.debug.enabled = true;
  writeFileSync(file, JSON.stringify(config));
  const enabled = f.maintain('deps');
  good(enabled);
  assert.match(enabled.stdout, /dap-mcp-server.*Pi MCP debug/);
});

test('first setup retries from its own clone and rejects unregistered or changed remotes', (t) => {
  const f = fixture(t),
    mirror = join(f.temp, 'remote.git');
  good(command('git', ['clone', '--bare', f.source, mirror], f.env));
  const config = join(f.temp, 'gitconfig'),
    url = 'https://kitto.invalid/config.git';
  writeFileSync(config, '');
  f.env.GIT_CONFIG_GLOBAL = config;
  good(command('git', ['config', '--file', config, `url.${mirror}.insteadOf`, url], f.env));
  const conflict = join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example');
  mkdirSync(conflict, { recursive: true });
  writeFileSync(join(conflict, 'SKILL.md'), 'local work');
  const args = ['setup', '--agents', 'codex', '--source', url, '--ref', 'main'];
  const managed = join(requireEnv(f.env, 'KITTO_HOME'), 'config');
  mkdirSync(managed, { recursive: true });
  assert.match(f.cli(...args).stderr, /Unregistered checkout/);
  rmSync(managed, { recursive: true });
  assert.match(f.cli(...args).stderr, /Skill conflict/);
  assert(!existsSync(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')));
  rmSync(conflict, { recursive: true });
  good(command('git', ['remote', 'set-url', 'origin', 'https://kitto.invalid/another.git'], f.env, managed));
  assert.match(f.cli(...args).stderr, /Unregistered checkout/);
  good(command('git', ['remote', 'set-url', 'origin', url], f.env, managed));
  writeFileSync(join(managed, 'local-note'), 'preserve this');
  const retried = f.cli(...args);
  good(retried);
  assert.match(retried.stdout, /Resume setup/);
  assert.equal(readFileSync(join(managed, 'local-note'), 'utf8'), 'preserve this');
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).ready, true);
});

test('dependency apply reports missing installers and checks successful installs', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.source, 'config/dependencies.json'),
    JSON.stringify([{ piCommand: 'dap-mcp-server', executable: 'dap-mcp-server', install: { mise: 'npm:dap-mcp-server@0.1.17' } }]),
  );
  writeFileSync(join(f.source, 'config/pi/mcp.json'), '{"mcpServers":{"debug":{"command":"dap-mcp-server"}}}');
  good(f.cli('setup', '--agents', 'pi', '--source', f.source));
  const bin = join(f.temp, 'bin');
  const git = command('which', ['git'], f.env).stdout.trim();
  symlinkSync(git, join(bin, 'git'));
  f.env.PATH = bin;
  const preview = f.maintain('deps');
  good(preview);
  assert.match(preview.stdout, /Missing installer mise/);
  const blocked = f.maintain('deps', '--apply');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stdout, /Unresolved managed dependencies: dap-mcp-server \(missing mise\)/);
  writeFileSync(join(bin, 'mise'), `#!${process.execPath}\nif (process.argv[2] === "current") console.log("0.1.17");\n`, { mode: 0o755 });
  const unavailable = f.maintain('deps', '--apply');
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stdout, /still unavailable after install/);
  writeFileSync(join(bin, 'dap-mcp-server'), `#!${process.execPath}\n`, { mode: 0o755 });
  const ready = f.maintain('deps', '--apply');
  good(ready);
  assert.match(ready.stdout, /Ready: dap-mcp-server/);
});

test('tag install pins a snapshot and managed setup can switch it without losing local changes', (t) => {
  const f = fixture(t),
    mirror = join(f.temp, 'remote.git');
  const homeAlias = join(f.temp, 'home-alias');
  symlinkSync(f.home, homeAlias, 'dir');
  f.env.KITTO_HOME = join(homeAlias, 'kitto');
  const git = (...args: string[]) => command('git', args, f.env, f.source);
  const first = git('rev-parse', 'HEAD').stdout.trim();
  good(git('tag', 'v1'));
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'second snapshot');
  good(git('add', '.'));
  good(git('commit', '-m', 'second snapshot'));
  const second = git('rev-parse', 'HEAD').stdout.trim();
  good(git('tag', 'v2'));
  good(git('clone', '--bare', f.source, mirror));
  const config = join(f.temp, 'gitconfig'),
    url = 'https://kitto.invalid/config.git';
  writeFileSync(config, '');
  f.env.GIT_CONFIG_GLOBAL = config;
  good(git('config', '--file', config, `url.${mirror}.insteadOf`, url));
  good(f.cli('setup', '--agents', 'codex', '--source', url, '--ref', 'v1'));
  const state = () => readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json'));
  assert.deepEqual(state().deployed, { commit: first, dirty: false, detached: true });
  assert.match(f.maintain('update', '--apply').stderr, /pinned to a detached revision/);
  const note = join(state().source, 'local-note');
  writeFileSync(note, 'local work');
  assert.match(f.cli('setup', '--ref', 'v2').stderr, /local changes/);
  assert.equal(readFileSync(note, 'utf8'), 'local work');
  rmSync(note);
  const deployedSkill = join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example/SKILL.md');
  const original = readFileSync(deployedSkill, 'utf8');
  writeFileSync(deployedSkill, 'manual change');
  assert.match(f.cli('setup', '--ref', 'v2').stderr, /Skill conflict/);
  assert.equal(state().deployed.commit, first);
  writeFileSync(deployedSkill, original);
  good(f.cli('setup', '--ref', 'v2'));
  assert.equal(state().deployed.commit, second);
  assert.equal(readFileSync(deployedSkill, 'utf8'), 'second snapshot');
});

test('dependency declarations follow the selected host and reject conflicting versions', (t) => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  const manifest = join(f.source, 'config/dependencies.json');
  const rule = { agent: 'codex', executable: 'test-tool', install: { mise: 'npm:test-tool@1.2.3' } };
  writeFileSync(manifest, JSON.stringify([rule, rule, { agent: 'pi', executable: 'pi-only' }]));
  const preview = f.maintain('deps');
  good(preview);
  assert.equal(preview.stdout.split('\n').filter((line) => line.includes('test-tool')).length, 1);
  assert.doesNotMatch(preview.stdout, /pi-only/);
  writeFileSync(manifest, JSON.stringify([rule, { ...rule, install: { mise: 'npm:test-tool@2.0.0' } }]));
  assert.match(f.maintain('deps', '--apply').stderr, /Conflicting dependency declarations/);
});

test('interactive CLI previews and applies bundled Pi and Codex setup for future workspaces', async (t) => {
  const { realpath } = await import('node:fs/promises');
  const f = fixture(t);
  const workspaceParent = join(await realpath(f.temp), 'workspaces');
  const result = spawnSync(process.execPath, [join(dist, 'bin/kitto.mjs'), 'setup', '--interactive'], {
    env: f.env,
    cwd: root,
    encoding: 'utf8',
    timeout: cliTimeout,
    input: ['pi,codex', '2', f.source, 'n', workspaceParent, '1', '2', ''].join('\n'),
  });
  good(result);
  assert.match(result.stdout, /安装计划[\s\S]*Preview only[\s\S]*预览完成[\s\S]*Scope ready/);
  const state = readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json'));
  assert.equal(state.ready, true);
  assert.deepEqual(state.agents, ['pi', 'codex']);
  assert.equal(state.source, await realpath(f.source));
  assert.equal(
    readFileSync(join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example/SKILL.md'), 'utf8'),
    readFileSync(join(f.source, 'skills/example/SKILL.md'), 'utf8'),
  );
  assert.equal(existsSync(join(requireEnv(f.env, 'PI_CODING_AGENT_DIR'), 'mcp.json')), true);
  const calls = readFileSync(f.log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(calls.some((c) => c.command === 'pi' && c.args[0] === 'install'));
  assert(calls.some((c) => c.command === 'codex' && c.args.join(' ') === 'plugin add kitto@phyzess-kitto'));

  const registry = readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'scopes.json'));
  assert.equal(registry.global, true);
  assert.deepEqual(registry.workspaceParents, [workspaceParent]);
  const workspace = join(workspaceParent, 'future-team');
  const project = join(workspace, 'repo');
  const skills = join(workspace, '.agents', 'skills');
  const skillName = 'future-workspace-skill';
  mkdirSync(join(skills, skillName), { recursive: true });
  writeFileSync(join(skills, skillName, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Fixture skill\n---\nSkill body\n`);
  writeFileSync(join(workspace, 'AGENTS.md'), 'Future workspace instructions');
  good(command('git', ['clone', '-q', f.source, project], f.env));

  const nativeEnv = { ...f.env };
  delete nativeEnv.KITTO_HOME;
  const extension = join(requireEnv(f.env, 'PI_CODING_AGENT_DIR'), 'extensions/kitto-scopes.js');
  const pi = command(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    const handlers = new Map();
    const extension = await import(process.argv[1]);
    extension.default({ on: (event, handler) => handlers.set(event, handler) });
    const cwd = process.cwd();
    const contextFiles = [];
    await handlers.get('before_agent_start')({ systemPromptOptions: { contextFiles } }, { cwd });
    const { skillPaths } = await handlers.get('resources_discover')({ cwd });
    console.log(JSON.stringify({ contextFiles, skillPaths }));
  `,
      extension,
    ],
    nativeEnv,
    project,
  );
  good(pi);
  const { contextFiles, skillPaths } = JSON.parse(pi.stdout);
  assert(contextFiles.some((file: { content: string }) => file.content === 'Future workspace instructions'));
  assert(skillPaths.includes(skills));

  const hooks = readJson(join(requireEnv(f.env, 'CODEX_HOME'), 'hooks.json'));
  const hook = hooks.hooks.SessionStart[0].hooks[0].command;
  const codex = spawnSync('sh', ['-c', hook], {
    cwd: project,
    env: nativeEnv,
    encoding: 'utf8',
    timeout: 8_000,
    input: JSON.stringify({ cwd: project }),
  });
  good(codex);
  const { additionalContext } = JSON.parse(codex.stdout).hookSpecificOutput;
  assert.match(additionalContext, /Future workspace instructions/);
  assert.match(additionalContext, /future-workspace-skill/);
  assert.equal(command('git', ['status', '--porcelain'], f.env, project).stdout, '');
});

test('interactive DSH Desktop setup stays global-only and skips scoped adapters', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.source, 'config/dsh/skills/desktop-example'), { recursive: true });
  writeFileSync(join(f.source, 'config/dsh/skills/desktop-example/SKILL.md'), 'Desktop host skill');
  writeFileSync(join(f.source, 'config/dsh/AGENTS.md'), 'Desktop portable rules');
  writeFileSync(join(f.temp, 'bin/pnpm'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [join(dist, 'bin/kitto.mjs'), 'setup', '--interactive'], {
    env: f.env,
    cwd: root,
    encoding: 'utf8',
    timeout: cliTimeout,
    input: ['dsh', 'desktop', '2', f.source, 'n', '', '2'].join('\n'),
  });
  good(result);
  assert.match(result.stdout, /DSH Desktop 由 App 管理/);
  assert.match(result.stdout, /环境配置已完成/);
  assert.doesNotMatch(result.stdout, /Connect native Kitto integrations/);
  assert.doesNotMatch(result.stdout, /DSH scope registration will run/);
  assert.equal(readJson(join(requireEnv(f.env, 'KITTO_HOME'), 'state.json')).dshProfile, 'desktop');
  assert.match(readFileSync(join(requireEnv(f.env, 'DSH_HOME'), 'AGENTS.md'), 'utf8'), /Desktop portable rules/);
  assert.equal(existsSync(join(requireEnv(f.env, 'KITTO_HOME'), 'scopes.json')), false);
  assert.equal(existsSync(join(requireEnv(f.env, 'DSH_HOME'), 'profiles/desktop')), false);
  const calls = readFileSync(f.log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(!calls.some((c) => c.command === 'dsh' && c.args.includes('add')));
  assert(!calls.some((c) => c.command === 'pnpm'));
});
