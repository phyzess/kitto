import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const copied = ['CHANGELOG.md', 'README.md', 'integration/skills', 'integration/cordis.patch.yml', 'integration/plugin.json'];

export function distManifest(manifest) {
  const { scripts, devDependencies, ...published } = manifest;
  return { ...published, files: [...manifest.files, '!**/*.map'] };
}

export function assembleDist(source = root, dist = join(root, 'dist')) {
  for (const path of copied) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    cpSync(join(source, path), join(dist, path), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  writeFileSync(join(dist, 'package.json'), `${JSON.stringify(distManifest(manifest), null, 2)}\n`);
}
