import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newerStable } from '../lib/update-notice.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const registry = 'https://registry.npmjs.org/';
const packageName = '@phyzess/kitto';
const registryArgs = [`--registry=${registry}`, `--@phyzess:registry=${registry}`];
const verifyAttempts = 24;
const verifyDelayMs = 15_000;

function waitSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function waitForPublish(spec, integrity, read, { attempts = verifyAttempts, delayMs = verifyDelayMs, sleep = waitSync } = {}) {
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
  throw new Error(`${spec} was published but npm still does not serve it after ${attempts} attempts. `
    + `The tarball integrity is ${integrity}; rerun from this commit to verify or resume.`);
}

function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.signal ?? result.status}).`);
  return result.stdout;
}

function git(...args) {
  return run('git', args, root, true).trim();
}

function npmView(spec, field, cwd) {
  const result = spawnSync('npm', ['view', spec, field, '--json', '--tag=latest', '--prefer-online', '--offline=false', ...registryArgs], {
    cwd, encoding: 'utf8',
  });
  if (result.error) throw result.error;
  let data;
  if (result.stdout.trim()) data = JSON.parse(result.stdout);
  if (result.status === 0) return data;
  if (data?.error?.code === 'E404') return undefined;
  throw new Error(`Cannot read ${spec} ${field} from npm.\n${result.stderr.trim()}`);
}

function release(version, publish) {
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

  const temp = mkdtempSync(join(tmpdir(), 'kitto-release-'));
  try {
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
    const [packed] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--dry-run=false', '--pack-destination', temp], source, true));
    const tarball = join(temp, packed.filename);
    console.log(`${packed.filename} (${packed.files.length} files)\n${packed.integrity}`);

    if (!publish) {
      console.log(`Preview passed. Add --publish to push ${tag} to origin and publish ${spec} to npm.`);
      return;
    }

    const pushUrls = git('remote', 'get-url', '--push', '--all', 'origin').split('\n');
    if (pushUrls.length !== 1) throw new Error('Configure exactly one push URL for origin.');
    const refs = new Map(git('ls-remote', '--', pushUrls[0], mainRef, tagRef, `${tagRef}^{}`)
      .split('\n').filter(Boolean).map(line => {
        const [hash, ref] = line.split('\t');
        return [ref, hash];
      }));
    const remoteTag = refs.get(`${tagRef}^{}`) ?? refs.get(tagRef);
    if (remoteTag && remoteTag !== commit) throw new Error(`Origin tag ${tag} points to a different commit.`);
    if (!remoteTag && refs.get(mainRef) !== commit) {
      throw new Error('A new release must use the current origin main commit. Update your checkout and try again.');
    }

    const existing = npmView(spec, 'dist.integrity', temp);
    if (existing !== undefined && existing !== packed.integrity) {
      throw new Error(`${spec} already exists on npm with different contents.`);
    }
    if (existing === undefined) {
      const latest = npmView(packageName, 'dist-tags.latest', temp);
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
      run('npm', ['publish', tarball, '--access=public', '--tag=latest', '--ignore-scripts', '--dry-run=false', '--force=false', ...registryArgs], temp);
      waitForPublish(spec, packed.integrity, () => npmView(spec, 'dist.integrity', temp));
    }
    console.log(`Released ${spec} at ${tag} (${commit}).`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
function invokedDirectly() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (invokedDirectly()) {
  try {
    const [version, option, ...extra] = process.argv.slice(2);
    const usage = 'Usage: npm run release -- <major.minor.patch> [--publish]';
    if (version === '--help' && !option) console.log(usage);
    else {
      if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '') ||
          !version.split('.').every(part => Number.isSafeInteger(Number(part))) ||
          (option !== undefined && option !== '--publish') || extra.length) throw new Error(usage);
      release(version, option === '--publish');
    }
  } catch (error) {
    console.error(`Release failed: ${error.message}`);
    process.exitCode = 1;
  }
}
