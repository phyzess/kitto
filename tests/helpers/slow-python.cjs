const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
if (args.join(' ').includes('version_info >= (3, 10)')) {
  const until = Date.now() + 12_000;
  while (Date.now() < until) {}
}
const result = spawnSync(process.env.REAL_PYTHON, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
