import { spawnSync } from 'node:child_process';

// The Desktop app manages this reserved profile; the name is case-insensitive.
export const desktopProfile = 'desktop';
const profileName = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function normalizeDshProfile(value = 'web') {
  const profile = String(value);
  return profile.toLowerCase() === desktopProfile ? desktopProfile : profile;
}

export function isDesktopProfile(value) {
  return typeof value === 'string' && value.toLowerCase() === desktopProfile;
}

/** Validate a profile name and normalize the reserved Desktop name. */
export function validateDshProfile(value, message = 'Invalid DSH CLI profile name.') {
  if (!profileName.test(value)) throw new Error(message);
  return normalizeDshProfile(value);
}

export const desktopProfileNotice = 'DSH desktop profile: managed by the DeepSeek Harness Desktop app. ' +
  'Kitto v1 deploys only global AGENTS.md and skills for it; it does not install a Kitto bundle, write ' +
  'profiles/desktop/cordis.patch.yml, register a scope adapter or touch the MCP home patch. ' +
  'For Kitto bundle/scope support, install DSH\'s in-app CLI from Desktop\'s "Manage dsh Command…" menu ' +
  'or use --dsh-profile web.';

export const desktopScopeError = 'The DSH desktop profile is managed by the DeepSeek Harness Desktop app; ' +
  'Kitto v1 does not write scoped profile patches or adapters for it. Use global setup ' +
  '(kitto setup --agents dsh --dsh-profile desktop) or select the web profile for scoped configuration.';

const desktopProbeWarnings = {
  'npm-cli': 'The dsh on PATH is the npm CLI and cannot manage the desktop profile. ' +
    'Install DSH\'s in-app CLI from DeepSeek Harness Desktop\'s "Manage dsh Command…" menu if you need native ' +
    'plugin operations; Kitto still deploys only global rules and skills.',
  uninitialized: 'The DSH desktop profile has not been initialized. Start DeepSeek Harness Desktop once, ' +
    'fully quit it, and rerun Kitto setup so the app can load the deployed global rules and skills.',
};

/**
 * Read-only probe: the npm CLI rejects the reserved profile before pnpm runs,
 * the Desktop carrier reports its profile exemptions (or asks for the profile
 * to be initialized), and nothing is written in either case.
 */
export function probeDesktopProfile({ dshHome, env = process.env } = {}) {
  const childEnv = { ...env };
  if (dshHome) childEnv.DSH_HOME = dshHome;
  const result = spawnSync('dsh', ['plugin', '--profile', desktopProfile, 'version-exemptions'], {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
  });
  if (result.error) return { kind: 'unavailable', detail: result.error.message };
  const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (/managed exclusively by the Electron application/i.test(detail)) return { kind: 'npm-cli', detail };
  if (/Open DeepSeek Harness Desktop once to initialize its profile/i.test(detail)) return { kind: 'uninitialized', detail };
  if (result.status === 0) {
    try {
      JSON.parse(result.stdout ?? '');
      return { kind: 'desktop-cli', detail };
    } catch { /* Not a DSH exemption report. */ }
  }
  return { kind: 'unknown', detail: detail || `exit ${result.status}` };
}

/** Print one actionable line for a Desktop probe result. */
export function reportDesktopProbe(probe, { log = console.log, warn = console.warn } = {}) {
  if (probe.kind === 'desktop-cli') {
    log('DSH desktop CLI: initialized profile detected.');
    return;
  }
  if (probe.kind === 'npm-cli' || probe.kind === 'uninitialized') {
    warn(`Kitto: ${desktopProbeWarnings[probe.kind]}`);
    return;
  }
  const detail = probe.detail?.split('\n').slice(0, 2).join(' ').slice(0, 300);
  warn(`Kitto: could not verify the DSH desktop profile${detail ? ` (${detail})` : ''}. ` +
    'Kitto still deploys only global rules and skills; check that DeepSeek Harness Desktop has been started once ' +
    'and fully quit, and that its in-app dsh command is on PATH.');
}
