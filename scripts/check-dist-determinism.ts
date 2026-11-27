import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function distHash() {
  const hash = createHash('sha256');
  for (const file of files(dist).sort())
    hash
      .update(`${relative(dist, file)}\0`)
      .update(readFileSync(file))
      .update('\0');
  return hash.digest('hex');
}

function build() {
  const result = spawnSync('npm', ['run', 'build', '--silent'], { cwd: root, stdio: 'ignore' });
  if (result.status !== 0) throw new Error('npm run build failed.');
  return distHash();
}

const runs = Number(process.argv[2] ?? 2);
const hashes = Array.from({ length: runs }, build);
if (new Set(hashes).size !== 1) {
  console.error(`dist differs between builds:\n${hashes.join('\n')}`);
  process.exit(1);
}
console.log(`dist is identical across ${runs} builds (${hashes[0].slice(0, 12)}).`);
