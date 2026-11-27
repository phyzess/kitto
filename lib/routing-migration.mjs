import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { routingHostVersion } from './host-pins.mjs';

const OPEN = '<!-- kitto:begin -->', CLOSE = '<!-- kitto:end -->';
const BEGIN = '<!-- kitto-routing-v1:begin -->', END = '<!-- kitto-routing-v1:end -->';
const guidance = [BEGIN,
  '## 模型路由执行边界', '',
  `DSH Web ${routingHostVersion} 的显式受控 \`subagent\` 需要 Kitto 一次性许可和宿主审批。Teams、fork、workflow 与直接 JEV 不经过此门禁；未核实账号、有效 fallback、额度或独立审查时停派。`,
  '核对步骤见 [Kitto 本机模型路由](https://github.com/phyzess/kitto/blob/main/docs/model-routing.md)。', END];

function file(path, optional = false) {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > 1_000_000 || realpathSync(path) !== path) throw new Error('Migration accepts only regular non-symlink files.');
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)), mode: stats.mode & 0o777 };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}

function planAgents(text, rollback) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const rows = text.split(/\r?\n/);
  const location = marker => rows.flatMap((line, index) => line === marker ? [index] : []);
  const [opens, closes, starts, ends] = [OPEN, CLOSE, BEGIN, END].map(location);
  const [open, close, start, end] = [opens, closes, starts, ends].map(items => items[0]);
  if (!opens.length && !closes.length && !starts.length && !ends.length) return { action: 'manual-unmanaged', text };
  if (opens.length !== 1 || closes.length !== 1 || open >= close || starts.length !== ends.length || starts.length > 1
      || (starts.length && !(open < start && start < end && end < close))) throw new Error('Ambiguous routing migration markers.');
  if (starts.length && rows.slice(start, end + 1).join('\n') !== guidance.join('\n')) throw new Error('Routing migration block changed; resolve it manually.');
  if (rollback && !starts.length || !rollback && starts.length) return { action: 'none', text };
  const lines = rollback ? { remove: guidance } : { add: guidance };
  const offset = rows.slice(0, rollback ? start : close).reduce((pos, row) => pos + row.length + newline.length, 0);
  const block = `${guidance.join(newline)}${newline}`;
  if (rollback ? !text.startsWith(block, offset) : !text.startsWith(CLOSE, offset)) throw new Error('Mixed line endings require manual migration.');
  return { action: rollback ? 'remove-managed-block' : 'insert-before-kitto-end', ...lines,
    text: `${text.slice(0, offset)}${rollback ? '' : block}${text.slice(offset + (rollback ? block.length : 0))}` };
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function migrateRouting({ home, mode = 'preview', activeHomes = [] }) {
  if (!['preview', 'apply-fixture', 'rollback-fixture'].includes(mode) || !isAbsolute(home)) throw new Error('Expected an absolute migration home.');
  const root = realpathSync(home);
  if (!lstatSync(root).isDirectory()) throw new Error('Expected a migration directory.');
  const agentsPath = join(root, 'AGENTS.md');
  const profilePath = join(root, 'profiles', 'web', 'cordis.patch.yml');
  if (mode !== 'preview') {
    const temp = realpathSync(tmpdir());
    const active = [join(homedir(), '.dsh'), process.env.DSH_HOME, ...activeHomes].filter(Boolean).map(path => {
      try { return realpathSync(path); } catch { return resolve(path); }
    });
    if (dirname(root) !== temp || !/^kitto-route-fixture-[A-Za-z0-9]{6,}$/.test(basename(root))
        || active.some(path => inside(path, root) || inside(root, path))) throw new Error('Fixture writes require an isolated kitto-route-fixture-* temporary home.');
  }
  const execute = () => {
    const agents = file(agentsPath, true), patch = file(profilePath, true);
    const { text, ...change } = agents ? planAgents(agents.text, mode === 'rollback-fixture') : { action: 'manual-unmanaged' };
    const fallbackLines = (patch?.text ?? '').split(/\r?\n/).flatMap((line, index) =>
      /(?:^|[\s{,])['"]?fallback['"]?\s*:/.test(line) && !/^\s*#/.test(line) ? [index + 1] : []);
    if (mode !== 'preview' && agents && text !== agents.text) {
      const stage = join(root, `.kitto-routing-${randomBytes(12).toString('hex')}.tmp`);
      try {
        writeFileSync(stage, text, { flag: 'wx', mode: agents.mode });
        chmodSync(stage, agents.mode);
        renameSync(stage, agentsPath);
      } catch (error) { try { unlinkSync(stage); } catch {} throw error; }
    }
    return { status: mode, changes: [{ path: 'AGENTS.md', ...change }],
      unchanged: ['profiles/web/cordis.patch.yml', 'provider configuration', 'credentials', 'sessions', 'Kitto state', 'AGENTS.md outside managed block'],
      manual: { profilePatch: 'profiles/web/cordis.patch.yml', fallbackLines, effectiveFallbacks: 'unverified',
        actions: ['Inspect effective member, profile and global fallback, including inline plans, YAML aliases and plugin defaults.',
          'Merge routeDispatch: true into the existing phyzess-kitto entry only after reviewing the supported-host and native approval gates.',
          'Preserve local provider/auth and custom instructions; restart the verified Web profile and start a fresh session.'] } };
  };
  if (mode === 'preview') return execute();
  const lock = join(root, '.kitto-routing-migration.lock');
  mkdirSync(lock, { mode: 0o700 });
  try { return execute(); } finally { rmdirSync(lock); }
}
