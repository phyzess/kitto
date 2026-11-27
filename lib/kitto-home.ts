import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameLocation } from './paths.ts';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));

export const kittoVersion = (): string => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const kittoHome = (): string => {
  const installedHome = dirname(resolve(packageRoot));
  return resolve(
    process.env.KITTO_HOME ||
      (existsSync(join(installedHome, 'state.json')) && sameLocation(packageRoot, join(installedHome, 'runtime'))
        ? installedHome
        : join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'kitto')),
  );
};
