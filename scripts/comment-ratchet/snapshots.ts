import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { command, decode, formatFor, inspect } from '../comment-ratchet.ts';

type Inspection = ReturnType<typeof inspect>;
type Token = Inspection['tokens'][number];

interface Entry {
  path: string;
  mode?: string;
  id?: string;
}

interface InventoryFile extends Inspection {
  blob: string;
  mode: string | undefined;
  exclusion?: string;
}

interface Snapshot {
  snapshot: string;
  files: Inspection[];
}

interface Inventory extends Snapshot {
  totals: {
    files: number;
    physicalLines: number;
    tokens: number;
    commentOnlyLines: number;
    ordinaryCommentOnlyLines: number;
  };
  files: InventoryFile[];
}

interface PathToken extends Token {
  path: string;
}

const protectedPaths = new Map([
  ['config/pi/extensions/herdr-agent-state.ts', '276c964daf6a61f593ab3a8d3f7c1e0ed626d1b1'],
  ['skills/benchmark-checklist/LICENSE', '6b5400237fdf6545be0b8fae370d6f2fcff8fb25'],
  ['skills/benchmark-checklist/SKILL.md', '88546fa684c003625a13d61b975ced97b8fcb90e'],
  ['skills/writing-for-agents/LICENSE', 'f1dd2c09108dde1a5f56097cee8461b3ea834499'],
  ['skills/writing-for-agents/SKILL-MECHANICS.md', '9cdbdb22aadc438755392216e75ad9a14cc9832e'],
  ['skills/writing-for-agents/SKILL.md', 'a37608daf6e835e767deecfb498facecaaba82ba'],
  ['skills/writing-for-agents/agents/openai.yaml', '079c933b75743dec18b5d0c01006def20b6aad26'],
]);
const statePath = /^\.agent-teams\//u;
const vendoredPath = /^skills\/(?:benchmark-checklist|writing-for-agents)(?:\/|$)/u;
const sha = /^[0-9a-f]{40}$/u;
const renameSimilarity = '50%';

export function repository(cwd: string, bin: string) {
  const git = (args: string[], at = cwd) => command('git', ['--no-replace-objects', ...args], { cwd: at });
  const root = realpathSync(decode(git(['rev-parse', '--show-toplevel'])).replace(/\n$/u, ''));
  const run = (...args: string[]) => git(args, root);
  const list = (...args: string[]) =>
    decode(run(...args))
      .split('\0')
      .filter(Boolean);
  const cache = new Map<string, Inspection>();
  function resolveCommit(value: string) {
    if (sha.test(value) && !/^0+$/u.test(value)) {
      try {
        if (decode(run('rev-parse', '--verify', `${value}^{commit}`)).trim() === value) return value;
      } catch (error) {
        throw new Error(`Expected an available commit SHA: ${value}`, { cause: error });
      }
    }
    throw new Error(`Expected a full, available commit SHA: ${value}`);
  }
  function verifyRange(base: string, head: string, prHead?: string) {
    resolveCommit(base);
    resolveCommit(head);
    if (prHead) {
      resolveCommit(prHead);
      const ancestry = decode(run('rev-list', '--parents', '-n', '1', head)).trim();
      if (ancestry !== `${head} ${base} ${prHead}`)
        throw new Error('PR merge commit does not have the event base and head as its two parents');
    } else {
      try {
        run('merge-base', '--is-ancestor', base, head);
      } catch (error) {
        throw new Error('Push predecessor is not an available ancestor of the checked commit', { cause: error });
      }
    }
  }
  function entries(snapshot: string) {
    const staged = snapshot === 'index' || snapshot === 'worktree';
    const raw = staged ? list('ls-files', '--stage', '-z') : list('ls-tree', '-r', '-z', resolveCommit(snapshot));
    const files: Entry[] = raw.map((item) => {
      const i = item.indexOf('\t');
      const path = item.slice(i + 1);
      const fields = item.slice(0, i).split(' ');
      if (i < 0 || fields.length !== 3 || (staged && fields[2] !== '0'))
        throw new Error(`Invalid snapshot entry or unresolved merge: ${path}`);
      return { path, mode: fields[0], id: fields[staged ? 1 : 2] };
    });
    if (snapshot === 'worktree') {
      for (const path of list('ls-files', '--others', '--exclude-standard', '-z')) {
        if (!statePath.test(path)) files.push({ path });
      }
    }
    return files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  }
  function read(entry: Entry, snapshot: string) {
    if (entry.mode && !['100644', '100755'].includes(entry.mode)) throw new Error('Only regular files are supported');
    if (snapshot !== 'worktree') return { data: run('cat-file', 'blob', entry.id!), mode: entry.mode };
    const path = resolve(root, entry.path);
    const stat = lstatSafe(path);
    if (!stat) return null;
    if (!stat.isFile() || realpathSync(path) !== path) throw new Error('Only regular files directly inside the worktree are supported');
    return { data: readFileSync(path), mode: stat.mode & 0o100 ? '100755' : '100644' };
  }
  function inventory(snapshot: string, { protect = true } = {}): Inventory {
    const files: InventoryFile[] = [];
    const seen = new Set();
    for (const entry of entries(snapshot)) {
      const { path } = entry;
      try {
        if (seen.has(path) || statePath.test(path)) throw new Error('Duplicate path or tracked harness state');
        seen.add(path);
        const current = read(entry, snapshot);
        if (!current) continue;
        const { data, mode } = current;
        const blob = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
        const protectedPath = protectedPaths.has(path) || vendoredPath.test(path);
        if (protectedPath && protect && (protectedPaths.get(path) !== blob || mode !== '100644')) {
          throw new Error('Protected third-party path changed');
        }
        const language = protectedPath ? 'Excluded' : formatFor(path);
        const identity = JSON.stringify([path, mode, blob]);
        if (!cache.has(identity)) cache.set(identity, inspect(bin, path, language, data));
        files.push({ ...cache.get(identity)!, blob, mode, ...(protectedPath ? { exclusion: 'protected third-party' } : {}) });
      } catch (error) {
        throw new Error(`${snapshot} ${path}: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (protect) {
      for (const path of protectedPaths.keys()) {
        if (!files.some((file) => file.path === path)) throw new Error(`${snapshot} ${path}: protected third-party path missing`);
      }
    }
    return {
      snapshot,
      totals: {
        files: files.length,
        physicalLines: files.reduce((sum, file) => sum + file.physicalLines, 0),
        tokens: files.reduce((sum, file) => sum + file.tokens.length, 0),
        commentOnlyLines: files.reduce((sum, file) => sum + file.commentOnlyLines.length, 0),
        ordinaryCommentOnlyLines: files.reduce((sum, file) => sum + file.ordinaryCommentOnlyLines.length, 0),
      },
      files,
    };
  }
  function renames(base: string, snapshot: string) {
    const from = resolveCommit(base);
    const flags = ['-z', '--name-status', '--no-ext-diff', '--no-textconv', `--find-renames=${renameSimilarity}`, '--diff-filter=R'];
    let out: string;
    if (snapshot === 'worktree') {
      const dir = mkdtempSync(join(tmpdir(), 'kitto-ratchet-index-'));
      try {
        const source = resolve(root, decode(run('rev-parse', '--git-path', 'index')).trim());
        const index = join(dir, 'index');
        if (existsSync(source)) copyFileSync(source, index);
        const env = { ...process.env, GIT_INDEX_FILE: index };
        command('git', ['--no-replace-objects', 'add', '-A', '--', '.'], { cwd: root, env });
        out = decode(command('git', ['--no-replace-objects', 'diff', '--cached', ...flags, from], { cwd: root, env }));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else if (snapshot === 'index') {
      out = decode(run('diff', '--cached', ...flags, from));
    } else {
      out = decode(run('diff', ...flags, from, resolveCommit(snapshot)));
    }
    const fields = out.split('\0').filter(Boolean);
    const pairs = new Map<string, string>();
    for (let i = 0; i + 2 < fields.length; i += 3) {
      if (fields[i].startsWith('R')) pairs.set(fields[i + 2], fields[i + 1]);
    }
    return pairs;
  }
  return { inventory, renames, resolveCommit, verifyRange };
}

function lstatSafe(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

function key(token: Token) {
  const language = token.language === 'TypeScript' ? 'JavaScript' : token.language;
  return JSON.stringify([language, token.fragment, token.kind, token.raw, token.occurrence, token.directiveAnchor]);
}

function allowedShebang(token: Token) {
  if (token.kind !== 'shebang' || token.fragment.length || token.byteStart !== 0) return false;
  const patterns: Record<string, RegExp | undefined> = {
    Bash: /^#!\/usr\/bin\/env bash$/u,
    JavaScript: /^#!\/usr\/bin\/env node$/u,
    Python: /^#!\/usr\/bin\/env python3$/u,
  };
  return patterns[token.language]?.test(token.text) ?? false;
}

export function compare(base: Snapshot, head: Snapshot, renames = new Map<string, string>()) {
  const old = new Map(base.files.map((file): [string, Inspection] => [file.path, file]));
  const present = new Set(head.files.map((file) => file.path));
  const grants = new Map<string, string>();
  for (const [path, from] of renames) {
    if (!old.has(path) && old.has(from) && !present.has(from) && ![...grants.values()].includes(from)) grants.set(path, from);
  }
  const added: PathToken[] = [];
  const removed: PathToken[] = [];
  const violations: (PathToken & { reason: string })[] = [];
  for (const file of head.files) {
    const source = grants.get(file.path) ?? file.path;
    const prior = old.get(source)?.tokens ?? [];
    old.delete(source);
    const before = new Set(prior.map(key));
    const after = new Set(file.tokens.map(key));
    for (const token of file.tokens) {
      if (before.has(key(token)) || allowedShebang(token)) continue;
      const item = { path: file.path, ...token };
      added.push(item);
      violations.push({ ...item, reason: 'new or edited comment' });
    }
    for (const token of prior) {
      if (after.has(key(token))) continue;
      const item = { path: file.path, ...token };
      removed.push(item);
      if (token.kind === 'directive' || token.kind === 'shebang')
        violations.push({ ...item, reason: 'existing semantic directive removed or changed' });
    }
  }
  for (const [path, file] of old) for (const token of file.tokens) removed.push({ path, ...token });
  return { base: base.snapshot, head: head.snapshot, added, removed, violations };
}
