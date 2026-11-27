import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export type DesktopProbeKind = 'uninitialized' | 'unknown' | 'timeout' | 'unavailable' | 'npm-cli' | 'desktop-cli';

export interface DesktopProbe {
  kind: DesktopProbeKind;
  detail?: string;
}

export const desktopProfile = 'desktop';
const profileName = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function normalizeDshProfile(value: unknown = 'web'): string {
  const profile = String(value);
  return profile.toLowerCase() === desktopProfile ? desktopProfile : profile;
}

export function isDesktopProfile(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase() === desktopProfile;
}

export function validateDshProfile(value: string, message = 'Invalid DSH CLI profile name.'): string {
  if (!profileName.test(value)) throw new Error(message);
  return normalizeDshProfile(value);
}

export const desktopProfileNotice = 'DSH desktop profile: managed by the DeepSeek Harness Desktop app. ' +
  'Kitto v1 deploys only global AGENTS.md and skills for it; it does not install a Kitto bundle, write ' +
  'profiles/desktop/cordis.patch.yml, register a scope adapter or sync the MCP home patch. ' +
  'For a Kitto bundle, scoped configuration or MCP sync, use --dsh-profile web instead.';

export const desktopScopeError = 'The DSH desktop profile is managed by the DeepSeek Harness Desktop app; ' +
  'Kitto v1 does not write scoped profile patches or adapters for it. Use global setup ' +
  '(kitto setup --agents dsh --dsh-profile desktop) or select the web profile for scoped configuration.';

const desktopProbeWarnings: Record<string, string> = {
  'npm-cli': 'The dsh on PATH is the npm CLI and cannot manage the desktop profile. Kitto does not use it for this ' +
    'profile and still deploys only global rules and skills; use --dsh-profile web for Kitto bundle or scope support.',
  uninitialized: 'The DSH desktop profile has not been initialized. Start DeepSeek Harness Desktop once so it can ' +
    'create its profile, then fully quit it; Kitto still deploys only global rules and skills.',
  unavailable: 'No dsh CLI was found on PATH, so the Desktop profile check was skipped. Kitto still deploys only ' +
    'global rules and skills, and the Desktop app remains the owner of its profile.',
  timeout: 'The Desktop profile check timed out. Kitto left the app-managed profile untouched and still deploys only ' +
    'global rules and skills; fully quit DeepSeek Harness Desktop and rerun if you want the check repeated.',
};

export function probeDesktopProfile({ dshHome, env = process.env, timeoutMs = 60_000 }: { dshHome?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): DesktopProbe {
  const home = dshHome || env.DSH_HOME || join(homedir(), '.dsh');
  const profileDir = join(home, 'profiles', desktopProfile);
  const manifest = join(profileDir, 'package.json');
  try { lstatSync(manifest); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return { kind: 'uninitialized', detail: manifest };
    return { kind: 'unknown', detail: `cannot inspect ${manifest}: ${(error as NodeJS.ErrnoException).code || (error as Error).message}` };
  }

  let scratch: string | undefined;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'kitto-dsh-desktop-'));
    const scratchProfile = join(scratch, 'profiles', desktopProfile);
    mkdirSync(scratchProfile, { recursive: true });
    copyFileSync(manifest, join(scratchProfile, 'package.json'));
    const compatibility = join(profileDir, 'compatibility.json');
    if (existsSync(compatibility)) copyFileSync(compatibility, join(scratchProfile, 'compatibility.json'));
    const result = spawnSync('dsh', ['plugin', '--profile', desktopProfile, 'version-exemptions'], {
      encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, DSH_HOME: scratch },
    });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM' || result.signal === 'SIGKILL') {
      return { kind: 'timeout', detail: `probe timed out after ${timeoutMs}ms` };
    }
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { kind: 'unavailable', detail: 'dsh was not found on PATH' };
    if (result.error) return { kind: 'unavailable', detail: result.error.message };
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    if (/managed exclusively by the Electron application/i.test(detail)) return { kind: 'npm-cli', detail };
    if (/Open DeepSeek Harness Desktop once to initialize its profile/i.test(detail)) return { kind: 'uninitialized', detail };
    if (result.status === 0) {
      try {
        JSON.parse(result.stdout ?? '');
        return { kind: 'desktop-cli', detail };
      } catch {  }
    }
    return { kind: 'unknown', detail: detail || `exit ${result.status}` };
  } catch (error) {
    return { kind: 'unknown', detail: (error as Error).message };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

export function reportDesktopProbe(probe: DesktopProbe, { log = console.log, warn = console.warn }: { log?: (message: string) => void; warn?: (message: string) => void } = {}): void {
  if (probe.kind === 'desktop-cli') {
    log('DSH desktop CLI: initialized profile detected (probe ran against a temporary copy).');
    return;
  }
  if (Object.hasOwn(desktopProbeWarnings, probe.kind)) {
    warn(`Kitto: ${desktopProbeWarnings[probe.kind]}`);
    return;
  }
  const detail = probe.detail?.split('\n').slice(0, 2).join(' ').slice(0, 300);
  warn(`Kitto: could not verify the DSH desktop profile${detail ? ` (${detail})` : ''}. ` +
    'Kitto still deploys only global rules and skills; check that DeepSeek Harness Desktop has been started once ' +
    'and fully quit.');
}
