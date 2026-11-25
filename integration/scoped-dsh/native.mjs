import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function dshExecutable() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(dir, 'dsh');
    try {
      await access(candidate, constants.X_OK);
      if ((await lstat(candidate)).isDirectory()) continue;
      const entry = await realpath(candidate);
      if (entry.endsWith('/mise') || dir.endsWith('/shims')) {
        const result = spawnSync(entry.endsWith('/mise') ? entry : 'mise', ['which', 'dsh'], { encoding: 'utf8', timeout: 8000 });
        if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
      }
      return candidate;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error('DSH must be installed and available on PATH to configure its profile.');
}

export async function importFromDsh(entry, name) {
  const require = createRequire(await realpath(entry));
  return import(pathToFileURL(require.resolve(name)).href);
}

export async function loadDshModule(name, executable) {
  return importFromDsh(executable ?? await dshExecutable(), name);
}

export async function loadDshYaml(executable) {
  return loadDshModule('yaml', executable);
}
