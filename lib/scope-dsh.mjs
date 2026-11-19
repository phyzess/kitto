import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importFromDsh } from '../integration/scoped-dsh/native.mjs';

const pluginId = 'phyzess-kitto-scopes';
const defaultRuntime = fileURLToPath(new URL('../', import.meta.url));

async function dshExecutable() {
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

async function readPatch(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`DSH profile patch is not a regular file: ${path}`);
    return { content: await readFile(path, 'utf8'), mode: info.mode & 0o777 };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { content: null, mode: 0o600 };
  }
}

export async function installDshScope({ dryRun, home, runtime = defaultRuntime, dshProfile = 'web' }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(dshProfile) || dshProfile === 'desktop') {
    throw new Error('Invalid DSH CLI profile name.');
  }
  const configuredHome = process.env.DSH_HOME?.trim() || join(home, '.dsh');
  const dshHome = resolve(configuredHome === '~' ? home
    : configuredHome.startsWith('~/') ? join(home, configuredHome.slice(2)) : configuredHome);
  const path = join(dshHome, 'profiles', dshProfile, 'cordis.patch.yml');
  const plugin = join(runtime, 'integration', 'scoped-dsh', 'index.mjs');
  const executable = await dshExecutable();
  const [{ isSeq, parseDocument }, { PROFILE_TEMPLATES }] = await Promise.all([
    importFromDsh(executable, 'yaml'),
    importFromDsh(executable, '@deepseek-ai/dsh-official-bundles'),
  ]);
  if (!Object.hasOwn(PROFILE_TEMPLATES, dshProfile) && (await readPatch(join(dirname(path), 'package.json'))).content === null) {
    throw new Error(`Initialize the native DSH profile ${dshProfile} before setup.`);
  }
  const before = await readPatch(path);
  const document = parseDocument(before.content ?? '[]\n', {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  });
  if (document.errors.length) throw document.errors[0];
  if (!isSeq(document.contents)) throw new Error(`DSH profile patch must be a YAML sequence: ${path}`);

  const rows = document.toJS().flatMap(item => item?.insert ?? []).filter(row => row?.id === pluginId);
  if (rows.length) {
    if (rows.length === 1 && rows[0].name === plugin) {
      if (dryRun) console.log(`DSH scoped configuration already registered: ${path}`);
      return;
    }
    throw new Error(`DSH profile already contains a different ${pluginId} entry: ${path}`);
  }
  if (dryRun) {
    console.log(`DSH scoped configuration: ${path}`);
    return;
  }
  document.add({ insert: [{ id: pluginId, name: plugin }] });
  document.contents.flow = false;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, document.toString(), { flag: 'wx', mode: before.mode });
    if ((await readPatch(path)).content !== before.content) {
      throw new Error(`DSH profile patch changed during setup: ${path}`);
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`DSH scoped configuration registered for the ${dshProfile} profile. Restart running DSH servers for this profile.`);
}
