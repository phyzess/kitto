import { lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameLocation } from './paths.ts';

const packageDir = fileURLToPath(new URL('../', import.meta.url));

function piAgentDir(home) {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(home, '.pi/agent');
  if (configured === '~') return home;
  if (configured.startsWith('~/')) return join(home, configured.slice(2));
  if (configured.startsWith('file://')) return fileURLToPath(configured);
  return resolve(configured);
}

export async function installPiScope({ dryRun = false, home = homedir(), runtime = packageDir } = {}) {
  const adapter = resolve(runtime, 'integration/scoped-pi/index.mjs');
  const path = join(piAgentDir(home), 'extensions', 'kitto-scopes.js');

  async function existingAdapter() {
    const info = await lstat(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!info) return false;
    if (info.isSymbolicLink() && sameLocation(resolve(dirname(path), await readlink(path)), adapter)) return true;
    throw new Error(`Pi scope extension path is already occupied: ${path}`);
  }

  if (await existingAdapter()) return { path, changed: false };
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true });
    try {
      await symlink(adapter, path, 'file');
    } catch (error) {
      if (error.code !== 'EEXIST' || !await existingAdapter()) throw error;
      return { path, changed: false };
    }
  }
  return { path, changed: true };
}
