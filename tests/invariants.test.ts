import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts', 'check-invariants.ts');

function fixture(files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kitto-invariants-')));
  cpSync(join(repo, 'sgconfig.yml'), join(root, 'sgconfig.yml'));
  cpSync(join(repo, 'rules'), join(root, 'rules'), { recursive: true });
  mkdirSync(join(root, 'lib'));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, 'lib', name), source);
  return root;
}

function scan(root: string) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8', timeout: 60_000 });
}

test('the repository tree satisfies the invariant rules', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('path string equality and regex parsing of YAML or TOML are rejected', () => {
  const root = fixture({
    'bad.ts': [
      "import { realpathSync } from 'node:fs';",
      "import { resolve } from 'node:path';",
      'export const a = (dir, other) => resolve(dir) === other;',
      'export const b = (dir, other) => other !== realpathSync(dir);',
      'export const c = yamlText => yamlText.match(/^name: (.+)$/m);',
      'export const d = tomlSource => /^\\[mcp/.test(tomlSource);',
      '',
    ].join('\n'),
  });
  try {
    const result = scan(root);
    assert.notEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /no-path-string-equality/);
    assert.match(output, /no-regex-on-structured-config/);
    assert.match(output, /no-regex-test-on-structured-config/);
    assert.equal((output.match(/^error\[/gm) ?? []).length, 4, output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the symlink-rejection idiom and neutral code pass', () => {
  const root = fixture({
    'good.ts': [
      "import { realpathSync } from 'node:fs';",
      "import { sameLocation } from './paths.ts';",
      'export const regular = path => realpathSync(path) === path;',
      'export const symlink = path => realpathSync(path) !== path;',
      'export const same = (a, b) => sameLocation(a, b);',
      'export const parsed = document => document.toString();',
      'export const version = text => text.match(/^v(\\d+)/)?.[1];',
      '',
    ].join('\n'),
  });
  try {
    const result = scan(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
