import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface WorktreeRegistration {
  worktree: string;
  HEAD?: string;
  branch?: string;
  bare?: boolean | string;
  detached?: boolean | string;
  locked?: boolean | string;
  prunable?: boolean | string;
}

export interface WorktreeRow {
  path: string;
  commonDir: string;
  gitDir: string | null;
  primary: boolean;
  bare: boolean;
  branch: string | null;
  head: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  estimatedBytes: number | null;
  changes: { tracked: boolean; untracked: boolean; ignored: boolean } | null;
  upstream: string | null;
  localBaseHead: string | null | undefined;
  mergedIntoLocalBase: boolean | null;
  ownership: string;
  occupancy: string;
  blockers: string[];
  [fact: string]: unknown;
}

const usage = 'kitto worktree audit [--workspace PATH] [--json]';
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
Object.assign(env, {
  LC_ALL: 'C',
  GIT_ALLOW_PROTOCOL: '',
  GIT_NO_LAZY_FETCH: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_TRACE2: '0',
  GIT_TRACE2_PERF: '0',
  GIT_TRACE2_EVENT: '0',
});
if (process.env.GIT_CONFIG_NOSYSTEM === '1') env.GIT_CONFIG_NOSYSTEM = '1';

const READ_ONLY_GIT = new Set([
  'cat-file',
  'describe',
  'diff',
  'for-each-ref',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  'rev-list',
  'rev-parse',
  'show',
  'show-ref',
  'status',
]);

const mutatesLayout = (args: string[]): boolean => {
  const [command, sub] = args;
  if (!command) return true;
  if (command === 'worktree') return sub !== 'list';
  if (command === 'config') return args.length > 2 && !args.some((arg) => arg.startsWith('--get') || arg === '--list');
  if (command === 'symbolic-ref') return args.length > 2;
  return !READ_ONLY_GIT.has(command);
};

const revParseCache = new Map<string, string>();
let registrationCache: { repo: string; entries: WorktreeRegistration[] } | undefined;

export function clearGitIdentityCache(): void {
  revParseCache.clear();
  registrationCache = undefined;
}

function revParse(path: string, ...args: string[]): string {
  const key = `${path}\0${args.join('\0')}`;
  const cached = revParseCache.get(key);
  if (cached !== undefined) return cached;
  const value = output(path, 'rev-parse', ...args);
  revParseCache.set(key, value);
  return value;
}

export function git(cwd: string, ...args: string[]): SpawnSyncReturns<Buffer> {
  if (mutatesLayout(args)) clearGitIdentityCache();
  return spawnSync(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-C', cwd, ...args],
    { env, timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
  );
}

export function cleanExit(result: SpawnSyncReturns<Buffer>, status = 0): boolean {
  return !result.error && result.status === status && result.stderr?.length === 0;
}

export function output(path: string, ...args: string[]): string {
  const result = git(path, ...args);
  if (result.error) throw result.error;
  if (!cleanExit(result)) throw new Error(`Cannot read Git ${args[0]} at ${JSON.stringify(path)}.`);
  return text.decode(result.stdout).replace(/\n$/, '');
}

export async function commonDir(path: string): Promise<string> {
  return realpath(revParse(path, '--path-format=absolute', '--git-common-dir'));
}

export function registrations(repo: string): WorktreeRegistration[] {
  const cached = registrationCache?.repo === repo ? registrationCache.entries : undefined;
  if (cached) return cached.map((entry) => ({ ...entry }));
  const entries = parseRegistrations(repo);
  registrationCache = { repo, entries };
  return entries.map((entry) => ({ ...entry }));
}

function parseRegistrations(repo: string): WorktreeRegistration[] {
  return output(repo, 'worktree', 'list', '--porcelain', '-z')
    .split('\0\0')
    .filter(Boolean)
    .map(
      (record): WorktreeRegistration =>
        Object.fromEntries(
          record.split('\0').map((line): [string, string | true] => {
            const i = line.indexOf(' ');
            return i < 0 ? [line, true] : [line.slice(0, i), line.slice(i + 1)];
          }),
        ) as unknown as WorktreeRegistration,
    );
}

function diskBytes(path: string): number | null {
  const result = spawnSync('du', ['-skx', path], { env, timeout: 60000 });
  if (!cleanExit(result)) return null;
  const match = /^(\d+)\t/.exec(result.stdout.toString());
  const bytes = match ? Number(match[1]) * 1024 : NaN;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function changes(path: string): WorktreeRow['changes'] {
  if (!cleanExit(git(path, 'config', '--get-regexp', '^filter\\..*\\.(clean|process)$'), 1)) return null;
  const result = git(
    path,
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    '--ignored=matching',
    '--untracked-files=normal',
    '--ignore-submodules=all',
  );
  if (!cleanExit(result)) return null;
  const lines = result.stdout.toString('latin1').split('\0').filter(Boolean);
  return {
    tracked: lines.some((line) => !['!!', '??'].includes(line.slice(0, 2))),
    untracked: lines.some((line) => line.startsWith('??')),
    ignored: lines.some((line) => line.startsWith('!!')),
  };
}

export async function checkoutGitDir(path: string, common: string, primary: boolean, bare: boolean): Promise<string> {
  const gitDir = await realpath(revParse(path, '--absolute-git-dir'));
  if ((await commonDir(path)) !== common || (!bare && revParse(path, '--show-toplevel') !== path)) {
    throw new Error('Worktree checkout mismatch');
  }
  if (primary) {
    if (gitDir !== common) throw new Error('Primary Git directory mismatch');
  } else {
    const marker = join(path, '.git');
    if (dirname(gitDir) !== join(common, 'worktrees') || (await realpath(revParse(path, '--resolve-git-dir', marker))) !== gitDir) {
      throw new Error('Linked Git directory mismatch');
    }
    const reverse = join(gitDir, 'gitdir');
    if (!(await lstat(reverse)).isFile()) throw new Error('Invalid worktree backlink');
    const backlink = text.decode(await readFile(reverse)).replace(/\n$/, '');
    if (!backlink || resolve(gitDir, backlink) !== marker) throw new Error('Worktree backlink mismatch');
  }
  return gitDir;
}

export async function inspect(
  repo: string,
  common: string,
  entry: WorktreeRegistration,
  primary: boolean,
  base: string | null | undefined,
  unique: boolean,
): Promise<WorktreeRow> {
  const path = entry.worktree;
  const row: WorktreeRow = {
    path,
    commonDir: common,
    gitDir: null,
    primary,
    bare: !!entry.bare,
    branch: entry.branch ?? null,
    head: entry.HEAD ?? null,
    detached: !!entry.detached,
    locked: !!entry.locked,
    prunable: !!entry.prunable,
    estimatedBytes: null,
    changes: null,
    upstream: null,
    localBaseHead: base,
    mergedIntoLocalBase: null,
    ownership: 'unmanaged',
    occupancy: 'unknown',
    blockers: ['unmanaged', 'occupancy-unknown'],
  };
  for (const fact of ['primary', 'bare', 'detached', 'locked', 'prunable']) if (row[fact]) row.blockers.push(fact);
  try {
    if (!unique || (await realpath(path)) !== path) throw new Error('Worktree registration mismatch');
    row.gitDir = await checkoutGitDir(path, common, primary, row.bare);
  } catch {
    row.blockers.push('identity-unknown');
    return row;
  }
  row.estimatedBytes = diskBytes(path);
  if (row.estimatedBytes === null) row.blockers.push('size-unknown');
  if (row.bare) return row;
  if (row.branch) {
    try {
      row.upstream = output(repo, 'for-each-ref', '--format=%(upstream)', row.branch) || null;
    } catch {
      row.blockers.push('upstream-unknown');
    }
  }
  if (base && row.head) {
    const result = git(repo, 'merge-base', '--is-ancestor', row.head, base);
    if (cleanExit(result)) row.mergedIntoLocalBase = true;
    else if (cleanExit(result, 1)) row.mergedIntoLocalBase = false;
  }
  if (row.mergedIntoLocalBase !== true) row.blockers.push(row.mergedIntoLocalBase === false ? 'not-in-local-base' : 'ancestry-unknown');
  const metadata = await readdir(row.gitDir).catch((): null => null);
  if (!metadata || metadata.some((name) => name.startsWith('sharedindex.'))) {
    row.blockers.push('index-probe-skipped', 'changes-unknown');
    return row;
  }
  row.changes = changes(path);
  if (!row.changes) row.blockers.push('changes-unknown');
  else for (const [key, present] of Object.entries(row.changes)) if (present) row.blockers.push(key);
  const files = git(path, 'ls-files', '-v', '--stage', '-z');
  if (!cleanExit(files)) row.blockers.push('index-flags-unknown');
  else {
    const records = files.stdout.toString('latin1').split('\0');
    if (records.some((record) => /^[a-zS] /.test(record))) row.blockers.push('masked-index-entries');
    if (records.some((record) => /^. 160000 /.test(record))) row.blockers.push('submodules-unknown');
  }
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_START', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    try {
      await lstat(join(row.gitDir, marker));
      row.blockers.push(`git-operation:${marker}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') row.blockers.push('git-operation-unknown');
    }
  }
  return row;
}

async function candidates(workspace: string | undefined): Promise<string[]> {
  if (!workspace) return [process.cwd()];
  const root = await realpath(workspace);
  const dirs = await readdir(root, { withFileTypes: true });
  if (dirs.some((entry) => entry.name === '.git')) return [root];
  const repos: string[] = [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      await lstat(join(dir, '.git'));
      repos.push(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return repos;
}

export async function auditWorktrees(workspace?: string): Promise<WorktreeRow[]> {
  clearGitIdentityCache();
  const rows: WorktreeRow[] = [],
    seen = new Set<string>();
  for (const repo of await candidates(workspace)) {
    const common = await commonDir(repo);
    if (seen.has(common)) continue;
    seen.add(common);
    const entries = registrations(repo);
    const base = entries[0]?.HEAD ?? null;
    const counts = new Map<string, number>();
    for (const { worktree } of entries) counts.set(worktree, (counts.get(worktree) ?? 0) + 1);
    for (const [index, entry] of entries.entries()) {
      rows.push(await inspect(repo, common, entry, index === 0, base, counts.get(entry.worktree) === 1));
    }
  }
  return rows.sort((a, b) => (b.estimatedBytes ?? -1) - (a.estimatedBytes ?? -1) || a.path.localeCompare(b.path));
}

export async function worktreeCommand([command, ...args]: string[]): Promise<void> {
  clearGitIdentityCache();
  if (!command || ['--help', '-h'].includes(command) || (command === 'audit' && args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    console.log(usage);
    return;
  }
  if (command !== 'audit') throw new Error(`Usage: ${usage}`);
  let workspace: string | undefined,
    json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--workspace' && !workspace && args[i + 1] && !args[i + 1].startsWith('-')) workspace = resolve(args[++i]);
    else throw new Error(`Usage: ${usage}`);
  }
  const rows = await auditWorktrees(workspace);
  if (json) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log('Estimated bytes | Worktree | Branch / HEAD | Blockers (not a removal decision)');
    for (const row of rows)
      console.log(
        `${row.estimatedBytes ?? 'unknown'} | ${JSON.stringify(row.path)} | ${JSON.stringify(row.branch ?? row.head)} | ${row.blockers.join(', ')}`,
      );
  }
}
