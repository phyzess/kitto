import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { hosts, pnpmVersion } from '../lib/host-pins.ts';

const runner = process.env.RUNNER_TEMP;
if (!runner || !isAbsolute(runner) || !statSync(runner, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error('RUNNER_TEMP must be an absolute directory.');
}

const platform = `${process.platform}-${process.arch}`;
const signatures = new Map([
  ['linux-x64', '7f454c4602010100'],
  ['darwin-arm64', 'cffaedfe0c000001'],
  ['darwin-x64', 'cffaedfe07000001'],
]);
const signature = signatures.get(platform);
if (!signature) throw new Error(`Unsupported native pnpm platform: ${platform}.`);
if (platform === 'linux-x64' && !process.report.getReport().header.glibcVersionRuntime) {
  throw new Error('The Linux native pnpm package requires glibc.');
}

const verifyOnly = process.argv.includes('--verify-only');
const prefix = join(realpathSync(runner), 'kitto-hosts');
if (!verifyOnly) {
  try {
    mkdirSync(prefix);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Native host prefix already exists: ${prefix}.`);
    throw error;
  }
}

const pnpmPackage = `@pnpm/exe.${platform}`;
if (!verifyOnly) execFileSync('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund',
  `${pnpmPackage}@${pnpmVersion}`, ...Object.values(hosts).map(host => `${host.package}@${host.version}`),
], { stdio: 'inherit' });

const modules = join(prefix, 'node_modules');
const bin = join(modules, '.bin');
const packageDir = join(modules, pnpmPackage);
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
if (manifest.name !== pnpmPackage || manifest.version !== pnpmVersion) {
  throw new Error(`Unexpected native package; expected ${pnpmPackage}@${pnpmVersion}.`);
}

const native = join(packageDir, 'pnpm');
const info = lstatSync(native);
if (!info.isFile() || !(info.mode & 0o111) || realpathSync(native) !== native) {
  throw new Error('Expected a regular executable pnpm file in the platform package.');
}
const fd = openSync(native, 'r');
try {
  const header = Buffer.alloc(20);
  if (readSync(fd, header, 0, header.length, 0) !== header.length ||
      header.subarray(0, 8).toString('hex') !== signature ||
      (platform === 'linux-x64' && header.readUInt16LE(18) !== 62)) {
    throw new Error(`Expected a native pnpm executable for ${platform}.`);
  }
} finally {
  closeSync(fd);
}

if (realpathSync(bin) !== bin) throw new Error('Unexpected native host .bin directory.');
if (!verifyOnly) symlinkSync(relative(bin, native), join(bin, 'pnpm'));
for (const [name, expected] of Object.entries({
  pnpm: pnpmVersion, pi: hosts.pi.version, codex: `codex-cli ${hosts.codex.version}`, dsh: hosts.dsh.version,
})) {
  const entry = join(bin, name);
  const resolved = realpathSync(entry);
  if (!resolved.startsWith(`${modules}${sep}`) || !lstatSync(resolved).isFile()) {
    throw new Error(`${name} is not an executable file in the native host prefix.`);
  }
  const actual = execFileSync(entry, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
  if (actual !== expected) throw new Error(`${name} reports ${actual} instead of ${expected}.`);
  console.log(`${name}: ${actual}`);
}
