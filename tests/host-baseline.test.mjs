import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hosts, routingHostVersion } from '../lib/host-pins.mjs';
import { compareVersions } from '../lib/hosts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

test('package engines.dsh lower bound equals the DSH baseline', () => {
  const { engines } = json('package.json');
  assert.equal(engines.dsh.match(/^>=(\S+)/)?.[1], hosts.dsh.version);
  assert.equal(json('package-lock.json').packages[''].engines.dsh, engines.dsh);
});

test('the routing-validated DSH is not older than the setup baseline', () => {
  assert.notEqual(compareVersions(routingHostVersion, hosts.dsh.version), -1);
});

test('no pinned version literal is repeated outside the source file', () => {
  const result = spawnSync(process.execPath, ['scripts/check-version-literals.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
