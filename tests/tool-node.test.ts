import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameLocation } from '../lib/paths.ts';
import { get } from '../lib/ownership.ts';
import {
  applyLauncherRemoval,
  applyToolNode,
  launcherContent,
  planLauncherRemoval,
  planToolNode,
  resolveToolNode,
} from '../lib/tool-node.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

function scratch(t) {
  const base = mkdtempSync(join(tmpdir(), 'kitto-tool-node-'));
  const temp = join(base, 'real');
  mkdirSync(temp);
  const link = join(base, 'link');
  symlinkSync(temp, link);
  t.onTestFinished(() => rmSync(base, { recursive: true, force: true }));
  return link;
}

function stubNode(path, version) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho v${version}\n`, { mode: 0o755 });
}

function fakeMise(dir, answer) {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'mise.log');
  writeFileSync(
    join(dir, 'mise'),
    `#!/bin/sh\n{ pwd; env | grep '^MISE_' | sort; } > ${JSON.stringify(log)}\necho ${JSON.stringify(answer)}\n`,
    { mode: 0o755 },
  );
  return log;
}

test('mise global node resolves to the stable major symlink, run from home with project env cleared', async (t) => {
  const temp = scratch(t);
  const installs = join(temp, 'installs/node');
  stubNode(join(installs, '26.9.0/bin/node'), '26.9.0');
  symlinkSync('./26.9.0', join(installs, '26'));
  const bin = join(temp, 'bin');
  const log = fakeMise(bin, join(installs, '26.9.0/bin/node'));
  const home = join(temp, 'home');
  mkdirSync(home);
  const env = { PATH: `${bin}:/usr/bin:/bin`, MISE_NODE_VERSION: '18', MISE_DATA_DIR: join(temp, 'data') };
  const resolved = await resolveToolNode({ env, home, floor: '26.0.0' });
  assert.deepEqual(resolved, { path: join(installs, '26/bin/node'), version: '26.9.0', source: 'mise' });
  const [cwd, ...vars] = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(sameLocation(cwd, home));
  assert.deepEqual(vars, [`MISE_DATA_DIR=${join(temp, 'data')}`]);
});

test('mise without a major symlink keeps the reported path', async (t) => {
  const temp = scratch(t);
  const node = join(temp, 'installs/node/26.9.0/bin/node');
  stubNode(node, '26.9.0');
  const bin = join(temp, 'bin');
  fakeMise(bin, node);
  const resolved = await resolveToolNode({ env: { PATH: `${bin}:/usr/bin:/bin` }, home: temp, floor: '26.0.0' });
  assert.equal(resolved.path, node);
});

test('without mise the running node is used and its version is verified', async (t) => {
  const temp = scratch(t);
  const resolved = await resolveToolNode({ env: { PATH: join(temp, 'empty') }, home: temp });
  assert.equal(resolved.source, 'execPath');
  assert.equal(resolved.path, process.execPath);
  assert.equal(resolved.version, process.versions.node);
});

test('a too-old mise node is skipped for the running node', async (t) => {
  const temp = scratch(t);
  const node = join(temp, 'installs/node/18.20.4/bin/node');
  stubNode(node, '18.20.4');
  const bin = join(temp, 'bin');
  fakeMise(bin, node);
  const resolved = await resolveToolNode({ env: { PATH: `${bin}:/usr/bin:/bin` }, home: temp });
  assert.equal(resolved.source, 'execPath');
});

test('no suitable node fails with an actionable message', async (t) => {
  const temp = scratch(t);
  const old = join(temp, 'old/bin/node');
  stubNode(old, '18.20.4');
  await assert.rejects(
    resolveToolNode({ env: { PATH: join(temp, 'empty') }, home: temp, execPath: old, floor: '26.0.0' }),
    /No Node >=26\.0\.0.*v18\.20\.4.*rerun kitto setup/s,
  );
});

test('a missing recorded node makes the launcher explain itself and exit 127', (t) => {
  const temp = scratch(t);
  const launcher = join(temp, 'kitto-node');
  writeFileSync(launcher, launcherContent(join(temp, "gone node's/bin/node")), { mode: 0o755 });
  const result = spawnSync(launcher, ['--version'], { encoding: 'utf8' });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /Rerun kitto setup/);
});

test('launcher deploy runs the recorded node with every argument, preserves foreign files and is removed on detach', async (t) => {
  const temp = scratch(t);
  const agentsHome = join(temp, '.agents');
  const state = { agentsHome };
  const toolNode = { path: process.execPath, version: process.versions.node, source: 'execPath' };
  const plan = await planToolNode(state, toolNode);
  assert.equal(plan.action, 'write');
  assert.equal(existsSync(plan.target), false, 'planning must not write');
  assert.equal(state.toolNode, undefined);
  await applyToolNode(state, plan);
  assert.deepEqual(state.toolNode, toolNode);
  assert.equal(lstatSync(plan.target).mode & 0o777, 0o755);
  assert.equal(get(state, 'launcher', 'shared', 'kitto-node').status, 'owned');
  const run = spawnSync(plan.target, ['-p', 'process.argv.length + process.argv[1]', 'a b'], { encoding: 'utf8' });
  assert.equal(run.stdout.trim(), '2a b');
  assert.equal((await planToolNode(state, toolNode)).action, 'same');
  chmodSync(plan.target, 0o644);
  assert.equal((await planToolNode(state, toolNode)).action, 'write');

  const removal = await planLauncherRemoval(state);
  assert.equal(removal.action, 'remove');
  await applyLauncherRemoval(state, removal);
  assert.equal(existsSync(plan.target), false);
  assert.equal(get(state, 'launcher', 'shared', 'kitto-node'), undefined);
  assert.equal(state.toolNode, undefined);

  mkdirSync(join(agentsHome, 'bin'), { recursive: true });
  writeFileSync(plan.target, '#!/bin/sh\necho mine\n', { mode: 0o755 });
  const foreign = await planToolNode(state, toolNode);
  assert.equal(foreign.action, 'keep');
  await applyToolNode(state, foreign);
  assert.equal(readFileSync(plan.target, 'utf8'), '#!/bin/sh\necho mine\n');
  assert.equal(get(state, 'launcher', 'shared', 'kitto-node'), undefined);
  assert.equal((await planLauncherRemoval(state)).action, 'keep');
});

test('a launcher edited after deployment is preserved', async (t) => {
  const temp = scratch(t);
  const state = { agentsHome: join(temp, '.agents') };
  const toolNode = { path: process.execPath, version: process.versions.node, source: 'execPath' };
  const plan = await planToolNode(state, toolNode);
  await applyToolNode(state, plan);
  writeFileSync(plan.target, `${plan.content}# local edit\n`);
  assert.equal((await planToolNode(state, toolNode)).action, 'keep');
});

test('every command in skill text that runs Kitto-shipped Node code goes through the launcher', () => {
  const files = [
    'integration/skills/kitto/SKILL.md',
    'skills/context-budget/SKILL.md',
    'skills/jev-decide/SKILL.md',
    'config/instructions/common.md',
    'config/dsh/AGENTS.md',
  ];
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(text, /(^|[`\s])node (~|KITTO_|\/)/m, `${file} runs a bare node`);
    for (const line of text
      .split('\n')
      .filter((entry) => /\.agents\/skills\/[\w-]+\/scripts\//.test(entry) && /^\s*(node|~)/.test(entry))) {
      assert.match(line, /^\s*~\/\.agents\/bin\/kitto-node /, `${file}: ${line}`);
    }
  }
  const kitto = readFileSync(join(root, 'integration/skills/kitto/SKILL.md'), 'utf8');
  assert.match(kitto, /^KITTO_NODE KITTO_RUNNER status$/m);
  assert.match(kitto, /^KITTO_NODE KITTO_CLI route --help$/m);
});
