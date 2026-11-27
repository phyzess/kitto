import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'));
export const present = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
};

export async function replaceDirectory(source: string, target: string): Promise<void> {
  const temporary = `${target}.kitto-tmp-${process.pid}`;
  const backup = `${target}.kitto-old-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  await cp(source, temporary, { recursive: true });
  const existed = await present(target);
  if (existed) await rename(target, backup);
  try {
    await rename(temporary, target);
  } catch (error) {
    if (existed) await rename(backup, target);
    throw error;
  }
  if (existed) await rm(backup, { recursive: true, force: true });
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function treeHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(directory: string, relative = ''): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name),
        full = join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`dir:${name}\0`);
        await walk(full, name);
      } else if (entry.isFile()) {
        hash.update(`file:${name}\0`);
        hash.update(await readFile(full));
      } else
        throw Object.assign(new Error(`Unsupported symlink or special file in skill: ${full}`), {
          code: 'KITTO_UNSUPPORTED_SKILL_ENTRY',
        });
    }
  }
  await walk(path);
  return hash.digest('hex');
}
