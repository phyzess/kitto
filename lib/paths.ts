import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function sameLocation(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const canonical = path => {
    try { return realpathSync(path); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return resolve(path);
      throw error;
    }
  };
  return canonical(a) === canonical(b);
}
