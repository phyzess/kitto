import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { hosts, pnpmVersion } from '../lib/host-pins.mjs';

const installer = new URL('../scripts/ci-install-native.mjs', import.meta.url).href;

function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'kitto-ci-install-')));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  const marker = join(home, 'npm-called');
  const prefix = join(home, 'kitto-hosts');
  mkdirSync(bin);
  const mock = join(home, 'mock-install.mjs');
  writeFileSync(mock, `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [prefix, mode] = process.argv.slice(2);
    const modules = join(prefix, 'node_modules');
    const dir = join(modules, '@pnpm/exe.linux-x64');
    const bin = join(modules, '.bin');
    mkdirSync(dir, { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: '@pnpm/exe.linux-x64', version: mode === 'wrong-version' ? '0.0.0' : '${pnpmVersion}',
    }));
    const header = Buffer.alloc(20);
    Buffer.from('7f454c4602010100', 'hex').copy(header);
    header.writeUInt16LE(62, 18);
    writeFileSync(join(dir, 'pnpm'), mode === 'text' ? 'not a native binary' : header, { mode: 0o700 });
    if (mode === 'occupied') writeFileSync(join(bin, 'pnpm'), 'existing');
  `);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "$MARKER"\nif [ -n "$MODE" ]; then exec "$NODE" "$MOCK_INSTALL" "$3" "$MODE"; fi\n`, { mode: 0o700 });
  function run(platform, arch, { glibc = '2.39', runner = home, mode = '' } = {}) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      Object.defineProperty(process, 'platform', {value: ${JSON.stringify(platform)}});
      Object.defineProperty(process, 'arch', {value: ${JSON.stringify(arch)}});
      process.report.getReport = () => ({header: {glibcVersionRuntime: ${JSON.stringify(glibc)}}});
      await import(${JSON.stringify(installer)});
    `], { env: { HOME: home, PATH: bin, MARKER: marker, RUNNER_TEMP: runner, NODE: process.execPath, MOCK_INSTALL: mock, MODE: mode },
      encoding: 'utf8', timeout: 10_000 });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    return result.stderr;
  }
  return { home, marker, prefix, run };
}

for (const [platform, arch, suffix] of [['linux', 'x64', 'linux-x64'], ['darwin', 'arm64', 'darwin-arm64'], ['darwin', 'x64', 'darwin-x64']]) {
  test(`${suffix} selects only the pinned platform and host packages`, t => {
    const { run, marker, prefix } = fixture(t);
    assert.match(run(platform, arch), /ENOENT/);
    assert.deepEqual(readFileSync(marker, 'utf8').trimEnd().split('\n'), [
      'install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund',
      `@pnpm/exe.${suffix}@${pnpmVersion}`, ...Object.values(hosts).map(host => `${host.package}@${host.version}`),
    ]);
  });
}

test('unsupported platform and missing glibc fail before npm is invoked', t => {
  const { run, marker } = fixture(t);
  assert.match(run('linux', 'arm64'), /Unsupported native pnpm platform/);
  assert.match(run('linux', 'x64', { glibc: '' }), /glibc/);
  assert(!existsSync(marker));
});

test('invalid RUNNER_TEMP and an occupied prefix fail before npm is invoked', t => {
  const { run, marker, prefix } = fixture(t);
  assert.match(run('linux', 'x64', { runner: 'relative' }), /RUNNER_TEMP must be an absolute directory/);
  mkdirSync(prefix);
  const file = join(prefix, 'keep');
  writeFileSync(file, 'existing');
  assert.match(run('linux', 'x64'), /prefix already exists/);
  assert.equal(readFileSync(file, 'utf8'), 'existing');
  assert(!existsSync(marker));
});

for (const [mode, diagnostic] of [
  ['text', /Expected a native pnpm executable/],
  ['wrong-version', /Unexpected native package/],
  ['occupied', /EEXIST/],
]) {
  test(`rejects an invalid installation: ${mode}`, t => {
    const { run, prefix } = fixture(t);
    assert.match(run('linux', 'x64', { mode }), diagnostic);
    const pnpm = join(prefix, 'node_modules', '.bin', 'pnpm');
    if (mode === 'occupied') assert.equal(readFileSync(pnpm, 'utf8'), 'existing');
    else assert(!existsSync(pnpm));
  });
}
