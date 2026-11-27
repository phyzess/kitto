import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDependencies } from '../lib/dependencies.mjs';
import { piAdapter } from '../lib/pi-adapter.mjs';
import {
  composeAgents, exportMcp, extractAgents, mergeMcp, mergeSettings, readList, recordSettings, sanitizeSettings,
} from '../lib/pi-settings.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(path, 'utf8');
const readJson = path => JSON.parse(read(path));
const put = (path, data) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(data)); return path; };
const boundary = '<!-- kitto:host-addendum -->';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'kitto-adapter-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo with ' quote"), home = join(base, 'home'), bin = join(base, 'bin');
  mkdirSync(join(repo, 'skills'), { recursive: true });
  mkdirSync(home);
  mkdirSync(bin);
  cpSync(join(root, 'config'), join(repo, 'config'), { recursive: true, filter: path => !path.includes('/config/pi/local') });
  const installLog = join(base, 'installs.log');
  writeFileSync(join(bin, 'pi'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'list') { if (fs.existsSync(${JSON.stringify(installLog)})) process.stdout.write(fs.readFileSync(${JSON.stringify(installLog)})); process.exit(0); }
if (process.argv[2] === 'install') { fs.appendFileSync(${JSON.stringify(installLog)}, process.argv[3] + '\\n'); process.exit(Number(process.env.FAKE_PI_INSTALL_EXIT || 0)); }
`, { mode: 0o755 });
  const env = { ...process.env, HOME: home, SHELL: '/bin/sh', PATH: `${bin}:${process.env.PATH}` };
  const f = {
    base, repo, home, bin, env, installLog,
    pi: join(home, '.pi/agent'), agents: join(home, '.agents'),
    local: join(repo, 'config/pi/local'), machine: join(home, '.pi/agent/settings.json'), shared: join(repo, 'config/pi/settings.json'),
  };
  f.run = (command, extra = {}) => {
    const lines = [];
    const log = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    let error = null;
    const previousPath = process.env.PATH;
    process.env.PATH = f.env.PATH;
    try {
      piAdapter(command, { source: repo, piHome: f.pi, agentsHome: f.agents, home, env: f.env, ...extra });
    } catch (caught) { error = caught; } finally { console.log = log; process.env.PATH = previousPath; }
    return { output: lines.join('\n'), error };
  };
  f.ok = (command, extra) => {
    const result = f.run(command, extra);
    assert.equal(result.error, null, result.output + (result.error?.message ?? ''));
    return result;
  };
  f.snapshot = () => Object.fromEntries(readdirSync(base, { recursive: true }).map(name => {
    const path = join(base, name);
    return [relative(base, path), statSync(path).isFile() ? readFileSync(path).toString('latin1') : null];
  }));
  return f;
}

test('preview and status do not write', t => {
  const f = fixture(t);
  put(f.machine, { packages: ['npm:personal'] });
  const before = f.snapshot();
  f.ok('status');
  f.ok('pull', { dryRun: true });
  assert.deepEqual(f.snapshot(), before);
});

test('a clean-home preview does not create destinations', t => {
  const f = fixture(t);
  const before = f.snapshot();
  f.ok('pull', { dryRun: true });
  assert.deepEqual(f.snapshot(), before);
  assert.equal(existsSync(f.installLog), false);
});

test('a source without the shared layer fails clearly', t => {
  const f = fixture(t);
  rmSync(join(f.repo, 'config/instructions/common.md'));
  const result = f.run('pull');
  assert.match(result.error.message, /missing shared instructions/);
  assert.equal(existsSync(join(f.pi, 'AGENTS.md')), false);
  assert.equal(existsSync(join(f.local, '.sync-lock')), false);
});

test('Pi AGENTS composes shared rules before the Pi addendum', t => {
  const f = fixture(t);
  f.ok('pull');
  const common = read(join(f.repo, 'config/instructions/common.md')).trim();
  const addendum = read(join(f.repo, 'config/pi/AGENTS.md')).trim();
  const text = read(join(f.pi, 'AGENTS.md'));
  assert(text.startsWith(common));
  assert.equal(text.split(common).length - 1, 1);
  assert(text.includes(addendum));
  assert.equal(text.split('## Pi 专属补充').length - 1, 1);
  assert.equal(text.split(boundary).length - 1, 1);
  const repoAddendum = read(join(f.repo, 'config/pi/AGENTS.md'));
  assert(!repoAddendum.includes('# 共享工作规则'));
  assert(repoAddendum.startsWith('## Pi 专属补充'));
  assert.equal(statSync(join(f.pi, 'AGENTS.md')).mode & 0o777, 0o600);
});

test('Pi push exports only the Pi addendum', t => {
  const f = fixture(t);
  f.ok('pull');
  const machine = join(f.pi, 'AGENTS.md');
  writeFileSync(machine, read(machine).replace('## Pi 专属补充', '## Pi 专属补充（本机修改）'));
  f.ok('push');
  const exported = read(join(f.repo, 'config/pi/AGENTS.md'));
  assert(exported.includes('（本机修改）'));
  assert(!exported.includes('# 共享工作规则'));
});

test('Pi push preview does not write shared rules back', t => {
  const f = fixture(t);
  f.ok('pull');
  const machine = join(f.pi, 'AGENTS.md');
  writeFileSync(machine, read(machine).replace('## Pi 专属补充', '## Pi 专属补充（预览）'));
  const before = f.snapshot();
  const result = f.ok('push', { dryRun: true });
  assert.match(result.output, /\[dry-run\] cp -f/);
  assert.deepEqual(f.snapshot(), before);
});

function refusal(t, mutate, pattern, { touchSettings = false } = {}) {
  const f = fixture(t);
  f.ok('pull');
  mutate(f);
  if (touchSettings) put(f.machine, { ...readJson(f.machine), theme: 'light' });
  const settingsBefore = read(f.shared), agentsBefore = read(join(f.repo, 'config/pi/AGENTS.md'));
  const result = f.run('push');
  assert(result.error, 'push must refuse');
  assert.match(result.error.message, pattern);
  assert.equal(read(f.shared), settingsBefore);
  assert.equal(read(join(f.repo, 'config/pi/AGENTS.md')), agentsBefore);
  assert.equal(existsSync(join(f.local, '.sync-lock')), false);
}

test('Pi push refuses AGENTS without the shared prefix', t => {
  refusal(t, f => writeFileSync(join(f.pi, 'AGENTS.md'), '# legacy whole-file AGENTS\n'), /host-specific section/);
});

test('Pi push refuses a truncated shared layer', t => {
  refusal(t, f => {
    const common = join(f.repo, 'config/instructions/common.md');
    writeFileSync(common, `${read(common).trimEnd().split('\n').slice(0, -1).join('\n')}\n`);
  }, /shared rules differ/);
});

test('Pi push refuses a whole-section truncation', t => {
  refusal(t, f => {
    const common = join(f.repo, 'config/instructions/common.md');
    const text = read(common), marker = '\n## 会话开始\n';
    assert(text.includes(marker));
    writeFileSync(common, `${text.slice(0, text.indexOf(marker))}\n`);
  }, /shared rules differ/, { touchSettings: true });
});

test('Pi push refuses a composition without the boundary', t => {
  refusal(t, f => {
    const common = read(join(f.repo, 'config/instructions/common.md')).trim();
    const addendum = read(join(f.repo, 'config/pi/AGENTS.md')).trim();
    writeFileSync(join(f.pi, 'AGENTS.md'), `${common}\n\n${addendum}\n`);
  }, /host-specific section/);
});

test('Pi push validates AGENTS before writing the repository', t => {
  refusal(t, f => {
    const common = join(f.repo, 'config/instructions/common.md');
    writeFileSync(common, `${read(common).trimEnd().split('\n').slice(0, -1).join('\n')}\n`);
  }, /shared rules differ/, { touchSettings: true });
});

test('Pi push accepts a BOM and CRLF deployed file', t => {
  const f = fixture(t);
  f.ok('pull');
  const machine = join(f.pi, 'AGENTS.md');
  writeFileSync(machine, `﻿${read(machine).replaceAll('\n', '\r\n')}`);
  f.ok('push');
  const exported = read(join(f.repo, 'config/pi/AGENTS.md'));
  assert(!exported.includes('\r'));
  assert(exported.startsWith('## Pi 专属补充'));
});

test('a shared rule change flows into the Pi AGENTS file', t => {
  const f = fixture(t);
  f.ok('pull');
  const common = join(f.repo, 'config/instructions/common.md');
  writeFileSync(common, `${read(common)}\n- new shared rule marker\n`);
  f.ok('pull');
  const text = read(join(f.pi, 'AGENTS.md'));
  assert.equal(text.split('new shared rule marker').length - 1, 1);
  assert(text.includes('## Pi 专属补充'));
});

test('compose and extract agents helpers enforce the canonical composition', t => {
  const { base } = fixture(t);
  const common = join(base, 'common.md'), addendum = join(base, 'addendum.md'), out = join(base, 'out.md'), extracted = join(base, 'extracted.md');
  writeFileSync(common, '﻿# Shared\r\n\r\n- one\r\n');
  writeFileSync(addendum, '## Host\r\n\r\n- two\r\n');
  composeAgents(common, addendum, out);
  assert.equal(read(out), `# Shared\n\n- one\n\n${boundary}\n\n## Host\n\n- two\n`);
  assert.match(extractAgents(out, common, extracted), /exported/);
  assert.equal(read(extracted), '## Host\n\n- two\n');
  writeFileSync(out, '# not composed\n');
  assert.throws(() => extractAgents(out, common, extracted), /no .* boundary/);
  writeFileSync(out, '# Shared\n');
  assert.throws(() => extractAgents(out, common, extracted));
  const truncated = join(base, 'common-truncated.md');
  writeFileSync(truncated, '# Shared\n');
  const tail = join(base, 'tail.md'), host = join(base, 'host.md');
  writeFileSync(tail, '# Shared\n\n## Tail\n\n- two\n');
  writeFileSync(host, '## Host\n\n- host\n');
  composeAgents(tail, host, out);
  assert.throws(() => extractAgents(out, truncated, extracted), /shared rules differ/);
  writeFileSync(out, '# Shared\n\n- one\n\n## Host\n\n- two\n');
  assert.throws(() => extractAgents(out, common, extracted));
  assert.equal(read(extracted), '## Host\n\n- two\n');
  writeFileSync(out, `# Shared\n\n- one\n\n${boundary}\n\n${boundary}\n\n## Host\n`);
  assert.throws(() => extractAgents(out, common, extracted), /more than one/);
  writeFileSync(addendum, `${boundary}\n`);
  assert.throws(() => composeAgents(common, addendum, out), /reserved shared\/host boundary/);
});

function merge(f) {
  mergeSettings(f.shared, f.machine, f.local, f.machine, { previous: f.owned ?? [] });
  f.owned = recordSettings(f.shared, f.machine, f.local);
}

test('pull hands the shared package list to the ledger callback and writes no managed-packages file', t => {
  const f = fixture(t);
  const shared = readJson(f.shared).packages;
  put(f.machine, { packages: [] });
  const recorded = [];
  f.ok('pull', { dryRun: true, onPackages: specs => recorded.push(specs) });
  assert.deepEqual(recorded, []);
  f.ok('pull', { onPackages: specs => recorded.push(specs) });
  assert.deepEqual(recorded, [shared]);
  assert.equal(existsSync(join(f.local, 'managed-packages.json')), false);
});

test('packages in the ownership list are not kept as machine-only extras', t => {
  const f = fixture(t);
  put(f.shared, { packages: [] });
  put(f.machine, { packages: ['npm:old-shared', 'npm:personal'] });
  f.ok('pull', { ownedPackages: ['npm:old-shared'] });
  assert.deepEqual(readJson(f.machine).packages, ['npm:personal']);
});

test('a removed shared package stays removed while a local one survives', t => {
  const f = fixture(t);
  put(f.shared, { packages: ['npm:shared'] });
  put(f.machine, { packages: ['npm:shared', 'npm:personal'] });
  merge(f);
  put(f.shared, { packages: [] });
  merge(f);
  assert.deepEqual(readJson(f.machine).packages, ['npm:personal']);
  merge(f);
  assert.deepEqual(readJson(f.machine).packages, ['npm:personal']);
});

test('a new machine package is preserved', t => {
  const f = fixture(t);
  put(f.shared, { packages: [] });
  put(f.machine, { packages: [] });
  merge(f);
  put(f.machine, { packages: ['npm:later'] });
  merge(f);
  assert.deepEqual(readJson(f.machine).packages, ['npm:later']);
});

test('object-form packages are not flattened by a pull', t => {
  const f = fixture(t);
  const entry = { source: 'npm:object-form', extensions: ['a'] };
  put(f.shared, { packages: [entry, 'npm:plain'] });
  put(f.machine, { packages: [], runtimeKey: 'keep', lastChangelogVersion: 'x' });
  merge(f);
  const merged = readJson(f.machine);
  assert.deepEqual(merged.packages, [entry, 'npm:plain']);
  assert.equal(merged.runtimeKey, 'keep');
  assert.equal(readFileSync(f.machine, 'utf8').endsWith('}\n'), true);
});

test('a git fragment survives the local list', t => {
  const f = fixture(t);
  mkdirSync(f.local, { recursive: true });
  const path = join(f.local, 'packages.txt');
  writeFileSync(path, '# comment\ngit:example/repo#v1.2.3\n');
  assert.deepEqual(readList(path), ['git:example/repo#v1.2.3']);
});

test('nested local overrides do not export', t => {
  const f = fixture(t);
  put(f.shared, { defaultModel: 'shared', nested: { a: 1, b: 2 } });
  put(join(f.local, 'settings.json'), { defaultModel: 'local', nested: { a: 99 }, secret: 'x' });
  put(f.machine, { defaultModel: 'local', nested: { a: 99, b: 3 }, secret: 'x', lastChangelogVersion: 'runtime' });
  const out = join(f.base, 'export.json');
  sanitizeSettings(f.machine, f.shared, f.local, out);
  const result = readJson(out);
  assert.equal(result.defaultModel, 'shared');
  assert.deepEqual(result.nested, { a: 1, b: 3 });
  assert(!('secret' in result));
  assert(!('lastChangelogVersion' in result));
});

test('MCP definition updates, switches and unknown servers survive a merge', t => {
  const { base } = fixture(t);
  const repo = put(join(base, 'repo.json'), { mcpServers: { x: { command: 'new', args: ['new'] } } });
  const machine = put(join(base, 'machine.json'), { other: true, mcpServers: { x: { command: 'old', args: ['old'], enabled: false }, personal: { command: 'mine' } } });
  const out = join(base, 'out.json');
  mergeMcp(repo, '', '', machine, out);
  const data = readJson(out);
  assert.deepEqual(data.mcpServers.x, { command: 'new', args: ['new'], enabled: false });
  assert('personal' in data.mcpServers);
  assert.equal(data.other, true);
});

test('an MCP local override is explicit', t => {
  const { base } = fixture(t);
  const repo = put(join(base, 'repo.json'), { mcpServers: { x: { command: 'new' } } });
  const machine = put(join(base, 'machine.json'), { mcpServers: { x: { enabled: false } } });
  const local = put(join(base, 'local.json'), { mcpServers: { x: { enabled: true } } });
  const out = join(base, 'out.json');
  mergeMcp(repo, '', local, machine, out);
  assert.equal(readJson(out).mcpServers.x.enabled, true);
});

test('platform-only servers merge from the platform overlay and stay out of exports', t => {
  const { base } = fixture(t);
  const repo = put(join(base, 'repo.json'), { mcpServers: { shared: { command: 'shared' } } });
  const platform = put(join(base, 'platform.json'), { mcpServers: { only: { command: 'mac' } } });
  const machine = join(base, 'machine.json');
  mergeMcp(repo, platform, '', machine, machine);
  assert.deepEqual(Object.keys(readJson(machine).mcpServers).sort(), ['only', 'shared']);
  const out = join(base, 'export.json');
  exportMcp(repo, machine, platform, '', '', out);
  assert.deepEqual(readJson(out), { mcpServers: { shared: { command: 'shared' } } });
});

test('export preserves a shared server that has a local override', t => {
  const { base } = fixture(t);
  const repo = put(join(base, 'repo.json'), { mcpServers: { x: { command: 'shared' } } });
  const local = put(join(base, 'local.json'), { mcpServers: { x: { command: 'local' } } });
  const out = join(base, 'out.json');
  exportMcp(repo, local, '', local, '', out);
  assert.deepEqual(readJson(out), readJson(repo));
});

test('export does not add unmanaged MCP servers or settings', t => {
  const f = fixture(t);
  const repo = put(join(f.base, 'repo.json'), { mcpServers: { shared: { command: 'shared' } } });
  const machine = put(join(f.base, 'machine.json'), {
    theme: 'light',
    mcpServers: { shared: { command: 'shared' }, personal: { command: 'npx', args: ['--token', 'sk-this-should-not-travel'] } },
  });
  const out = join(f.base, 'export.json');
  exportMcp(repo, machine, '', '', '', out);
  assert.deepEqual(readJson(out), { mcpServers: { shared: { command: 'shared' } } });
  const settings = put(join(f.base, 'settings.json'), { packages: [], theme: 'dark' });
  const machineSettings = put(join(f.base, 'machine-settings.json'), { packages: [], theme: 'light', apiKey: 'sk-this-should-not-travel' });
  const exported = join(f.base, 'settings-export.json');
  sanitizeSettings(machineSettings, settings, f.local, exported);
  const data = readJson(exported);
  assert(!('apiKey' in data));
  assert.equal(data.theme, 'light');
});

test('export refuses a literal secret in a declared entry', t => {
  const { base } = fixture(t);
  const repo = put(join(base, 'repo.json'), { mcpServers: { bad: { command: 'x', args: ['sk-this-should-not-travel'] } } });
  const out = join(base, 'export.json');
  assert.throws(() => exportMcp(repo, repo, '', '', '', out), /literal secret/);
  assert.equal(existsSync(out), false);
});

test('an existing ~/.pi-agent-env is preserved and pull is idempotent', t => {
  const f = fixture(t);
  writeFileSync(join(f.home, '.pi-agent-env'), 'SYNTHETIC_TOKEN=keep-me\n');
  f.ok('pull');
  const before = f.snapshot();
  f.ok('pull');
  assert.equal(read(join(f.home, '.pi-agent-env')), 'SYNTHETIC_TOKEN=keep-me\n');
  assert.deepEqual(f.snapshot(), before);
});

test('a new ~/.pi-agent-env has private permissions', t => {
  const f = fixture(t);
  f.ok('pull');
  assert.equal(statSync(join(f.home, '.pi-agent-env')).mode & 0o777, 0o600);
});

test('push ignores unmanaged skills and extensions', t => {
  const f = fixture(t);
  f.ok('pull');
  mkdirSync(join(f.agents, 'skills/third-party'), { recursive: true });
  writeFileSync(join(f.agents, 'skills/third-party/SKILL.md'), 'third-party');
  writeFileSync(join(f.pi, 'extensions/third-party.ts'), 'third-party');
  f.ok('push');
  assert.equal(existsSync(join(f.repo, 'skills/third-party')), false);
  assert.equal(existsSync(join(f.repo, 'config/pi/extensions/third-party.ts')), false);
});

function lockWith(f, pid) {
  const lock = join(f.local, '.sync-lock');
  mkdirSync(lock, { recursive: true });
  if (pid !== undefined) writeFileSync(join(lock, 'pid'), `${pid}\n`);
  return lock;
}

const exitedPid = () => spawnSync(process.execPath, ['-e', '']).pid;

function lockOutput(result) {
  return `${result.output}\n${result.error?.message ?? ''}`;
}

test('a lock blocks mutation', t => {
  const f = fixture(t);
  const lock = lockWith(f);
  const result = f.run('pull');
  assert(result.error);
  assert(existsSync(lock));
  assert.equal(existsSync(f.machine), false);
});

test('a lock held by another uid is live', t => {
  const f = fixture(t);
  lockWith(f, 1);
  const result = f.run('pull');
  assert(result.error);
  assert.match(lockOutput(result), /仍在运行/);
  assert.doesNotMatch(lockOutput(result), /rm -rf/);
});

test('a probe that is denied counts as a live owner', t => {
  const f = fixture(t);
  lockWith(f, exitedPid());
  const result = f.run('pull', { isAlive: () => true });
  assert.match(lockOutput(result), /仍在运行/);
  assert.doesNotMatch(lockOutput(result), /rm -rf/);
});

test('a lock with an exited owner is reported stale and kept', t => {
  const f = fixture(t);
  const lock = lockWith(f, exitedPid());
  const result = f.run('pull');
  assert.match(lockOutput(result), /已退出/);
  assert(existsSync(lock));
});

test('a lock with an unverifiable owner never suggests removal', t => {
  const f = fixture(t);
  const lock = lockWith(f, exitedPid());
  const result = f.run('pull', { isAlive: () => undefined });
  assert(result.error);
  assert.match(lockOutput(result), /无法确认/);
  assert.doesNotMatch(lockOutput(result), /--break-lock|rm -rf/);
  assert(existsSync(lock));
});

test('the lock records the owner pid, is released on success and is skipped by a dry run', t => {
  const f = fixture(t);
  const seen = [];
  f.ok('pull', { onLock: lock => seen.push(read(join(lock, 'pid')).trim()), onUnlock: lock => seen.push(lock) });
  assert.equal(seen[0], String(process.pid));
  assert.equal(existsSync(join(f.local, '.sync-lock')), false);
  const dry = [];
  f.ok('pull', { dryRun: true, onLock: lock => dry.push(lock) });
  assert.deepEqual(dry, []);
});

test('a failed package install stops the deploy and releases the lock', t => {
  const f = fixture(t);
  f.env.FAKE_PI_INSTALL_EXIT = '7';
  const result = f.run('pull');
  assert(result.error);
  assert.equal(existsSync(f.machine), false);
  assert.equal(existsSync(join(f.local, '.sync-lock')), false);
});

test('a local package skip survives version pinning', t => {
  const f = fixture(t);
  mkdirSync(f.local, { recursive: true });
  writeFileSync(join(f.local, 'packages.skip.txt'), 'npm:@plannotator/pi-extension\nhttps://github.com/ayghri/i-have-adhd\n');
  const result = f.ok('pull');
  assert.doesNotMatch(result.output, /pi install npm:@plannotator\/pi-extension/);
  assert.doesNotMatch(result.output, /pi install git:github.com\/ayghri\/i-have-adhd/);
  const packages = readJson(f.machine).packages;
  assert(!packages.some(entry => String(entry.source ?? entry).includes('plannotator') || String(entry.source ?? entry).includes('i-have-adhd')));
});

test('a mise tool installed at the wrong version is not treated as present', async t => {
  const f = fixture(t);
  writeFileSync(join(f.bin, 'mise'), `#!${process.execPath}\nif (process.argv[2] === 'current') console.log('0.0.1');\n`, { mode: 0o755 });
  const previous = process.env.PATH, log = console.log, lines = [];
  process.env.PATH = f.env.PATH;
  console.log = (...args) => lines.push(args.join(' '));
  try { await installDependencies({ source: f.repo, piHome: f.pi, agents: ['pi'] }, false); } finally {
    console.log = log;
    process.env.PATH = previous;
  }
  assert(lines.some(line => line.includes('mise use -g npm:dap-mcp-server@0.1.17')), lines.join('\n'));
});
