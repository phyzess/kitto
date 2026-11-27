import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface DshInstallation {
  dir: string;
  entry: string;
}

const packageName = '@deepseek-ai/dsh';
const notAccessible = new Set(['ENOENT', 'ENOTDIR', 'EACCES']);

export class DshNotInstalledError extends Error {
  constructor() {
    super('DSH must be installed and available on PATH to configure its profile.');
  }
}

function unidentified(detail: string) {
  return new Error(`Cannot identify the selected DSH installation: ${detail}.`);
}

async function executable(path: string) {
  try {
    await access(path, constants.X_OK);
    const info = await stat(path);
    if (info.isFile()) return info;
  } catch (error) {
    if (!notAccessible.has((error as NodeJS.ErrnoException).code as string)) throw error;
  }
}

async function onPath(name: string) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const path = resolve(dir, name);
    const info = await executable(path);
    if (info) return { path, info };
  }
}

function within(directory: string, path: string) {
  const rel = relative(directory, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

async function manifestAt(dir: string) {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code as string)) throw error;
  }
}

function declaredBin(dir: string, manifest: any) {
  if (manifest?.name !== packageName) return;
  const value = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh;
  if (typeof value !== 'string' || !value || isAbsolute(value)) return;
  const bin = resolve(dir, value);
  if (bin !== dir && within(dir, bin)) return bin;
}

async function installationFor(entry: string): Promise<DshInstallation> {
  try {
    const canonical = await realpath(entry);
    if (await executable(canonical)) {
      for (let dir = dirname(canonical); ; dir = dirname(dir)) {
        const bin = declaredBin(dir, await manifestAt(dir));
        if (bin && await realpath(bin) === canonical) return { dir, entry: canonical };
        if (dir === dirname(dir)) break;
      }
    }
  } catch {
  }
  throw unidentified('its executable does not match the bin in an @deepseek-ai/dsh package');
}

async function runtimeInstallation(): Promise<DshInstallation | undefined> {
  const configured = process.env.DSH_INSTALL_DIR;
  if (!configured) return;
  try {
    if (isAbsolute(configured)) {
      const dir = await realpath(configured);
      const bin = declaredBin(dir, await manifestAt(dir));
      if (bin) {
        const entry = await realpath(bin);
        if (within(dir, entry) && await executable(entry)) return { dir, entry };
      }
    }
  } catch {
  }
  throw unidentified('DSH_INSTALL_DIR is not a verified @deepseek-ai/dsh package');
}

async function assertRuntimeMatches(selected: DshInstallation) {
  const runtime = await runtimeInstallation();
  if (runtime && runtime.dir !== selected.dir) throw unidentified('DSH_INSTALL_DIR does not match the selected executable');
  return selected;
}

export async function dshExecutable() {
  const launcher = await onPath('dsh');
  if (!launcher) throw new DshNotInstalledError();
  const mise = await onPath('mise');
  let entry: string = launcher.path;
  if (mise && mise.info.dev === launcher.info.dev && mise.info.ino === launcher.info.ino) {
    const result = spawnSync(mise.path, ['which', 'dsh'], {
      encoding: 'utf8', timeout: 8000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
    });
    entry = result.stdout?.trim();
    if (result.error || result.status !== 0 || !entry || !isAbsolute(entry) || /[\r\n\0]/.test(entry)) {
      throw unidentified('mise could not resolve dsh to a single absolute executable');
    }
  }
  return (await assertRuntimeMatches(await installationFor(entry))).entry;
}

async function importFromInstallation({ dir }: DshInstallation, name: string): Promise<any> {
  try {
    const require = createRequire(join(dir, 'package.json'));
    const resolved = await realpath(require.resolve(name));
    for (let parent = dir; ; parent = dirname(parent)) {
      const dependency = await realpath(join(parent, 'node_modules', name)).catch(error => {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code as string)) throw error;
      });
      if (dependency && within(dependency, resolved)) return await import(pathToFileURL(resolved).href);
      if (parent === dirname(parent)) break;
    }
  } catch {
  }
  throw new Error(`Cannot load ${name} from the selected DSH installation.`);
}

export async function importFromDsh(entry: string, name: string): Promise<any> {
  return importFromInstallation(await assertRuntimeMatches(await installationFor(entry)), name);
}

export async function importFromRunningDsh(name: string): Promise<any> {
  const runtime = await runtimeInstallation();
  if (runtime) {
    if (process.argv[1]) {
      const selected = await installationFor(process.argv[1]);
      if (runtime.dir !== selected.dir) throw unidentified('DSH_INSTALL_DIR does not match the running executable');
    }
    return importFromInstallation(runtime, name);
  }
  return importFromDsh(process.argv[1], name);
}

export async function loadDshModule(name: string, executable?: string): Promise<any> {
  return importFromDsh(executable ?? await dshExecutable(), name);
}

export async function loadDshYaml(executable?: string) {
  return loadDshModule('yaml', executable);
}
