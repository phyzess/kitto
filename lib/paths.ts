import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function sameLocation(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const canonical = (path: string) => {
    try {
      return realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return resolve(path);
      throw error;
    }
  };
  return canonical(a) === canonical(b);
}
