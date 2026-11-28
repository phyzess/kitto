import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newerStable } from '../lib/update-notice.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const registry = 'https://registry.npmjs.org/';
const packageName = '@phyzess/kitto';
const registryArgs = [`--registry=${registry}`, `--@phyzess:registry=${registry}`];
const verifyAttempts = 24;
const verifyDelayMs = 15_000;
const previewRoot = join(tmpdir(), 'kitto-release-preview');

interface PreviewRecord {
  version: string;
  commit: string;
  integrity: string;
  tarball: string;
}

export const previewRecordPath = (version: string): string => join(previewRoot, `${version}.json`);

export function previewMatches(record: PreviewRecord | undefined, commit: string, version: string, integrity: string | undefined): boolean {
  return Boolean(
    record && record.version === version && record.commit === commit && integrity !== undefined && record.integrity === integrity,
  );
}

const tarballIntegrity = (path: string): string | undefined => {
  try {
    return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
  } catch {
    return undefined;
  }
};

function readPreview(version: string): PreviewRecord | undefined {
  try {
    return JSON.parse(readFileSync(previewRecordPath(version), 'utf8')) as PreviewRecord;
  } catch {
    return undefined;
  }
}

interface Verified {
  tarball: string;
  integrity: string;
  files: number;
}

function verify(version: string, commit: string, spec: string, temp: string): Verified {
  const source = join(temp, 'source');
  mkdirSync(source);
  const archive = join(temp, 'source.tar');
  run('git', ['archive', '--format=tar', '-o', archive, commit]);
  run('tar', ['-xf', archive, '-C', source]);

  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(join(source, 'integration/plugin.json'), 'utf8'));
  if (manifest.name !== packageName || manifest.version !== version || plugin.version !== version) {
    throw new Error(`Expected ${spec} in package.json and version ${version} in integration/plugin.json.`);
  }
  const changelog = readFileSync(join(source, 'CHANGELOG.md'), 'utf8');
  const notes = changelog.split(/^## /m)[1]?.trim().split(/\r?\n/);
  if (notes?.[0].trim() !== version || !notes.slice(1).join('\n').trim()) {
    throw new Error(`Add a non-empty topmost "## ${version}" section to CHANGELOG.md.`);
  }

  console.log(`Checking ${spec} from ${commit}`);
  run('bash', ['-n', 'setup.sh'], source);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], source);
  run('npm', ['run', 'prepublishOnly'], source);
  const dist = join(source, 'dist');
  const built = JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8'));
  const builtPlugin = JSON.parse(readFileSync(join(dist, 'integration/plugin.json'), 'utf8'));
  if (built.name !== packageName || built.version !== version || builtPlugin.version !== version) {
    throw new Error(`Expected dist/package.json and dist/integration/plugin.json to carry ${spec}.`);
  }
  const [packed]: PackedTarball[] = JSON.parse(
    run('npm', ['pack', '--json', '--ignore-scripts', '--dry-run=false', '--pack-destination', temp], dist, true),
  );
  if (packed.files.some((file) => file.path.endsWith('.map')) || !packed.files.some((file) => file.path === 'bin/kitto.mjs')) {
    throw new Error('The tarball must contain bin/kitto.mjs and no source maps. Check the dist build.');
  }
  mkdirSync(previewRoot, { recursive: true });
  const tarball = join(previewRoot, `${version}.tgz`);
  copyFileSync(join(temp, packed.filename), tarball);
  writeFileSync(previewRecordPath(version), `${JSON.stringify({ version, commit, integrity: packed.integrity, tarball }, null, 2)}\n`);
  console.log(`${packed.filename} (${packed.files.length} files)\n${packed.integrity}`);
  return { tarball, integrity: packed.integrity, files: packed.files.length };
}

function waitSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function waitForPublish(
  spec: string,
  integrity: string,
  read: () => string | undefined,
  {
    attempts = verifyAttempts,
    delayMs = verifyDelayMs,
    sleep = waitSync,
  }: { attempts?: number; delayMs?: number; sleep?: (ms: number) => void } = {},
): number {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const found = read();
    if (found === integrity) {
      if (attempt > 1) console.log(`${spec} is served by npm (verified on attempt ${attempt}).`);
      return attempt;
    }
    if (found !== undefined) throw new Error(`${spec} is on npm with different contents (${found}); expected ${integrity}.`);
    if (attempt < attempts) {
      console.log(`Waiting for npm to serve ${spec} (attempt ${attempt}/${attempts})…`);
      sleep(delayMs);
    }
  }
  throw new Error(
    `${spec} was published but npm still does not serve it after ${attempts} attempts. ` +
      `The tarball integrity is ${integrity}; rerun from this commit to verify or resume.`,
  );
}

function run(command: string, args: string[], cwd: string = root, capture = false): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.signal ?? result.status}).`);
  return result.stdout;
}

function git(...args: string[]): string {
  return run('git', args, root, true).trim();
}

function npmView(spec: string, field: string, cwd?: string): string | undefined {
  const result = spawnSync('npm', ['view', spec, field, '--json', '--tag=latest', '--prefer-online', '--offline=false', ...registryArgs], {
    cwd,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  let data: unknown;
  if (result.stdout.trim()) data = JSON.parse(result.stdout);
  if (result.status === 0) {
    if (typeof data === 'string' || data === undefined) return data;
    throw new Error(`Unexpected npm view result for ${spec} ${field}.`);
  }
  const failure = typeof data === 'object' && data !== null && 'error' in data ? data.error : undefined;
  if (typeof failure === 'object' && failure !== null && 'code' in failure && failure.code === 'E404') return undefined;
  throw new Error(`Cannot read ${spec} ${field} from npm.\n${result.stderr.trim()}`);
}

interface PackedTarball {
  filename: string;
  integrity: string;
  files: Array<{ path: string }>;
}

function release(version: string, publish: boolean, reverify: boolean): void {
  const nodeMajor = readFileSync(join(root, '.node-version'), 'utf8').trim();
  if (process.versions.node.split('.')[0] !== nodeMajor) {
    throw new Error(`Releases use Node.js ${nodeMajor}. Found ${process.version}.`);
  }
  const tag = `v${version}`;
  const tagRef = `refs/tags/${tag}`;
  const spec = `${packageName}@${version}`;
  const mainRef = 'refs/heads/main';
  if (git('status', '--porcelain=v1', '--untracked-files=all')) {
    throw new Error('Commit or remove working tree changes before running a release.');
  }
  const commit = git('rev-parse', 'HEAD');
  const localTag = git('for-each-ref', '--format=%(refname)', tagRef);
  if (localTag && git('rev-parse', `${tagRef}^{commit}`) !== commit) {
    throw new Error(`Local tag ${tag} points to a different commit.`);
  }

  let checked: Verified;
  const cached = publish && !reverify ? readPreview(version) : undefined;
  if (cached && previewMatches(cached, commit, version, tarballIntegrity(cached.tarball))) {
    checked = { tarball: cached.tarball, integrity: cached.integrity, files: 0 };
    console.log(`Reusing the verified preview for ${commit.slice(0, 7)}: ${cached.tarball}\n${cached.integrity}`);
    console.log('Pass --re-verify to run the full check again (npm ci, build and test in a fresh snapshot).');
  } else {
    if (cached) console.log(`The stored preview for ${version} does not match this commit or tarball; verifying again.`);
    const temp = mkdtempSync(join(tmpdir(), 'kitto-release-'));
    try {
      checked = verify(version, commit, spec, temp);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  if (!publish) {
    console.log(`Preview passed. Add --publish to push ${tag} to origin and publish ${spec} to npm.`);
    return;
  }

  const pushUrls = git('remote', 'get-url', '--push', '--all', 'origin').split('\n');
  if (pushUrls.length !== 1) throw new Error('Configure exactly one push URL for origin.');
  const refs = new Map(
    git('ls-remote', '--', pushUrls[0], mainRef, tagRef, `${tagRef}^{}`)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, ref] = line.split('\t');
        return [ref, hash];
      }),
  );
  const remoteTag = refs.get(`${tagRef}^{}`) ?? refs.get(tagRef);
  if (remoteTag && remoteTag !== commit) throw new Error(`Origin tag ${tag} points to a different commit.`);
  if (!remoteTag && refs.get(mainRef) !== commit) {
    throw new Error('A new release must use the current origin main commit. Update your checkout and try again.');
  }

  const existing = npmView(spec, 'dist.integrity');
  if (existing !== undefined && existing !== checked.integrity) {
    throw new Error(`${spec} already exists on npm with different contents.`);
  }
  if (existing === undefined) {
    const latest = npmView(packageName, 'dist-tags.latest');
    if (latest !== undefined && !newerStable(version, latest)) {
      throw new Error(`Refusing to move npm latest from ${latest} to ${version}.`);
    }
  }

  if (!remoteTag) {
    const tagObject = localTag ? git('rev-parse', tagRef) : commit;
    run('git', ['push', '--no-follow-tags', 'origin', `${tagObject}:${tagRef}`]);
  }
  if (existing === undefined) {
    console.log(`Origin tag ${tag} exists. If npm publishing fails, rerun from this commit.`);
    run(
      'npm',
      [
        'publish',
        checked.tarball,
        '--access=public',
        '--tag=latest',
        '--ignore-scripts',
        '--dry-run=false',
        '--force=false',
        ...registryArgs,
      ],
      root,
    );
    waitForPublish(spec, checked.integrity, () => npmView(spec, 'dist.integrity'));
  }
  console.log(`Released ${spec} at ${tag} (${commit}).`);
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    const [version, ...options] = process.argv.slice(2);
    const usage = 'Usage: npm run release -- <major.minor.patch> [--publish] [--re-verify]';
    if (version === '--help' && options.length === 0) console.log(usage);
    else {
      if (
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '') ||
        !version.split('.').every((part) => Number.isSafeInteger(Number(part))) ||
        options.some((option: string) => !['--publish', '--re-verify'].includes(option)) ||
        (options.includes('--re-verify') && !options.includes('--publish'))
      )
        throw new Error(usage);
      release(version, options.includes('--publish'), options.includes('--re-verify'));
    }
  } catch (error) {
    console.error(`Release failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
