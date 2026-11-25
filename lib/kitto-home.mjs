import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));

export const kittoHome = () => {
  const installedHome = dirname(resolve(packageRoot));
  return resolve(process.env.KITTO_HOME || (existsSync(join(installedHome, 'state.json')) && resolve(packageRoot) === join(installedHome, 'runtime')
    ? installedHome : join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'kitto')));
};
