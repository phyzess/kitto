import { parseArgs } from 'node:util';
import { nativeParser } from './comment-ratchet.mjs';
import { compare, repository } from './comment-ratchet/snapshots.mjs';

const usage = 'Usage: node scripts/check-comments.mjs --inventory <commit-sha|worktree>\n' +
  '       node scripts/check-comments.mjs --base <trusted-commit-sha> [--head <commit-sha> [--pr-head <commit-sha>]] [--json]';

function main() {
  const { values } = parseArgs({ options: {
    inventory: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' },
    'pr-head': { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const { inventory, base, head, 'pr-head': prHead, json, help } = values;
  if (help) return console.log(usage);
  if (inventory !== undefined ? (!inventory || base !== undefined || head !== undefined || prHead !== undefined) :
    (!base || head === '' || prHead === '' || (prHead && !head))) throw new Error(usage);
  const repo = repository(process.cwd(), nativeParser());
  if (inventory) return console.log(JSON.stringify(repo.inventory(inventory), null, 2));
  if (head) repo.verifyRange(base, head, prHead);
  const baseline = repo.inventory(repo.resolveCommit(base));
  const snapshots = head ? [head] : ['index', 'worktree'];
  const reports = snapshots.map(snapshot => compare(baseline, repo.inventory(snapshot)));
  const violations = reports.flatMap(report => report.violations.map(item => ({ snapshot: report.head, ...item })));
  if (json) console.log(JSON.stringify(reports, null, 2));
  else if (!violations.length) console.log(`Comment ratchet passed: ${base} -> ${snapshots.join(', ')}`);
  else for (const item of violations) {
    console.error(`${JSON.stringify(item.path)}:${item.start.line}:${item.start.column} [${item.snapshot}/${item.language}] ${item.reason}: ${JSON.stringify(item.text.slice(0, 120))}`);
  }
  if (violations.length) process.exitCode = 1;
}

try { main(); }
catch (error) {
  console.error(`Comment ratchet: ${JSON.stringify(error.message)}`);
  process.exitCode = 1;
}
