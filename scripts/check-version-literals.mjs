import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hosts, pnpmVersion, routingHostVersion } from '../lib/host-pins.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const scanned = ['lib', 'integration', 'bin', 'scripts', '.github'];
const allowedFiles = new Set(['lib/host-pins.ts']);
const docs = ['docs/usage.md', 'docs/model-routing.md'];

const pinned = new Map([
  ...Object.entries(hosts).map(([name, host]) => [`hosts.${name}.version`, host.version]),
  ['pnpmVersion', pnpmVersion],
  ['routingHostVersion', routingHostVersion],
]);

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(path);
    return entry.isFile() ? [path] : [];
  });
}

function lines(text, version) {
  const pattern = new RegExp(`(?<![\\w.])${version.replace(/[.+]/g, '\\$&')}(?!\\w|\\.\\d)`, 'g');
  return [...text.matchAll(pattern)].map(match => text.slice(0, match.index).split('\n').length);
}

const failures = [];
for (const directory of scanned) {
  const base = join(root, directory);
  if (!statSync(base, { throwIfNoEntry: false })?.isDirectory()) continue;
  for (const path of files(base)) {
    const name = relative(root, path).split('\\').join('/');
    if (allowedFiles.has(name)) continue;
    const text = readFileSync(path, 'utf8');
    for (const [label, version] of pinned) {
      for (const line of lines(text, version)) failures.push(`${name}:${line} repeats ${label} (${version})`);
    }
  }
}

for (const name of docs) {
  const text = readFileSync(join(root, name), 'utf8');
  for (const version of new Set(text.match(/\d+\.\d+\.\d+-rc\.\d+/g) ?? [])) {
    if (version !== hosts.dsh.version && version !== routingHostVersion) {
      console.warn(`warning: ${name} mentions DSH ${version}, which is neither the baseline nor the routing version.`);
    }
  }
}

if (failures.length) {
  console.error(`Version literals must be imported from lib/host-pins.ts:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('No pinned host version literals outside lib/host-pins.ts.');
