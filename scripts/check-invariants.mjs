import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootIndex = process.argv.indexOf('--root');
const root = rootIndex > 0 ? resolve(process.argv[rootIndex + 1] ?? '') : repo;
const bin = join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'ast-grep.cmd' : 'ast-grep');

if (!existsSync(bin)) {
  console.error('ast-grep is not installed; run npm ci --ignore-scripts.');
  process.exit(2);
}
if (!existsSync(join(root, 'sgconfig.yml'))) {
  console.error(`No sgconfig.yml in ${root}.`);
  process.exit(2);
}

const result = spawnSync(bin, ['scan', '--config', 'sgconfig.yml'], { cwd: root, stdio: 'inherit' });
if (result.error) {
  console.error(result.error.message);
  process.exit(2);
}
process.exit(result.status ?? 1);
