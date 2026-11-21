import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readScopeRegistry } from './scopes.mjs';
import { checkoutGitDir, cleanExit, commonDir, git, inspect, output, registrations } from './worktree-audit.mjs';

export const lifecycleUsage = `kitto worktree start --repo PATH --task ID --session ID [--confirm TOKEN]
kitto worktree finish --repo PATH --task ID --session ID --quiescent (--release | --delivered SHA)
kitto worktree apply --repo PATH --task ID --session ID --quiescent (--release | --delivered SHA) --confirm TOKEN`;
const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const hex = /^[0-9a-f]{64}$/;
const stringMatches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uid = process.getuid?.();

function requireFact(condition, message) {
  if (!condition) throw new Error(message);
}

function within(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function stat(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function nodeIdentity(path) {
  const node = await stat(path);
  requireFact(node?.isDirectory() && await realpath(path) === path, 'Directory identity is unknown.');
  return `${node.dev}:${node.ino}`;
}

async function privatePath(path, directory, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const node = await stat(path);
  if (!node) return false;
  requireFact((directory ? node.isDirectory() : node.isFile()) && node.uid === BigInt(uid) &&
    (node.mode & 0o077n) === 0n && await realpath(path) === path, 'Worktree state must be private and must not use path aliases.');
  return true;
}

async function underLock(root, run) {
  await privatePath(root, true, true);
  const lock = join(root, 'lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Worktree state is locked; wait for its writer or inspect a stale lock manually.');
    throw error;
  }
  try { return await run(); }
  finally { await rmdir(lock); }
}

async function load(file, key) {
  if (!await privatePath(file, false)) return null;
  const row = JSON.parse(await readFile(file, 'utf8'));
  requireFact(row?.version === 1 && row.key === key && typeof row.revision === 'string' &&
    ['creating', 'ready', 'removing', 'removed'].includes(row.phase) && Array.isArray(row.sessions) &&
    row.sessions.every(session => stringMatches(session, id)) && new Set(row.sessions).size === row.sessions.length &&
    (row.phase === 'creating' || (typeof row.identity === 'string' && hex.test(row.identity))), 'Invalid worktree ledger; refusing to proceed.');
  return row;
}

async function save(file, row) {
  const temporary = join(dirname(file), `${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(row) + '\n', { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function options(command, args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const key = flag.slice(2);
    requireFact(/^--(?:repo|task|session|confirm|quiescent|release|delivered)$/.test(flag) && !(key in result), lifecycleUsage);
    result[key] = ['quiescent', 'release'].includes(key) ? true : args[++i];
    requireFact(result[key] && (result[key] === true || !result[key].startsWith('--')), lifecycleUsage);
  }
  requireFact(result.repo && stringMatches(result.task, id) && stringMatches(result.session, id) &&
    (!result.confirm || stringMatches(result.confirm, hex)), lifecycleUsage);
  if (command === 'start') requireFact(!result.quiescent && !result.release && !result.delivered, lifecycleUsage);
  else requireFact(result.quiescent && (result.release ? !result.delivered : stringMatches(result.delivered, sha)) &&
    (command === 'apply' ? result.confirm : !result.confirm), lifecycleUsage);
  return result;
}

async function repository(args, root) {
  const repo = await realpath(resolve(args.repo));
  const registry = await readScopeRegistry();
  const scope = registry.workspaces.includes(repo) ? ['workspace', repo] :
    (registry.workspaceParents ?? []).includes(dirname(repo)) ? ['workspace-parent', dirname(repo)] : null;
  requireFact(scope, 'The primary checkout needs an explicit workspace or direct workspace-parent scope.');
  const common = await commonDir(repo);
  const entries = registrations(repo);
  const primary = entries[0];
  requireFact(primary?.worktree === repo && !primary.bare && !primary.detached && !primary.prunable &&
    !primary.locked && typeof primary.branch === 'string' && stringMatches(primary.HEAD, sha) &&
    entries.filter(entry => entry.worktree === repo).length === 1, 'Choose the canonical primary checkout with an attached local branch.');
  await checkoutGitDir(repo, common, true, false);
  requireFact(!within(repo, root) && !within(common, root), 'Worktree state must be outside the source checkout and Git directory.');
  const repoId = digest([hostname(), repo, await nodeIdentity(repo), common, await nodeIdentity(common)]);
  const key = digest([repoId, args.task]);
  const bucket = join(root, repoId);
  const path = join(bucket, key);
  const branch = `kitto/task-${key}`;
  return { repo, common, entries, primary, scope, key, bucket, path, branch, file: join(bucket, `${key}.json`) };
}

function ownRegistration(ctx) {
  return ctx.entries.filter(entry => entry.worktree === ctx.path || entry.branch === `refs/heads/${ctx.branch}`);
}

async function emptyDestination(ctx) {
  const refs = output(ctx.repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${ctx.branch}`);
  return !ownRegistration(ctx).length && !await stat(ctx.path) && !refs;
}

const ownershipMarker = 'kitto-owner';

async function binding(ctx, create = false) {
  const entries = ownRegistration(ctx);
  const [entry] = entries;
  requireFact(entries.length === 1 && entry.worktree === ctx.path && entry.branch === `refs/heads/${ctx.branch}` &&
    !entry.bare && !entry.detached && !entry.prunable && stringMatches(entry.HEAD, sha), 'Managed checkout registration is missing or has changed.');
  const gitDir = await checkoutGitDir(ctx.path, ctx.common, false, false);
  const nodes = [ctx.path, await nodeIdentity(ctx.path), gitDir, await nodeIdentity(gitDir)];
  const marker = join(gitDir, ownershipMarker);
  if (create) await writeFile(marker, digest(randomUUID()), { flag: 'wx', mode: 0o600 });
  requireFact(await privatePath(marker, false), 'Managed checkout ownership marker is missing.');
  const owner = await readFile(marker, 'utf8');
  requireFact(hex.test(owner), 'Invalid checkout ownership marker.');
  return { identity: digest([...nodes, owner]), entry, gitDir };
}

function currentRow(ctx, old, phase, fields = {}) {
  return { version: 1, key: ctx.key, revision: randomUUID(), identity: old?.identity ?? null,
    phase, sessions: old?.sessions ?? [], ...fields };
}

function plan(ctx, args, row, action, facts, blockers = []) {
  const info = { action, task: args.task, session: args.session, repo: ctx.repo, path: ctx.path,
    branch: ctx.branch, baseBranch: ctx.primary.branch, baseHead: ctx.primary.HEAD, scope: ctx.scope, ...facts, blockers };
  return { ...info, confirm: blockers.length ? null : digest([1, ctx.key, row?.revision ?? null, info]) };
}

function confirm(args, preview) {
  requireFact(preview.confirm && args.confirm === preview.confirm, 'Confirmation is missing, blocked, or stale; request a fresh preview.');
}

function noCheckoutFilters(path) {
  return cleanExit(git(path, 'config', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'), 1);
}

// Advisory only: no host event proves that a session claim can be released.
// Use only the current repository's private ledger; do not probe other checkouts
// or include their paths, task identifiers, or session identifiers in the hint.
async function handoffHints(ctx) {
  const result = { otherClaimed: 0, otherUnclaimed: 0, otherInterrupted: 0, incomplete: false };
  try {
    if (!await privatePath(ctx.bucket, true)) return result;
    for (const name of await readdir(ctx.bucket)) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const key = name.slice(0, -5);
      if (key === ctx.key) continue;
      try {
        const row = await load(join(ctx.bucket, name), key);
        if (!row) result.incomplete = true;
        else if (row.phase === 'ready') result[row.sessions.length ? 'otherClaimed' : 'otherUnclaimed']++;
        else if (row.phase !== 'removed') result.otherInterrupted++;
      } catch {
        result.incomplete = true;
      }
    }
  } catch {
    result.incomplete = true;
  }
  return result;
}

async function start(ctx, args, row) {
  let preview;
  if (row?.phase === 'ready') {
    const { identity, entry } = await binding(ctx);
    requireFact(row.identity === identity && !entry.locked, 'Managed checkout identity has changed or Git has locked it.');
    preview = plan(ctx, args, row, 'reuse', { head: entry.HEAD, sessions: row.sessions });
  } else {
    requireFact(!row || row.phase === 'creating', 'This task is being removed or has already been retired; use a new task ID.');
    requireFact(await emptyDestination(ctx), 'Destination or branch already exists; Kitto does not adopt existing worktrees.');
    requireFact(noCheckoutFilters(ctx.repo), 'Configured or unknown Git filters prevent unattended checkout.');
    preview = plan(ctx, args, row, 'create', { sessions: [] });
  }
  if (!args.confirm) return { ...preview, handoffHints: await handoffHints(ctx) };
  confirm(args, preview);
  const sessions = [...new Set([...preview.sessions, args.session])].sort();
  if (preview.action === 'create') {
    await privatePath(ctx.bucket, true, true);
    await save(ctx.file, currentRow(ctx, row, 'creating'));
    // A clean result is required, but worktree add writes progress to stderr even on success.
    const result = git(ctx.repo, 'worktree', 'add', '--quiet', '--no-checkout', '-b', ctx.branch, '--', ctx.path, ctx.primary.HEAD);
    requireFact(cleanExit(result), 'Git could not create the worktree safely. Creation intent retained; inspect artifacts manually.');
    ctx.entries = registrations(ctx.repo);
    const { identity, entry } = await binding(ctx, true);
    requireFact(entry.HEAD === ctx.primary.HEAD && !entry.locked, 'Created checkout differs from the approved plan.');
    // Conditional config may select filters only for the linked checkout.
    requireFact(noCheckoutFilters(ctx.path), 'Configured or unknown filters in the new checkout; creation intent retained.');
    requireFact(cleanExit(git(ctx.path, 'read-tree', entry.HEAD)) && cleanExit(git(ctx.path, 'checkout-index', '--all')),
      'Git could not populate the new checkout safely. Creation intent retained; inspect artifacts manually.');
    await save(ctx.file, currentRow(ctx, row, 'ready', { identity, sessions }));
  } else {
    await save(ctx.file, currentRow(ctx, row, 'ready', { sessions }));
  }
  return { ...preview, confirm: null, sessions, applied: true };
}

const conversionAttrs = new Set(['filter', 'working-tree-encoding', 'text', 'eol', 'crlf', 'ident']);

function verifyConversionPolicy(path, names) {
  requireFact(noCheckoutFilters(path), 'Configured or unknown checkout filters.');
  const autocrlf = git(path, 'config', '--type=bool', '--get', 'core.autocrlf');
  requireFact(cleanExit(autocrlf, 1) || (cleanExit(autocrlf) && autocrlf.stdout.toString() === 'false\n'),
    'Configured or unknown line-ending conversion.');
  let batch = [], bytes = 0;
  function checkBatch() {
    const fields = output(path, 'check-attr', '--all', '-z', '--', ...batch).split('\0');
    requireFact(fields.pop() === '' && fields.length % 3 === 0, 'Invalid Git attribute output.');
    for (let i = 1; i < fields.length; i += 3) {
      requireFact(!conversionAttrs.has(fields[i]), 'Checkout conversion attributes are not supported for removal.');
    }
  }
  for (const name of names) {
    const size = Buffer.byteLength(name) + 1;
    if (batch.length && bytes + size > 32768) {
      checkBatch();
      batch = [];
      bytes = 0;
    }
    batch.push(name);
    bytes += size;
  }
  if (batch.length) checkBatch();
}

const observation = node => [node.dev, node.ino, node.mode, node.size, node.mtimeNs, node.ctimeNs].map(String);
function sameObservation(left, right) {
  if (!right) return false;
  const values = observation(right);
  return observation(left).every((value, i) => value === values[i]);
}

async function rawBlobId(path, node, algorithm) {
  const blob = createHash(algorithm);
  if (node.isSymbolicLink()) {
    const target = await readlink(path, { encoding: 'buffer' });
    blob.update(`blob ${target.length}\0`).update(target);
  } else {
    requireFact(constants.O_NOFOLLOW && constants.O_NONBLOCK, 'Safe regular file access is unavailable.');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      requireFact(sameObservation(node, await file.stat({ bigint: true })), 'Checkout file changed before reading.');
      blob.update(`blob ${node.size}\0`);
      let size = 0n;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        size += BigInt(chunk.length);
        requireFact(size <= node.size, 'Checkout file grew during reading.');
        blob.update(chunk);
      }
      requireFact(size === node.size && sameObservation(node, await file.stat({ bigint: true })), 'Checkout file changed during reading.');
    } finally { await file.close(); }
  }
  requireFact(sameObservation(node, await stat(path)), 'Checkout entry changed during reading.');
  return blob.digest('hex');
}

// Verify the disk against the index and the committed tree independently of Git's
// stat cache. Only raw byte equality is accepted; no clean/smudge conversion runs.
async function checkoutSnapshot(ctx, head) {
  if (process.platform === 'linux') {
    // Device numbers alone do not detect same-device bind mounts.
    const mounts = await readFile('/proc/self/mountinfo', 'utf8');
    for (const line of mounts.trimEnd().split('\n')) {
      const encoded = line.split(' ')[4];
      requireFact(encoded, 'Mount table is unreadable.');
      const mount = encoded.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
      requireFact(!within(ctx.path, mount), 'Mounted checkout entry.');
    }
  }
  const algorithm = output(ctx.path, 'rev-parse', '--show-object-format');
  requireFact(['sha1', 'sha256'].includes(algorithm), 'Unknown Git object format.');
  const indexed = new Map(), directories = new Set();
  for (const record of output(ctx.path, 'ls-files', '--stage', '-z').split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000) ([0-9a-f]+) 0\t([\s\S]+)$/.exec(record);
    requireFact(match && match[2].length === (algorithm === 'sha1' ? 40 : 64), 'Unsupported index entry.');
    const [, mode, oid, name] = match;
    const parts = name.split('/');
    requireFact(!indexed.has(name) && parts.every(part => part && !['.', '..', '.git'].includes(part)), 'Unknown tracked path.');
    indexed.set(name, { mode, oid });
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const committed = new Set();
  for (const record of output(ctx.path, 'ls-tree', '-r', '-z', '--full-tree', head).split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    requireFact(match, 'Unsupported committed tree entry.');
    const [, mode, oid, name] = match;
    const indexEntry = indexed.get(name);
    requireFact(indexEntry?.mode === mode && indexEntry.oid === oid && !committed.has(name), 'Index differs from the committed tree.');
    committed.add(name);
  }
  requireFact(committed.size === indexed.size, 'Some indexed paths are not committed.');
  verifyConversionPolicy(ctx.path, indexed.keys());
  const root = await stat(ctx.path);
  const hash = createHash('sha256');
  function record(name, node) {
    hash.update(JSON.stringify([name, ...observation(node)]));
  }
  async function walk(path, parent) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), rel = parent ? `${parent}/${name}` : name;
      const node = await stat(child);
      requireFact(node && node.dev === root.dev, 'Unknown checkout entry or filesystem boundary.');
      record(rel, node);
      if (rel === '.git') requireFact(node.isFile(), 'Unknown Git file.');
      else if (node.isDirectory()) {
        requireFact(directories.has(rel), 'Untracked directory.');
        directories.delete(rel);
        await walk(child, rel);
      } else {
        const entry = indexed.get(rel);
        const executable = (node.mode & 0o100n) !== 0n;
        requireFact(entry && (entry.mode === '120000' ? node.isSymbolicLink() : node.isFile() && executable === (entry.mode === '100755')),
          'Untracked, changed, or unsupported filesystem entry.');
        const oid = await rawBlobId(child, node, algorithm);
        requireFact(oid === entry.oid, 'Checkout content differs from its committed blob.');
        hash.update(oid);
        indexed.delete(rel);
      }
    }
  }
  requireFact(root?.isDirectory(), 'Unknown checkout root.');
  record('', root);
  await walk(ctx.path, '');
  requireFact(!indexed.size && !directories.size, 'Some indexed paths are unavailable.');
  return hash.digest('hex');
}

async function finish(ctx, args, row) {
  requireFact(row && ['ready', 'removing'].includes(row.phase), 'No owned, active worktree for this task.');
  requireFact(row.sessions.includes(args.session), 'This session has no claim on the task.');
  let preview;
  if (args.release) {
    requireFact(row.phase === 'ready', 'Interrupted removal must be reviewed before releasing the session.');
    preview = plan(ctx, args, row, 'release', { sessions: row.sessions });
  } else {
    const blockers = [];
    if (row.sessions.length !== 1) blockers.push('other-sessions-active');
    if (args.delivered !== ctx.primary.HEAD) blockers.push('delivery-head-mismatch');
    if (within(ctx.path, await realpath(process.cwd()))) blockers.push('caller-in-target');
    const entries = ownRegistration(ctx);
    if (row.phase === 'removing' && !entries.length && !await stat(ctx.path)) {
      const head = output(ctx.repo, 'rev-parse', '--verify', `refs/heads/${ctx.branch}`);
      requireFact(head === row.removalHead, 'Interrupted removal no longer matches the retained branch.');
      preview = plan(ctx, args, row, 'record-removed', { delivered: args.delivered, head, sessions: row.sessions }, blockers);
    } else {
      const { identity, entry, gitDir } = await binding(ctx);
      requireFact(identity === row.identity, 'Managed checkout identity has changed.');
      const audit = await inspect(ctx.repo, ctx.common, entry, false, ctx.primary.HEAD, true);
      for (const blocker of audit.blockers) {
        if (!['unmanaged', 'occupancy-unknown'].includes(blocker)) blockers.push(blocker);
      }
      if (!audit.changes && !blockers.includes('changes-unknown')) blockers.push('changes-unknown');
      for (const lock of ['index.lock', 'HEAD.lock', 'config.worktree.lock']) {
        if (await stat(join(gitDir, lock))) blockers.push('git-write-in-progress');
      }
      if (await stat(join(ctx.common, 'info/grafts')) || output(ctx.repo, 'for-each-ref', '--format=%(refname)', 'refs/replace/')) {
        blockers.push('modified-ancestry');
      }
      let snapshot = null;
      if (!blockers.length) {
        try { snapshot = await checkoutSnapshot(ctx, entry.HEAD); }
        catch { blockers.push('filesystem-unverified'); }
      }
      preview = plan(ctx, args, row, 'remove', { delivered: args.delivered, head: entry.HEAD,
        sessions: row.sessions, snapshot }, [...new Set(blockers)]);
    }
  }
  if (!args.confirm) return preview;
  confirm(args, preview);
  if (preview.action === 'release') {
    await save(ctx.file, currentRow(ctx, row, 'ready', { sessions: row.sessions.filter(session => session !== args.session) }));
  } else {
    if (preview.action === 'remove') {
      await save(ctx.file, currentRow(ctx, row, 'removing', { removalHead: preview.head }));
      const result = git(ctx.repo, 'worktree', 'remove', '--', ctx.path);
      requireFact(cleanExit(result), 'Git declined or could not verify removal. Inspect the interrupted operation before retrying.');
      ctx.entries = registrations(ctx.repo);
      requireFact(!ownRegistration(ctx).length && !await stat(ctx.path) &&
        output(ctx.repo, 'rev-parse', '--verify', `refs/heads/${ctx.branch}`) === preview.head,
      'Git removal could not be verified; removal intent retained.');
    }
    await save(ctx.file, currentRow(ctx, row, 'removed', { sessions: [] }));
  }
  return { ...preview, confirm: null, applied: true };
}

export async function lifecycleCommand(command, argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return console.log(lifecycleUsage);
  const args = options(command, argv);
  requireFact(uid !== undefined, 'The worktree lifecycle requires a POSIX user.');
  const state = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  requireFact(isAbsolute(state), 'XDG_STATE_HOME must be an absolute device-local path.');
  const root = resolve(state, 'kitto-worktrees');
  const modifying = command === 'apply' || !!args.confirm;
  const run = async () => {
    const ctx = await repository(args, root);
    await privatePath(root, true);
    await privatePath(ctx.bucket, true);
    const row = await load(ctx.file, ctx.key);
    return command === 'start' ? start(ctx, args, row) : finish(ctx, args, row);
  };
  // Validate scope before any state changes, and re-resolve it under the lock.
  if (modifying) await repository(args, root);
  const result = modifying ? await underLock(root, run) : await run();
  console.log(JSON.stringify(result, null, 2));
}
