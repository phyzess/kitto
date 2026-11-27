import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { sameLocation } from '../lib/paths.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

function aliasedRoot(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'kitto-paths-')));
  t.onTestFinished(() => rmSync(base, { recursive: true, force: true }));
  const real = join(base, 'real');
  const link = join(base, 'link');
  mkdirSync(real);
  symlinkSync(real, link);
  return { base, real, link };
}

test('sameLocation compares identity through symlinks and tolerates missing paths', (t) => {
  const { real, link } = aliasedRoot(t);
  assert.equal(sameLocation(real, link), true);
  assert.equal(sameLocation(join(real, 'nested'), join(real, 'nested')), true);
  assert.equal(sameLocation(join(real, 'a'), join(real, 'b')), false);
  assert.equal(sameLocation(real, undefined), false);
});

test('an installation whose runtime directory is a symlink is still recognised as installed', (t) => {
  const { base } = aliasedRoot(t);
  const home = join(base, 'install');
  const target = join(home, 'runtime-target');
  mkdirSync(join(target, 'lib'), { recursive: true });
  for (const name of ['kitto-home.mjs', 'paths.mjs']) cpSync(join(root, 'dist', 'lib', name), join(target, 'lib', name));
  symlinkSync(target, join(home, 'runtime'));
  writeFileSync(join(home, 'state.json'), '{}');
  const env = { ...process.env, HOME: join(base, 'nohome') };
  delete env.KITTO_HOME;
  delete env.XDG_DATA_HOME;
  const script = `import { kittoHome } from ${JSON.stringify(join(target, 'lib/kitto-home.mjs'))}; console.log(kittoHome());`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), home);
});
