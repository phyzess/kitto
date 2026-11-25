// A python3 that answers --version instantly but stalls the version probe, so
// tests can prove a slow interpreter shim warns instead of aborting the run.
// Every other invocation is delegated to the real interpreter in REAL_PYTHON.
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
if (args.join(' ').includes('version_info >= (3, 10)')) {
  const until = Date.now() + 12_000;
  // Busy-wait so the parent's probe timeout kills this child.
  while (Date.now() < until) { /* stall */ }
}
const result = spawnSync(process.env.REAL_PYTHON, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
