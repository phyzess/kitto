import { spawnSync } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const usage = 'kitto worktree audit [--workspace PATH] [--json]';
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Do not inherit repository selection, trace destinations or injected Git config.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
Object.assign(env, { LC_ALL: 'C', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_TRACE2: '0', GIT_TRACE2_PERF: '0', GIT_TRACE2_EVENT: '0' });
if (process.env.GIT_CONFIG_NOSYSTEM === '1') env.GIT_CONFIG_NOSYSTEM = '1';

function git(cwd, ...args) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-C', cwd, ...args],
  { env, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

function output(path, ...args) {
  const result = git(path, ...args);
  if (result.status !== 0) throw new Error(`Cannot read Git ${args[0]} at ${JSON.stringify(path)}.`);
  return text.decode(result.stdout).replace(/\n$/, ''); // Preserve whitespace in paths.
}

async function commonDir(path) {
  return realpath(output(path, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
}

function registrations(repo) {
  return output(repo, 'worktree', 'list', '--porcelain', '-z').split('\0\0').filter(Boolean).map(record =>
    Object.fromEntries(record.split('\0').map(line => {
      const i = line.indexOf(' ');
      return i < 0 ? [line, true] : [line.slice(0, i), line.slice(i + 1)];
    })));
}

function diskBytes(path) {
  // Both BSD and GNU du support -k, -s and -x. Ignore partial totals on error.
  const result = spawnSync('du', ['-skx', path], { env, timeout: 60000 });
  if (result.status !== 0) return null;
  const match = /^(\d+)\t/.exec(result.stdout.toString());
  const bytes = match ? Number(match[1]) * 1024 : NaN;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function changes(path) {
  // A configured clean/process filter can run arbitrary programs during status.
  // Don't invoke it, even indirectly through nested submodule status.
  if (git(path, 'config', '--get-regexp', '^filter\\..*\\.(clean|process)$').status !== 1) return null;
  const result = git(path, 'status', '--porcelain=v1', '-z', '--no-renames', '--ignored=matching',
    '--untracked-files=normal', '--ignore-submodules=all');
  if (result.status !== 0) return null;
  const lines = result.stdout.toString('latin1').split('\0').filter(Boolean);
  return { tracked: lines.some(line => !['!!', '??'].includes(line.slice(0, 2))),
    untracked: lines.some(line => line.startsWith('??')), ignored: lines.some(line => line.startsWith('!!')) };
}

async function inspect(repo, common, entry, primary, base) {
  const path = entry.worktree;
  const row = { path, commonDir: common, gitDir: null, primary, bare: !!entry.bare,
    branch: entry.branch ?? null, head: entry.HEAD ?? null, detached: !!entry.detached,
    locked: !!entry.locked, prunable: !!entry.prunable, estimatedBytes: null,
    changes: null, upstream: null, localBaseHead: base, mergedIntoLocalBase: null,
    ownership: 'unmanaged', occupancy: 'unknown', blockers: ['unmanaged', 'occupancy-unknown'] };
  for (const fact of ['primary', 'bare', 'detached', 'locked', 'prunable']) if (row[fact]) row.blockers.push(fact);
  try {
    if (await realpath(path) !== path || await commonDir(path) !== common ||
        (!entry.bare && output(path, 'rev-parse', '--show-toplevel') !== path)) throw new Error('Worktree mismatch');
    row.gitDir = await realpath(output(path, 'rev-parse', '--absolute-git-dir'));
  } catch {
    row.blockers.push('identity-unknown');
    return row;
  }
  row.estimatedBytes = diskBytes(path);
  if (row.estimatedBytes === null) row.blockers.push('size-unknown');
  if (row.bare) return row;
  if (row.branch) {
    row.upstream = output(repo, 'for-each-ref', '--format=%(upstream)', row.branch) || null;
  }
  if (base && row.head) {
    const { status } = git(repo, 'merge-base', '--is-ancestor', row.head, base);
    if (status === 0 || status === 1) row.mergedIntoLocalBase = status === 0;
  }
  if (row.mergedIntoLocalBase !== true) row.blockers.push(row.mergedIntoLocalBase === false ? 'not-in-local-base' : 'ancestry-unknown');
  // Even --no-optional-locks does not stop Git freshening sharedindex.* mtimes.
  // Without reading the index, conservatively skip probes if shared indexes exist.
  const metadata = await readdir(row.gitDir).catch(() => null);
  if (!metadata || metadata.some(name => name.startsWith('sharedindex.'))) {
    row.blockers.push('index-probe-skipped', 'changes-unknown');
    return row;
  }
  row.changes = changes(path);
  if (!row.changes) row.blockers.push('changes-unknown');
  else for (const [key, present] of Object.entries(row.changes)) if (present) row.blockers.push(key);
  const files = git(path, 'ls-files', '-v', '--stage', '-z');
  if (files.status !== 0) row.blockers.push('index-flags-unknown');
  else {
    const records = files.stdout.toString('latin1').split('\0');
    if (records.some(record => /^[a-zS] /.test(record))) row.blockers.push('masked-index-entries');
    if (records.some(record => /^. 160000 /.test(record))) row.blockers.push('submodules-unknown');
  }
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_START', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    try { await lstat(join(row.gitDir, marker)); row.blockers.push(`git-operation:${marker}`); }
    catch (error) { if (error.code !== 'ENOENT') row.blockers.push('git-operation-unknown'); }
  }
  return row;
}

async function candidates(workspace) {
  if (!workspace) return [process.cwd()];
  const root = await realpath(workspace);
  const dirs = await readdir(root, { withFileTypes: true });
  if (dirs.some(entry => entry.name === '.git')) return [root];
  const repos = [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try { await lstat(join(dir, '.git')); repos.push(dir); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return repos;
}

/** Inventory local Git registrations without creating state or inferring ownership. */
export async function auditWorktrees(workspace) {
  const rows = [], seen = new Set();
  for (const repo of await candidates(workspace)) {
    const common = await commonDir(repo);
    if (seen.has(common)) continue;
    seen.add(common);
    const entries = registrations(repo);
    const base = entries[0]?.HEAD ?? null;
    for (const [index, entry] of entries.entries()) rows.push(await inspect(repo, common, entry, index === 0, base));
  }
  return rows.sort((a, b) => (b.estimatedBytes ?? -1) - (a.estimatedBytes ?? -1) || a.path.localeCompare(b.path));
}

export async function worktreeCommand([command, ...args]) {
  if (!command || ['--help', '-h'].includes(command) || (command === 'audit' && args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    console.log(usage); return;
  }
  if (command !== 'audit') throw new Error(`Usage: ${usage}`);
  let workspace, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--workspace' && !workspace && args[i + 1] && !args[i + 1].startsWith('-')) workspace = resolve(args[++i]);
    else throw new Error(`Usage: ${usage}`);
  }
  const rows = await auditWorktrees(workspace);
  if (json) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log('Estimated bytes | Worktree | Branch / HEAD | Blockers (not a removal decision)');
    for (const row of rows) console.log(`${row.estimatedBytes ?? 'unknown'} | ${JSON.stringify(row.path)} | ${JSON.stringify(row.branch ?? row.head)} | ${row.blockers.join(', ')}`);
  }
}
