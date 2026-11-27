import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopScopeError, isDesktopProfile, validateDshProfile } from './dsh-profile.ts';
import { DshNotInstalledError, dshExecutable, importFromDsh } from '../integration/scoped-dsh/native.ts';
import type { Json } from '../types/kitto.d.ts';
import type { ScopeInstallOptions } from './scope-pi.ts';

const pluginId = 'phyzess-kitto-scopes';
const defaultRuntime = fileURLToPath(new URL('../', import.meta.url));

async function readPatch(path: string): Promise<{ content: string | null; mode: number }> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`DSH profile patch is not a regular file: ${path}`);
    return { content: await readFile(path, 'utf8'), mode: info.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { content: null, mode: 0o600 };
  }
}

export async function installDshScope({
  dryRun,
  home,
  runtime = defaultRuntime,
  dshProfile = 'web',
}: ScopeInstallOptions & { home: string }): Promise<void> {
  const profile = validateDshProfile(dshProfile);
  if (isDesktopProfile(profile)) throw new Error(desktopScopeError);
  const configuredHome = process.env.DSH_HOME?.trim() || join(home, '.dsh');
  const dshHome = resolve(
    configuredHome === '~' ? home : configuredHome.startsWith('~/') ? join(home, configuredHome.slice(2)) : configuredHome,
  );
  const path = join(dshHome, 'profiles', profile, 'cordis.patch.yml');
  const plugin = join(runtime, 'integration', 'scoped-dsh', 'index.mjs');
  let executable: string;
  try {
    executable = await dshExecutable();
  } catch (error) {
    if (!dryRun || !(error instanceof DshNotInstalledError)) throw error;
    console.log(`DSH scoped configuration would register after DSH is installed: ${path} (profile not validated)`);
    return;
  }
  const [{ isSeq, parseDocument }, { PROFILE_TEMPLATES }] = await Promise.all([
    importFromDsh(executable, 'yaml'),
    importFromDsh(executable, '@deepseek-ai/dsh-official-bundles'),
  ]);
  if (!Object.hasOwn(PROFILE_TEMPLATES, profile) && (await readPatch(join(dirname(path), 'package.json'))).content === null) {
    throw new Error(`Initialize the native DSH profile ${profile} before setup.`);
  }
  const before = await readPatch(path);
  const document = parseDocument(before.content ?? '[]\n', {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: unknown) => value }],
  });
  if (document.errors.length) throw document.errors[0];
  if (!isSeq(document.contents)) throw new Error(`DSH profile patch must be a YAML sequence: ${path}`);

  const rows = document
    .toJS()
    .flatMap((item: Json) => item?.insert ?? [])
    .filter((row: Json) => row?.id === pluginId);
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
  console.log(`DSH scoped configuration registered for the ${profile} profile. Restart running DSH servers for this profile.`);
}
