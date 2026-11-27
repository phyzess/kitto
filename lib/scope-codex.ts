import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameLocation } from './paths.ts';
import type { Json } from '../types/kitto.d.ts';
import type { ScopeInstallOptions } from './scope-pi.ts';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const existing = async (path: string) =>
  lstat(path).catch((error: unknown): null => {
    if (!missing(error)) throw error;
    return null;
  });

async function inspectHooks(path: string) {
  const info = await existing(path);
  if (info && !info.isFile()) throw new Error(`Codex hooks path is not a regular file: ${path}`);
  return { info, text: info ? await readFile(path, 'utf8') : null };
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function installCodexScope({
  dryRun = false,
  home = homedir(),
  root,
  global,
  runtime = packageDir,
}: ScopeInstallOptions = {}) {
  const path = join(resolve(process.env.CODEX_HOME || join(home, '.codex')), 'hooks.json');
  const { info, text } = await inspectHooks(path);
  const config: Json = text === null ? {} : JSON.parse(text);
  if (!isObject(config) || (config.hooks !== undefined && !isObject(config.hooks))) {
    throw new Error(`Invalid Codex hooks file: ${path}`);
  }
  config.hooks ??= {};
  const groups: Json[] = config.hooks.SessionStart ?? [];
  if (!Array.isArray(groups)) throw new Error(`Invalid SessionStart hooks in ${path}`);

  const adapter = join(runtime, 'integration/scoped-codex/session-start.mjs');
  const command = [process.execPath, adapter].map(shellQuote).join(' ');
  const needsHook = !groups.some(
    (group: Json) =>
      Array.isArray(group?.hooks) && group.hooks.some((handler: Json) => handler?.type === 'command' && handler.command === command),
  );

  const skillsPath = global ? join(home, '.agents/skills/kitto-shared') : null;
  const skillsSource = global ? join(root, '.agents/skills') : null;
  async function needsLink() {
    if (!skillsPath) return false;
    const entry = await existing(skillsPath);
    if (!entry) return true;
    if (entry.isSymbolicLink() && sameLocation(resolve(dirname(skillsPath), await readlink(skillsPath)), skillsSource)) return false;
    throw new Error(`Codex shared skills path is already occupied: ${skillsPath}`);
  }
  const link = await needsLink();
  if (!dryRun && needsHook) {
    config.hooks.SessionStart = [
      ...groups,
      {
        hooks: [{ type: 'command', command, statusMessage: 'Loading Kitto scopes' }],
      },
    ];
    await mkdir(dirname(path), { recursive: true });
    const staging = await mkdtemp(join(dirname(path), '.kitto-hooks-'));
    try {
      const next = join(staging, 'hooks.json');
      await writeFile(next, JSON.stringify(config, null, 2) + '\n', { mode: info ? info.mode & 0o777 : 0o600 });
      if ((await inspectHooks(path)).text !== text) throw new Error(`Codex hooks changed during setup: ${path}`);
      await rename(next, path);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  if (!dryRun && link) {
    await mkdir(dirname(skillsPath), { recursive: true });
    try {
      await symlink(skillsSource, skillsPath, 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await needsLink())) throw error;
    }
  }
  if (dryRun) console.log(`Codex scoped configuration: ${path}`);
  else if (needsHook) console.log('In Codex, review and trust the Kitto SessionStart hook with /hooks. Start a new session afterward.');
  return { path, changed: needsHook || link, skillsPath };
}
