import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { migrateRouting } from '../lib/routing-migration.ts';

const original = 'Custom first\r\n<!-- kitto:begin -->\r\nKitto rules\r\n<!-- kitto:end -->\r\nCustom last';
const patch =
  '- id: agent-teams\n  config:\n    fallback: { provider: local, model: custom }\n    profiles:\n      dev-hard:\n        "fallback": { provider: local, model: other }\n';
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'kitto-route-fixture-'));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, 'profiles', 'web');
  const agents = join(home, 'AGENTS.md'),
    profilePatch = join(profile, 'cordis.patch.yml'),
    credentials = join(profile, 'auth.json');
  mkdirSync(profile, { recursive: true });
  writeFileSync(agents, original);
  chmodSync(agents, 0o640);
  writeFileSync(profilePatch, patch);
  writeFileSync(credentials, 'fixture-auth-do-not-touch');
  return { home, agents, profilePatch, credentials };
}

test('one preview shows exact managed addition without printing custom/auth, fixture apply/rollback is idempotent', (t) => {
  const { home, agents, profilePatch, credentials } = fixture(t);
  const preview = migrateRouting({ home });
  assert.deepEqual(preview.manual.fallbackLines, [3, 6]);
  assert.equal(preview.manual.effectiveFallbacks, 'unverified');
  assert.equal(preview.changes[0].action, 'insert-before-kitto-end');
  assert.ok(!JSON.stringify(preview).includes('Custom first'));
  assert.ok(!JSON.stringify(preview).includes('fixture-auth-do-not-touch'));
  assert.equal(readFileSync(agents, 'utf8'), original);
  assert.throws(() => migrateRouting({ home, mode: 'apply-fixture', activeHomes: [home] }), /isolated/);
  assert.deepEqual(migrateRouting({ home, mode: 'apply-fixture' }).changes, preview.changes);
  const installed = readFileSync(agents, 'utf8');
  assert.ok(installed.includes(`${preview.changes[0].add.join('\r\n')}\r\n<!-- kitto:end -->`));
  assert.equal(statSync(agents).mode & 0o777, 0o640);
  assert.equal(migrateRouting({ home, mode: 'apply-fixture' }).changes[0].action, 'none');
  assert.equal(migrateRouting({ home, mode: 'rollback-fixture' }).changes[0].action, 'remove-managed-block');
  assert.equal(migrateRouting({ home, mode: 'rollback-fixture' }).changes[0].action, 'none');
  assert.equal(readFileSync(agents, 'utf8'), original);
  assert.equal(readFileSync(profilePatch, 'utf8'), patch);
  assert.equal(readFileSync(credentials, 'utf8'), 'fixture-auth-do-not-touch');
});

test('drifted migration markers are neither silently overwritten nor removed', (t) => {
  const { home, agents } = fixture(t);
  migrateRouting({ home, mode: 'apply-fixture' });
  const edited = readFileSync(agents, 'utf8').replace('## 模型路由执行边界', '## Local customization');
  writeFileSync(agents, edited);
  assert.throws(() => migrateRouting({ home, mode: 'rollback-fixture' }), /changed/);
  assert.equal(readFileSync(agents, 'utf8'), edited);
});
