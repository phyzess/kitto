import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { command, decode, formatFor, inspect } from '../comment-ratchet.mjs';

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

export function repository(cwd, bin) {
  const git = (args, at = cwd) => command('git', ['--no-replace-objects', ...args], { cwd: at });
  const root = realpathSync(decode(git(['rev-parse', '--show-toplevel'])).replace(/\n$/u, ''));
  const run = (...args) => git(args, root);
  const list = (...args) => decode(run(...args)).split('\0').filter(Boolean);
  const cache = new Map();
  function resolveCommit(value) {
    if (sha.test(value) && !/^0+$/u.test(value)) {
      try {
        if (decode(run('rev-parse', '--verify', `${value}^{commit}`)).trim() === value) return value;
      } catch (error) {
        throw new Error(`Expected an available commit SHA: ${value}`, { cause: error });
      }
    }
    throw new Error(`Expected a full, available commit SHA: ${value}`);
  }
  function verifyRange(base, head, prHead) {
    resolveCommit(base);
    resolveCommit(head);
    if (prHead) {
      resolveCommit(prHead);
      const ancestry = decode(run('rev-list', '--parents', '-n', '1', head)).trim();
      if (ancestry !== `${head} ${base} ${prHead}`) throw new Error('PR merge commit does not have the event base and head as its two parents');
    } else {
      try { run('merge-base', '--is-ancestor', base, head); }
      catch (error) { throw new Error('Push predecessor is not an available ancestor of the checked commit', { cause: error }); }
    }
  }
  function entries(snapshot) {
    const staged = snapshot === 'index' || snapshot === 'worktree';
    const raw = staged ? list('ls-files', '--stage', '-z') : list('ls-tree', '-r', '-z', resolveCommit(snapshot));
    const files = raw.map(item => {
      const i = item.indexOf('\t');
      const path = item.slice(i + 1);
      const fields = item.slice(0, i).split(' ');
      if (i < 0 || fields.length !== 3 || (staged && fields[2] !== '0')) throw new Error(`Invalid snapshot entry or unresolved merge: ${path}`);
      return { path, mode: fields[0], id: fields[staged ? 1 : 2] };
    });
    if (snapshot === 'worktree') {
      for (const path of list('ls-files', '--others', '--exclude-standard', '-z')) {
        if (!statePath.test(path)) files.push({ path });
      }
    }
    return files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  }
  function read(entry, snapshot) {
    if (entry.mode && !['100644', '100755'].includes(entry.mode)) throw new Error('Only regular files are supported');
    if (snapshot !== 'worktree') return { data: run('cat-file', 'blob', entry.id), mode: entry.mode };
    const path = resolve(root, entry.path);
    const stat = lstatSafe(path);
    if (!stat) return null;
    if (!stat.isFile() || realpathSync(path) !== path) throw new Error('Only regular files directly inside the worktree are supported');
    return { data: readFileSync(path), mode: stat.mode & 0o100 ? '100755' : '100644' };
  }
  function inventory(snapshot, { protect = true } = {}) {
    const files = [];
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
        files.push({ ...cache.get(identity), blob, mode, ...(protectedPath ? { exclusion: 'protected third-party' } : {}) });
      } catch (error) {
        throw new Error(`${snapshot} ${path}: ${error.message}`);
      }
    }
    if (protect) {
      for (const path of protectedPaths.keys()) {
        if (!files.some(file => file.path === path)) throw new Error(`${snapshot} ${path}: protected third-party path missing`);
      }
    }
    return { snapshot, totals: {
      files: files.length,
      physicalLines: files.reduce((sum, file) => sum + file.physicalLines, 0),
      tokens: files.reduce((sum, file) => sum + file.tokens.length, 0),
      commentOnlyLines: files.reduce((sum, file) => sum + file.commentOnlyLines.length, 0),
      ordinaryCommentOnlyLines: files.reduce((sum, file) => sum + file.ordinaryCommentOnlyLines.length, 0),
    }, files };
  }
  return { inventory, resolveCommit, verifyRange };
}

function lstatSafe(path) {
  try { return lstatSync(path); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function key(token) {
  return JSON.stringify([token.language, token.fragment, token.kind, token.raw, token.occurrence, token.directiveAnchor]);
}

function allowedShebang(token) {
  if (token.kind !== 'shebang' || token.fragment.length || token.byteStart !== 0) return false;
  return ({ Bash: /^#!\/usr\/bin\/env bash$/u, JavaScript: /^#!\/usr\/bin\/env node$/u,
    Python: /^#!\/usr\/bin\/env python3$/u })[token.language]?.test(token.text) ?? false;
}

export function compare(base, head) {
  const old = new Map(base.files.map(file => [file.path, file]));
  const added = [];
  const removed = [];
  const violations = [];
  for (const file of head.files) {
    const prior = old.get(file.path)?.tokens ?? [];
    old.delete(file.path);
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
      if (token.kind === 'directive' || token.kind === 'shebang') violations.push({ ...item, reason: 'existing semantic directive removed or changed' });
    }
  }
  for (const [path, file] of old) for (const token of file.tokens) removed.push({ path, ...token });
  return { base: base.snapshot, head: head.snapshot, added, removed, violations };
}
