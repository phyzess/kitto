import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'vitest';

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'kitto-dsh-discovery-')));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, PATH: join(home, 'bin'), DSH_HOME: join(home, '.dsh') };
  const run = (code, extra = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { dshExecutable, loadDshYaml } from './integration/scoped-dsh/native.mjs';
    import { installDshScope } from './lib/scope-dsh.mjs';
    ${code}`], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
  async function file(path, content, mode) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode });
    return path;
  }
  async function install(dir) {
    await file(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }));
    return file(join(dir, 'lib/bin.js'), '#!/bin/sh\nexit 99\n', 0o700);
  }
  return { home, env, run, file, install };
}

const yamlProbe = 'console.log((await loadDshYaml()).origin)';

test('a missing DSH gives a deferred scoped setup preview and never writes a patch', async t => {
  const { home, env, run } = await fixture(t);
  const setup = dryRun => run(`await installDshScope(${JSON.stringify({ home, dryRun })});`);
  const preview = setup(true);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /would register after DSH is installed/);
  assert(preview.stdout.includes(join(env.DSH_HOME, 'profiles/web/cordis.patch.yml')));
  const apply = setup(false);
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /DSH must be installed/);
  await assert.rejects(readFile(join(env.DSH_HOME, 'profiles/web/cordis.patch.yml')), { code: 'ENOENT' });
});

test('direct DSH symlink resolves modules from the selected package, including hoisted dependencies', async t => {
  const { home, env, install, file, run } = await fixture(t);
  const dir = join(home, 'node_modules/@deepseek-ai/dsh');
  const entry = await install(dir);
  await file(join(home, 'node_modules/yaml/index.js'), 'exports.origin = "hoisted"');
  await mkdir(env.PATH);
  await symlink(entry, join(env.PATH, 'dsh'));
  const result = run(yamlProbe);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'hoisted');
});

test('an unknown wrapper cannot load yaml even next to an unrelated package', async t => {
  const { home, env, install, file, run } = await fixture(t);
  const entry = await install(join(home, 'real-dsh'));
  await file(join(home, 'node_modules/yaml/index.js'), 'exports.origin = "foreign"');
  await file(join(env.PATH, 'dsh'), '#!/bin/sh\nexit 0\n', 0o700);
  const later = join(dirname(entry), 'dsh');
  await symlink(entry, later);
  const result = run(yamlProbe, { PATH: [env.PATH, dirname(later)].join(delimiter) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot identify the selected DSH installation/);
  assert.doesNotMatch(result.stdout, /foreign/);
});

test('a verified mise shim uses the selected installation, never modules next to the shim', async t => {
  const { home, env, install, file, run } = await fixture(t);
  const dir = join(home, 'runtime');
  const entry = await install(dir);
  await file(join(dir, 'node_modules/yaml/index.js'), 'exports.origin = "selected"');
  const mise = await file(join(env.PATH, 'mise'), `#!/bin/sh
[ "$1 $2" = "which dsh" ] || exit 9
printf '%s\\n' '${entry}'
`, 0o700);
  const shims = join(home, 's');
  await mkdir(shims);
  await symlink(mise, join(shims, 'dsh'));
  const result = run(yamlProbe, { PATH: [shims, env.PATH].join(delimiter) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'selected');
});

test('mise failure, ambiguous success and shim recursion do not fall back', async t => {
  const { home, env, install, file, run } = await fixture(t);
  const later = join(home, 'later');
  const entry = await install(join(home, 'runtime'));
  const shim = join(env.PATH, 'dsh');
  const mise = join(env.PATH, 'mise');
  await Promise.all([mkdir(later), mkdir(env.PATH)]);
  await symlink(entry, join(later, 'dsh'));
  await symlink(mise, shim);
  await file(join(home, 'node_modules/yaml/index.js'), 'exports.origin = "foreign"');
  for (const response of ['exit 1', `printf '%s\\n' '${entry}' '${entry}'`, `printf '%s\\n' '${shim}'`]) {
    await file(mise, `#!/bin/sh\n${response}\n`, 0o700);
    const result = run(yamlProbe, { PATH: [env.PATH, later].join(delimiter) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot identify the selected DSH installation/);
    assert.doesNotMatch(result.stdout, /foreign/);
  }
});

test('a valid DSH entry rejects external NODE_PATH modules and conflicting runtime anchors', async t => {
  const { home, env, install, file, run } = await fixture(t);
  const entry = await install(join(home, 'selected'));
  await mkdir(env.PATH);
  await symlink(entry, join(env.PATH, 'dsh'));
  const unrelated = join(home, 'foreign', 'node_modules');
  await file(join(unrelated, 'yaml/index.js'), 'exports.origin = "foreign"');
  const noYaml = run(yamlProbe, { NODE_PATH: unrelated });
  assert.notEqual(noYaml.status, 0);
  assert.match(noYaml.stderr, /Cannot load yaml from the selected DSH installation/);
  assert.doesNotMatch(noYaml.stdout, /foreign/);
  const other = join(home, 'other');
  await install(other);
  const mismatch = run(yamlProbe, { DSH_INSTALL_DIR: other });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /DSH_INSTALL_DIR does not match the selected executable/);
});
