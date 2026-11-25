import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hosts, pnpmVersion } from '../lib/host-pins.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const versions = {
  pnpm: pnpmVersion,
  pi: hosts.pi.version,
  codex: `codex-cli ${hosts.codex.version}`,
  dsh: hosts.dsh.version,
};
const platform = `${process.platform}-${process.arch}`;
const formats = new Map([
  ['linux-x64', ['7f454c4602010100', 62]],
  ['darwin-arm64', ['cffaedfe0c000001']],
  ['darwin-x64', ['cffaedfe07000001']],
]);
assert(formats.has(platform), `Unsupported pnpm native platform: ${platform}`);
if (process.platform === 'linux') {
  assert(process.report.getReport().header.glibcVersionRuntime, 'Linux pnpm native probe requires glibc');
}

function run(command, args, env, description, timeout = 240_000) {
  const result = spawnSync(command, args, {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout,
  });
  if (description === 'candidate native lifecycle') process.stdout.write(result.stdout ?? '');
  if (result.error || result.status !== 0) {
    throw new Error(`${description} failed (${result.error?.code ?? result.signal ?? result.status}).`);
  }
  return result.stdout;
}

function installedExecutable(prefix, entry) {
  const path = realpathSync(entry);
  const rel = relative(realpathSync(prefix), path);
  assert(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), 'Executable escaped its installation prefix');
  assert(lstatSync(path).isFile(), 'Expected a regular executable file');
  accessSync(path, constants.X_OK);
  return path;
}

function header(path) {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(20);
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0));
  } finally {
    closeSync(fd);
  }
}

const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const manifest = path => JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
const tmp = process.env.RUNNER_TEMP;
assert(tmp && isAbsolute(tmp), 'An absolute RUNNER_TEMP is required');
const control = join(tmp, 'kitto-hosts');
const controlBin = join(control, 'node_modules', '.bin');
const sandbox = mkdtempSync(join(tmp, 'kitto-pnpm-candidate-'));
const prefix = join(sandbox, 'hosts');
const home = join(sandbox, 'home');
const bin = join(sandbox, 'bin');
const workTmp = join(sandbox, 'tmp');

function verify(label, prefix, bin, env) {
  const pnpm = installedExecutable(prefix, join(bin, 'pnpm'));
  const bytes = header(pnpm);
  const [magic, machine] = formats.get(platform);
  assert.equal(bytes.subarray(0, 8).toString('hex'), magic, `${label}: unexpected pnpm executable format/architecture`);
  if (machine !== undefined) assert.equal(bytes.readUInt16LE(18), machine, `${label}: unexpected ELF machine`);
  console.log(`${platform} ${label} pnpm native: ${relative(realpathSync(prefix), pnpm)} sha256=${digest(pnpm)}`);
  for (const [command, expected] of Object.entries(versions)) {
    const executable = join(bin, command);
    installedExecutable(prefix, executable);
    const actual = run(executable, ['--version'], env, `${label} ${command} version check`, 30_000).trim();
    assert(actual === expected, `${label} ${command} did not report the exact expected version (${expected})`);
    console.log(`${platform} ${label} ${command}: ${expected}`);
  }
}

try {
  for (const path of [prefix, home, bin, workTmp]) mkdirSync(path, { mode: 0o700 });
  const env = {
    HOME: home,
    TMPDIR: workTmp,
    PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    DSH_TELEMETRY_DISABLED: '1',
    CODEX_HOME: join(home, 'codex'),
    PI_CODING_AGENT_DIR: join(home, 'pi'),
    DSH_HOME: join(home, 'dsh'),
    npm_config_cache: join(sandbox, 'npm-cache'),
    npm_config_userconfig: join(sandbox, 'npmrc'),
    npm_config_globalconfig: join(sandbox, 'npmrc-global'),
  };
  verify('control', control, controlBin, env);
  const guard = join(sandbox, 'deny-lifecycle');
  const marker = join(sandbox, 'lifecycle-attempted');
  writeFileSync(guard, '#!/bin/sh\n: > "$KITTO_LIFECYCLE_MARKER"\nexit 1\n', { mode: 0o700 });
  try {
    run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', `pnpm@${pnpmVersion}`,
      ...Object.values(hosts).map(({ package: name, version }) => `${name}@${version}`)], {
      ...env, npm_config_ignore_scripts: 'true', npm_config_script_shell: guard, KITTO_LIFECYCLE_MARKER: marker,
    }, 'script-disabled npm install');
  } finally {
    assert(!existsSync(marker), 'An npm lifecycle command reached the denying script shell');
  }
  console.log(`${platform} candidate lifecycle guard: no invocation`);

  const modules = join(prefix, 'node_modules');
  const platformPackage = `@pnpm/exe.${platform}`;
  const pnpm = manifest(join(modules, 'pnpm'));
  assert.equal(pnpm.name, 'pnpm');
  assert.equal(pnpm.version, pnpmVersion);
  assert.equal(pnpm.optionalDependencies?.[platformPackage], pnpmVersion);
  const platformDir = join(modules, platformPackage);
  const archive = manifest(platformDir);
  assert.equal(archive.name, platformPackage);
  assert.equal(archive.version, pnpmVersion);
  assert.deepEqual(archive.os, [process.platform]);
  assert.deepEqual(archive.cpu, [process.arch]);
  if (process.platform === 'linux') assert.deepEqual(archive.libc, ['glibc']);
  assert(!archive.scripts && !archive.bin, 'Expected a data-only platform package');
  const archiveBinary = join(platformDir, 'pnpm');
  assert(lstatSync(archiveBinary).isFile(), 'Expected the platform archive to ship a regular pnpm file');
  const native = installedExecutable(prefix, archiveBinary);
  const wrapper = join(modules, '.bin', 'pnpm');
  const placeholder = installedExecutable(prefix, wrapper);
  assert.equal(placeholder, realpathSync(join(modules, 'pnpm', pnpm.bin.pnpm)));
  assert.match(readFileSync(placeholder, 'utf8'), /^# pnpm's native binary replaces this file during installation\b/);
  const before = digest(placeholder);
  symlinkSync(native, join(bin, 'pnpm'));
  for (const command of ['pi', 'codex', 'dsh']) symlinkSync(join(modules, '.bin', command), join(bin, command));
  const testEnv = { ...env, KITTO_NATIVE_BIN: bin, PATH: `${bin}${delimiter}${env.PATH}` };
  verify('candidate', prefix, bin, testEnv);
  console.log(`${platform} candidate native lifecycle:`);
  const result = run(process.execPath, ['--test', '--test-reporter=tap', 'tests/native.test.mjs'],
    testEnv, 'candidate native lifecycle', 540_000);
  assert.match(result, /^# tests 3$/m);
  assert.match(result, /^# pass 3$/m);
  assert.match(result, /^# skipped 0$/m);
  assert.equal(installedExecutable(prefix, wrapper), placeholder);
  assert.equal(digest(placeholder), before, 'The candidate pnpm placeholder changed');
  console.log(`${platform} candidate unchanged wrapper: ${relative(realpathSync(prefix), placeholder)} sha256=${before}`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
