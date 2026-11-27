import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hosts } from '../host-pins.mjs';
import { meetsBaseline, readVersion } from '../version-order.mjs';
import { available, run } from '../process.mjs';

export function nativeCli(name, { scratchHomeVariable, capabilityArgs = {} } = {}) {
  const withProbeEnv = callback => {
    if (!scratchHomeVariable) return callback(process.env);
    const probe = mkdtempSync(join(tmpdir(), 'kitto-codex-check-'));
    try { return callback({ ...process.env, [scratchHomeVariable]: probe }); }
    finally { rmSync(probe, { recursive: true, force: true }); }
  };
  const capabilities = env => Object.fromEntries(Object.entries(capabilityArgs).map(([capability, args]) => [
    capability, spawnSync(name, args, { stdio: 'ignore', timeout: 8000, env }).status === 0,
  ]));
  return {
    name,
    available: () => withProbeEnv(env => available(name, env)),
    inspect: () => withProbeEnv(env => {
      const result = spawnSync(name, ['--version'], { encoding: 'utf8', timeout: 8000, env });
      const stdout = (result.stdout ?? '').trim();
      const actual = !result.error && result.status === 0 ? readVersion(stdout) : null;
      const baseline = hosts[name].version;
      const missing = result.error?.code === 'ENOENT';
      const detail = (stdout.split('\n')[0] || (result.stderr ?? '').trim().split('\n')[0] || `exit ${result.status}`);
      return {
        name, baseline, actual, status: missing ? 'missing' : actual ? 'found' : 'unreadable', detail,
        meetsBaseline: Boolean(actual) && meetsBaseline(actual, baseline),
        capabilities: missing ? {} : capabilities(env),
      };
    }),
    reportVersion: () => {
      const baseline = hosts[name].version;
      try {
        const output = withProbeEnv(env => run(name, ['--version'], { capture: true, timeout: 8000, env }));
        const actual = readVersion(output) || output.split('\n')[0];
        console.log(`  ${name}: ${actual} (Kitto tested baseline ${baseline}); upgrade with its native manager (${hosts[name].package})`);
      } catch {
        console.log(`  ${name}: not found (Kitto tested baseline ${baseline}); install ${hosts[name].package} with its native manager`);
      }
    },
  };
}
