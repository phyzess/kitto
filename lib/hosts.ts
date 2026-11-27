import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { loadKittoState } from './state-io.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hosts } from './host-pins.ts';
import { kittoHome } from './kitto-home.ts';
import { isDesktopProfile } from './dsh-profile.ts';
import { compareVersions, isExactPin, readVersion } from './version-order.ts';
import type { HostName, State } from '../types/kitto.d.ts';

export interface HostsOptions {
  apply?: boolean;
  host?: HostName;
  version?: string;
}

type HostProbe = { status: 'missing' } | { status: 'unreadable'; detail: string } | { status: 'found'; current: string };

type RowAction = 'none' | 'upgrade' | 'install' | 'pin' | 'same-build-precedence' | 'newer' | 'unreadable';

interface AppManagedRow {
  name: HostName;
  appManaged: true;
  package: string;
  baseline: string;
}

type ManagedRow = HostProbe & {
  name: HostName;
  appManaged?: false;
  package: string;
  baseline: string;
  target: string;
  command: string[];
  action: RowAction;
};

type HostRow = AppManagedRow | ManagedRow;

const isManaged = (row: HostRow): row is ManagedRow => !row.appManaged;

export { compareVersions };

const policy =
  'Policy: default to the pinned Kitto-validated baseline, never the latest release; ' +
  'an explicit --version overrides it only when you ask. Kitto never upgrades or checks host CLIs automatically.';

export function parseHostsArgs(args: string[] = []): HostsOptions {
  const options: Record<string, any> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--host' || arg === '--version') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}.`);
      options[arg.slice(2)] = value;
      i++;
    } else throw new Error(`Unknown hosts option: ${arg}. Read the Kitto skill or run kitto --help.`);
  }
  if (options.check && options.apply) throw new Error('Choose either --check or --apply for hosts.');
  if (options.host && !hosts[options.host as HostName]) throw new Error('--host must be pi, codex or dsh.');
  if (options.version && !isExactPin(options.version)) {
    throw new Error(`--version must be one exact semantic version (got ${options.version}); dist-tags and ranges are refused.`);
  }
  delete options.check;
  return options as HostsOptions;
}

async function readState(): Promise<{ home: string; state: State }> {
  const home = kittoHome();
  let state: State;
  try {
    state = await loadKittoState(home, { dryRun: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Kitto is not set up in ${home}. Run kitto setup first.`);
    throw error;
  }
  if (state.detached || state.removing)
    throw new Error('Kitto is detached or removal is incomplete. Use setup to reconnect, or finish remove.');
  if (!Array.isArray(state.agents) || !state.agents.length)
    throw new Error('Kitto state records no selected hosts. Run kitto setup again.');
  return { home, state };
}

const appManaged = (state: State, name: HostName) => name === 'dsh' && isDesktopProfile(state.dshProfile);

function probeHost(name: HostName): HostProbe {
  const probe = name === 'codex' ? mkdtempSync(join(tmpdir(), 'kitto-codex-hosts-')) : null;
  try {
    const result = spawnSync(name, ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      env: probe ? { ...process.env, CODEX_HOME: probe } : process.env,
    });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { status: 'missing' };
    if (result.error) return { status: 'unreadable', detail: result.error.message };
    if (result.status !== 0) {
      const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().split('\n')[0];
      return { status: 'unreadable', detail: detail || `exit ${result.status}` };
    }
    const output = (result.stdout ?? '').trim();
    const current = readVersion(output);
    return current ? { status: 'found', current } : { status: 'unreadable', detail: output.split('\n')[0] || 'empty version output' };
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
}

function selectHosts(state: State, options: HostsOptions): HostName[] {
  const selected = options.host ? state.agents.filter((name) => name === options.host) : [...state.agents];
  if (!selected.length) {
    throw new Error(`${options.host} is not a selected host (${state.agents.join(', ')}). Run kitto setup --agents ${options.host} first.`);
  }
  if (options.version && selected.length > 1) {
    throw new Error(`--version pins one host. Add --host <${selected.join('|')}> or omit --version to use each baseline.`);
  }
  return selected;
}

function buildRows(state: State, options: HostsOptions): HostRow[] {
  const selected = selectHosts(state, options);
  const pin = options.version;
  const rows = selected.map((name): HostRow => {
    const baseline = hosts[name].version;
    if (appManaged(state, name)) {
      if (pin)
        throw new Error(
          'The DSH desktop profile is app-managed; Kitto never installs or pins its CLI. Upgrade it in DeepSeek Harness Desktop.',
        );
      return { name, appManaged: true, package: hosts[name].package, baseline };
    }
    const target = pin || baseline;
    const command = ['npm', 'install', '--global', `${hosts[name].package}@${target}`];
    const probe = probeHost(name);
    let action: RowAction;
    if (probe.status !== 'found') action = probe.status === 'missing' ? 'install' : 'unreadable';
    else if (probe.current === target) action = 'none';
    else {
      const order = compareVersions(probe.current, target);
      action = order !== null && order < 0 ? 'upgrade' : pin ? 'pin' : order === 0 ? 'same-build-precedence' : 'newer';
    }
    return { name, package: hosts[name].package, baseline, target, command, ...probe, action };
  });
  return rows;
}

function currentLabel(row: ManagedRow) {
  if (row.status === 'found') return row.current;
  if (row.status === 'missing') return 'not found';
  return `unreadable (${row.detail})`;
}

function actionLabel(row: ManagedRow) {
  switch (row.action) {
    case 'none':
      return 'already at the target version';
    case 'upgrade':
      return 'upgrade needed';
    case 'install':
      return 'not installed; --apply installs the pinned baseline';
    case 'pin':
      return 'explicit pin differs from the installed version';
    case 'same-build-precedence':
      return 'same precedence as the baseline, but different build metadata; Kitto leaves it unchanged (use --version to pin explicitly)';
    case 'newer':
      return 'newer than the baseline; Kitto does not downgrade (use --version to pin explicitly)';
    default:
      return 'cannot read its version; --apply stops before changing anything';
  }
}

const actionable = (row: HostRow) => isManaged(row) && ['upgrade', 'install', 'pin'].includes(row.action);

function pinWarning(row: HostRow) {
  if (row.appManaged || row.target === row.baseline) return null;
  return `      WARNING: ${row.target} is an explicit --version pin, not the Kitto-validated baseline ${row.baseline}; only the baseline is validated.`;
}

function printRow(row: HostRow) {
  if (row.appManaged) {
    console.log(`  ${row.name}: app-managed by DeepSeek Harness Desktop; Kitto baseline ${row.baseline}; Kitto never upgrades its CLI`);
    console.log('      upgrade through DeepSeek Harness Desktop');
    return;
  }
  const target = row.target === row.baseline ? row.target : `${row.target} (explicit pin; Kitto baseline ${row.baseline})`;
  console.log(`  ${row.name}: current ${currentLabel(row)}; Kitto baseline ${row.baseline}; target ${target}; ${actionLabel(row)}`);
  console.log(`      native manager: ${row.command.join(' ')}`);
  const warning = pinWarning(row);
  if (warning) console.log(warning);
}

function printCheck(state: State, rows: HostRow[]) {
  console.log(`Kitto ${state.version} host CLIs (check only; no writes).`);
  console.log(policy);
  for (const row of rows) printRow(row);
  if (rows.some(actionable)) {
    console.log('Preview only: run `kitto hosts --apply` to install the targets above. No writes.');
  } else if (rows.some((row) => !row.appManaged)) {
    console.log('Nothing for Kitto to change: selected host CLIs are at or above the pinned targets. No writes.');
  } else {
    console.log('Nothing for Kitto to manage for the selected hosts. No writes.');
  }
}

function npmAvailable() {
  return spawnSync('npm', ['--version'], { stdio: 'ignore', timeout: 8000 }).status === 0;
}

const permissionHint =
  'npm could not write to its global prefix. Retry with a writable npm prefix ' +
  '(for example `npm config set prefix ~/.npm-global`) or use an administrator/sudo shell.';

function runCommand(command: string[]) {
  const [name, ...args] = command;
  const result = spawnSync(name, args, { stdio: ['inherit', 'inherit', 'pipe'], encoding: 'utf8', timeout: 600_000 });
  const stderr = (result.stderr ?? '').trim();
  if (result.error) throw new Error(`${name} ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = stderr.split('\n').filter(Boolean).slice(0, 3).join(' ');
    const permission = /EACCES|EPERM|permission denied|access is denied/i.test(stderr);
    throw new Error(
      `${name} ${args.join(' ')} failed with exit ${result.status}${detail ? `: ${detail}` : ''}.` +
        (permission ? ` ${permissionHint}` : ''),
    );
  }
}

function applyRows(state: State, rows: HostRow[]) {
  console.log(`Kitto ${state.version} host CLIs (apply: pinned versions only).`);
  console.log(policy);
  const managed = rows.filter(isManaged);
  for (const row of rows.filter((row) => row.appManaged)) {
    console.log(`  ${row.name}: app-managed by DeepSeek Harness Desktop; skipped (upgrade through the App).`);
  }
  const broken = managed.filter((row): row is ManagedRow & { status: 'unreadable' } => row.status === 'unreadable');
  if (broken.length) {
    throw new Error(
      `Cannot read the current version of ${broken.map((row) => `${row.name} (${row.detail})`).join(', ')}. ` +
        'Fix the CLI or reinstall it with its native manager first; nothing was changed.',
    );
  }
  const changes = managed.filter((row) => ['upgrade', 'install', 'pin'].includes(row.action));
  const unchanged = managed.filter((row) => !changes.includes(row));
  for (const row of unchanged) {
    console.log(`  ${row.name}: current ${currentLabel(row)}; ${actionLabel(row)}; no change.`);
    const warning = pinWarning(row);
    if (warning) console.log(warning);
  }
  if (!changes.length) {
    console.log(
      `Summary: updated none; unchanged ${unchanged.map((row) => row.name).join(', ') || 'none'}. ` +
        'Nothing to change: the selected host CLIs already satisfy the pinned targets. No writes.',
    );
    return;
  }
  if (!npmAvailable()) {
    throw new Error(
      'npm was not found on PATH. Host CLIs are upgraded only through the native npm global manager; ' +
        "install Node.js/npm or use the host's native manager. Nothing was changed.",
    );
  }
  const overridden = changes.filter((row) => row.target !== row.baseline);
  if (overridden.length) {
    console.log(
      `Explicit pin overrides the Kitto-validated baseline for ${overridden.map((row) => `${row.name} (${row.baseline} -> ${row.target})`).join(', ')}; only the baseline is validated.`,
    );
  }
  console.log('Installing pinned versions with the native npm global manager (no npx, no dist-tags):');
  const changed = [];
  const notChanged = [];
  let failure: { row: ManagedRow; error: unknown } | undefined;
  for (let index = 0; index < changes.length; index++) {
    const row = changes[index];
    console.log(`  ${row.name}: current ${currentLabel(row)} -> ${row.target}`);
    console.log(`      ${row.command.join(' ')}`);
    try {
      runCommand(row.command);
      const verified = probeHost(row.name);
      if (verified.status !== 'found' || verified.current !== row.target) {
        throw new Error(
          `npm finished, but the CLI reports ${
            verified.status === 'found' ? verified.current : verified.status === 'missing' ? 'not found' : `unreadable (${verified.detail})`
          } ` + `instead of ${row.target}. Check PATH and the npm global prefix; Kitto wrote no state.`,
        );
      }
      changed.push(row.name);
      console.log(`      verified ${row.name} ${verified.current}`);
    } catch (error) {
      failure = { row, error };
      notChanged.push(row.name, ...changes.slice(index + 1).map((other) => other.name));
      break;
    }
  }
  if (failure) {
    console.log(`Summary: updated ${changed.join(', ') || 'none'}; not updated ${notChanged.join(', ')}. Kitto wrote no state.`);
    throw new Error(`${failure.row.name}: ${(failure.error as Error).message}`);
  }
  console.log(
    `Summary: updated ${changed.join(', ')}; unchanged ${unchanged.map((row) => row.name).join(', ') || 'none'}. ` +
      'Restart each updated host to load the new CLI.',
  );
}

export async function hostsCommand(args: string[] = []): Promise<void> {
  const options = parseHostsArgs(args);
  const { state } = await readState();
  const rows = buildRows(state, options);
  if (options.apply) return applyRows(state, rows);
  return printCheck(state, rows);
}
