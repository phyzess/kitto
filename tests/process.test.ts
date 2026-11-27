import { test } from 'vitest';
import assert from 'node:assert/strict';
import { GIT_NETWORK_TIMEOUT_MS, GIT_TIMEOUT_MS, gitTimeoutMs } from '../lib/process.ts';

test('a git network subcommand gets the long timeout and local work keeps the short one', () => {
  for (const command of ['clone', 'fetch', 'ls-remote', 'pull', 'push'])
    assert.equal(gitTimeoutMs([command, 'origin']), GIT_NETWORK_TIMEOUT_MS, command);
  for (const command of ['status', 'rev-parse', 'symbolic-ref', 'config', 'merge-base', 'worktree'])
    assert.equal(gitTimeoutMs([command]), GIT_TIMEOUT_MS, command);
  assert.equal(gitTimeoutMs([]), GIT_TIMEOUT_MS);
  assert.equal(GIT_NETWORK_TIMEOUT_MS, 300_000);
  assert.equal(GIT_TIMEOUT_MS, 30_000);
});
