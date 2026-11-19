import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function importFromDsh(entry, name) {
  const require = createRequire(await realpath(entry));
  return import(pathToFileURL(require.resolve(name)).href);
}
