import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const options = { skip: existsSync(join(dist, 'package.json')) ? false : 'dist/ is absent; run npm run build' };

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const runtimeSources = () => ['bin', 'lib', 'integration'].flatMap(dir => files(join(root, dir)))
  .filter(file => file.endsWith('.mjs')).map(file => relative(root, file)).sort();
const json = path => JSON.parse(readFileSync(path, 'utf8'));

test('dist mirrors every runtime source file one to one', options, () => {
  const output = files(dist).map(file => relative(dist, file)).filter(file => file.endsWith('.mjs')).sort();
  assert.deepEqual(output, runtimeSources());
});

test('dist is a complete package root whose manifest paths resolve inside it', options, () => {
  const manifest = json(join(dist, 'package.json')), source = json(join(root, 'package.json'));
  assert.equal(manifest.version, source.version);
  assert.deepEqual(manifest.bin, source.bin);
  assert.deepEqual(manifest.pi, source.pi);
  assert.deepEqual(manifest.dsh, source.dsh);
  assert.deepEqual(manifest.dependencies, source.dependencies);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.devDependencies, undefined);
  const paths = [...Object.values(manifest.bin), ...manifest.pi.extensions, ...manifest.pi.skills, manifest.dsh.bundle.patch,
    'CHANGELOG.md', 'integration/plugin.json', 'integration/skills/kitto/SKILL.md'];
  for (const path of paths) assert.equal(existsSync(join(dist, path)), true, path);
  assert.equal(json(join(dist, 'integration/plugin.json')).version, manifest.version);
});

test('package-root-relative assumptions hold in dist', options, () => {
  const read = path => readFileSync(join(dist, path), 'utf8');
  for (const path of ['lib/kitto-home.mjs', 'lib/scopes.mjs', 'lib/scope-setup.mjs', 'lib/scope-service.mjs', 'lib/scope-codex.mjs', 'lib/scope-dsh.mjs', 'lib/scope-pi.mjs']) {
    assert.match(read(path), /new URL\(["']\.\.\/["'], import\.meta\.url\)/u, path);
  }
  assert.match(read('integration/pi.mjs'), /new URL\(["']\.\.\/package\.json["'], import\.meta\.url\)/u);
  assert.match(read('integration/dsh.mjs'), /new URL\(["']\.\/skills\/kitto\/SKILL\.md["'], import\.meta\.url\)/u);
  for (const name of ['paths', 'codegraph', 'dsh-profile']) assert.equal(existsSync(join(dist, 'lib', `${name}.mjs`)), true, name);
  for (const dir of ['scoped-codex', 'scoped-dsh', 'scoped-pi']) assert.equal(existsSync(join(dist, 'integration', dir)), true, dir);
  assert.equal(statSync(join(dist, 'bin/kitto.mjs')).mode & 0o111, 0o111, 'bin/kitto.mjs keeps its executable bit');
  assert.match(read('bin/kitto.mjs'), /^#!\/usr\/bin\/env node\n/u);
});

test('the built CLI runs from dist', options, () => {
  const out = execFileSync(process.execPath, [join(dist, 'bin/kitto.mjs'), '--help'], { encoding: 'utf8', env: { ...process.env, KITTO_UPDATE_CHECK: '0' } });
  assert.match(out, /kitto setup/u);
});

test('the packed tarball ships no source maps and only declared files', options, () => {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dist, encoding: 'utf8' }));
  const paths = packed.files.map(file => file.path);
  assert(paths.includes('bin/kitto.mjs'));
  assert(paths.includes('integration/skills/kitto/SKILL.md'));
  assert.equal(paths.some(path => path.endsWith('.map')), false);
  for (const path of paths) assert.match(path, /^(bin\/[^/]+\.mjs|lib\/(hosts\/)?[^/]+\.mjs|integration\/|package\.json$|README\.md$|CHANGELOG\.md$)/u, path);
});
