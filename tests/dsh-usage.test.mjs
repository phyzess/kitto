import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../skills/context-budget/scripts/dsh-usage.mjs', import.meta.url));
const time = Date.UTC(2026, 0, 1);
const header = JSON.stringify({ type: 'session', version: 4, cwd: '/synthetic/project', createdAt: time });
const request = (inputTokens, timestamp = time) => JSON.stringify({
  type: 'assistant/message', time: timestamp,
  data: { usage: { inputTokens, cacheReadTokens: 5, outputTokens: 2 }, message: { source: { provider: 'openai-codex', model: 'gpt-6.2-sol' }, text: 'PRIVATE_MESSAGE' } },
});

function fixture(t, { zstd = true } = {}) {
  const base = realpathSync(tmpdir());
  const home = mkdtempSync(join(base, 'kitto-dsh-usage-'));
  assert.match(relative(base, home), /^kitto-dsh-usage-[^/]+$/);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  if (zstd) {
    // A deterministic decompressor stand-in: fixtures contain simulated stdout.
    writeFileSync(join(bin, 'zstd'), `#!/bin/sh
exec '${process.execPath.replaceAll("'", "'\\''")}' "$0.cjs" "$@"
`, { mode: 0o755 });
    writeFileSync(join(bin, 'zstd.cjs'), `
const { closeSync, readFileSync, writeFileSync } = require('node:fs');
const { basename, dirname } = require('node:path');
const file = process.argv.at(-1);
const id = basename(dirname(file));
writeFileSync(1, readFileSync(file));
closeSync(1);
if (id === 'failed' || id === 'signaled') {
  writeFileSync(2, 'PRIVATE_ZSTD_ERROR');
  setTimeout(() => {
    if (id === 'signaled') process.kill(process.pid, 'SIGTERM');
    else process.exit(7);
  }, 30);
}
`);
  }
  return {
    session(id, contents) {
      const dir = join(home, 'sessions', 'project', id);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'session.v4.jsonl.zstd');
      if (contents !== undefined) writeFileSync(file, contents);
      return file;
    },
    run(...args) {
      const result = spawnSync(process.execPath, [script, ...args], {
        encoding: 'utf8', timeout: 5000,
        env: { HOME: home, DSH_HOME: home, PATH: bin },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    },
  };
}

const diagnostics = (malformedLines = 0, truncatedTails = 0, decompressionFailures = 0, affectedFiles = 0) => ({
  malformedLines, truncatedTails, decompressionFailures, affectedFiles,
});

function report(result, code, expectedDiagnostics) {
  assert.equal(result.status, code, result.stderr);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, code === 0 ? 'complete' : 'partial');
  assert.deepEqual(summary.diagnostics, expectedDiagnostics);
  return summary;
}

test('clean JSONL accepts CRLF, a valid final line without LF, and unrelated JSON', (t) => {
  const f = fixture(t);
  f.session('clean', [header, '', '\t ', 'null', '1', '"assistant/message"',
    '{"type":"other","marker":"assistant/message","data":{"usage":{"inputTokens":200}}}',
    ` ${request(11)}`, request(23)].join('\r\n'));
  const summary = report(f.run('--json'), 0, diagnostics());
  assert.equal(summary.sessions, 1);
  assert.equal(summary.requests, 2);
  assert.equal(summary.inputTokens, 34);
  assert.equal(summary.days[0].date, '2026-01-01');
  assert.match(f.run().stdout, /^COMPLETE\b/);
  const filtered = report(f.run('--json', '--project', '/elsewhere'), 0, diagnostics());
  assert.equal(filtered.sessions, 0);
  assert.equal(filtered.requests, 0);
});

test('keeps valid records before and after a malformed LF line and separates the bad tail', (t) => {
  const f = fixture(t);
  const content = [header, request(11), 'PRIVATE_BAD_LINE\r{}', request(23), '{"PRIVATE_TAIL":'].join('\n');
  const file = f.session('broken', content);
  const json = f.run('--json');
  const summary = report(json, 1, diagnostics(1, 1, 0, 1));
  assert.equal(summary.sessions, 1);
  assert.equal(summary.requests, 2);
  assert.equal(summary.inputTokens, 34);
  const human = f.run();
  assert.equal(human.status, 1);
  assert.match(human.stdout, /^PARTIAL\b/);
  assert.match(human.stdout, /1 malformed lines?\b/);
  assert.match(human.stdout, /1 truncated tails?\b/);
  assert.match(human.stdout, /0 decompression failures?\b/);
  assert.match(human.stdout, /1 affected files?\b/);
  assert.doesNotMatch(json.stdout + human.stdout + human.stderr, /PRIVATE_/);
  assert.equal(readFileSync(file, 'utf8'), content);
});

test('invalid dates are counted without losing usage from the same session', (t) => {
  const f = fixture(t);
  const badHeader = header.replace(`"createdAt":${time}`, '"createdAt":"PRIVATE_DATE"');
  f.session('bad-dates', [badHeader, request(11), request(99, 8_640_000_000_000_001),
    request(99, null), request(23)].join('\n'));
  const json = f.run('--json', '--project', '/synthetic');
  const summary = report(json, 1, diagnostics(3, 0, 0, 1));
  assert.equal(summary.sessions, 1);
  assert.equal(summary.requests, 2);
  assert.equal(summary.inputTokens, 34);
  assert.equal(summary.window.from, time);
  assert.equal(summary.days[0].date, '2026-01-01');
  assert.doesNotMatch(json.stdout, /PRIVATE_DATE|RangeError/);
  const human = f.run();
  assert.equal(human.status, 1);
  assert.equal(human.stderr, '');
  assert.match(human.stdout, /2026-01-01/);
});

test('invalid UTF-8 bytes are counted by LF boundary but valid U+FFFD is accepted', (t) => {
  const f = fixture(t);
  const invalid = (inputTokens) => {
    const [before, after] = request(inputTokens).split('PRIVATE_MESSAGE');
    return Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)]);
  };
  const replacement = request(11).replace('PRIVATE_MESSAGE', '\uFFFD');
  f.session('bad-utf8', Buffer.concat([Buffer.from(`${header}\n${replacement}\n`), invalid(99),
    Buffer.from(`\n${request(23)}\n`), invalid(99)]));
  const summary = report(f.run('--json'), 1, diagnostics(1, 1, 0, 1));
  assert.equal(summary.sessions, 1);
  assert.equal(summary.requests, 2);
  assert.equal(summary.inputTokens, 34);
});

test('bad token counts are isolated without echoing their values', (t) => {
  const f = fixture(t);
  const usage = (fields) => JSON.stringify({ type: 'assistant/message', time, data: { usage: fields } });
  f.session('bad-token-count', [header, usage({ inputTokens: 4 }),
    usage({ inputTokens: 'PRIVATE_TOKENS' }), usage({ inputTokens: 4, cacheReadTokens: -1 }),
    usage({ inputTokens: 4, outputTokens: null }).replace('null', '1e309'), usage({ inputTokens: 6 })].join('\n'));
  const json = f.run('--json');
  const summary = report(json, 1, diagnostics(3, 0, 0, 1));
  assert.equal(summary.requests, 2);
  assert.equal(summary.inputTokens, 10);
  assert.equal(summary.cacheReadTokens, 0);
  assert.equal(summary.outputTokens, 0);
  const human = f.run();
  assert.equal(human.status, 1);
  assert.equal(human.stderr, '');
  assert.doesNotMatch(json.stdout + json.stderr + human.stdout + human.stderr, /PRIVATE_TOKENS/);
});

test('invalid session metadata is counted without leaking it or losing usage', (t) => {
  const f = fixture(t);
  const event = (type, data) => JSON.stringify({ type, data });
  const bad = { text: 'PRIVATE_METADATA' };
  const badHeader = JSON.stringify({ type: 'session', cwd: bad, parentSession: bad, delegationDepth: bad, createdAt: time });
  f.session('fallback-id', [badHeader, request(7), event('session/title', { title: bad }),
    event('subagent/descriptor', { label: [bad] }), request(3)].join('\n'));
  f.session('normal-metadata', [header, request(2), event('session/title', { title: bad }),
    event('subagent/descriptor', { label: 'safe-label' })].join('\n'));
  const json = f.run('--json');
  const summary = report(json, 1, diagnostics(4, 0, 0, 2));
  assert.equal(summary.requests, 3);
  assert.equal(summary.fanOut.root, 2);
  assert.equal(summary.topSessions.find(row => row.id === 'fallback-id').depth, 0);
  assert.equal(summary.topSessions.find(row => row.id === 'fallback-id').title, '');
  const filtered = report(f.run('--json', '--project', '/synthetic'), 1, diagnostics(4, 0, 0, 2));
  assert.equal(filtered.requests, 1);
  assert.equal(filtered.topSessions[0].title, 'safe-label');
  const human = f.run();
  assert.equal(human.status, 1);
  assert.equal(human.stderr, '');
  assert.match(human.stdout, /^PARTIAL\b/);
  assert.match(human.stdout, /fallback-id/);
  assert.match(human.stdout, /safe-label/);
  assert.doesNotMatch(json.stdout + json.stderr + human.stdout + human.stderr, /PRIVATE_METADATA/);
});

test('waits for decompressor close, keeping data emitted before nonzero exit or signal', (t) => {
  const f = fixture(t);
  f.session('clean', `${header}\n${request(11)}\n`);
  f.session('failed', `${header}\n${request(23)}\nPRIVATE_BAD_LINE\n`);
  f.session('signaled', `${header}\n${request(42)}`);
  const json = f.run('--json');
  const summary = report(json, 1, diagnostics(1, 0, 2, 2));
  assert.equal(summary.sessions, 3);
  assert.equal(summary.requests, 3);
  assert.equal(summary.inputTokens, 76);
  assert.doesNotMatch(json.stdout, /PRIVATE_/);
});

test('all damaged input is partial, even with zero recovered usage', (t) => {
  const f = fixture(t);
  f.session('failed', 'PRIVATE_TAIL');
  const summary = report(f.run('--json'), 1, diagnostics(0, 1, 1, 1));
  assert.equal(summary.sessions, 0);
  assert.equal(summary.requests, 0);
  assert.match(f.run().stdout, /^PARTIAL\b/);
});

test('empty audits are complete and do not require a decompressor', (t) => {
  const f = fixture(t, { zstd: false });
  const empty = report(f.run('--json'), 0, diagnostics());
  assert.equal(empty.sessions, 0);
  assert.equal(empty.requests, 0);
  f.session('directory-without-log');
  assert.equal(report(f.run('--json'), 0, diagnostics()).requests, 0);
  assert.match(f.run().stdout, /^COMPLETE\b/);
});

test('a candidate file without zstd is fatal with an installation hint and no summary', (t) => {
  const f = fixture(t, { zstd: false });
  f.session('clean', `${header}\n${request(11)}\n`);
  for (const args of [[], ['--json']]) {
    const result = f.run(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /install zstd/i);
    assert.doesNotMatch(result.stderr, /PRIVATE_/);
  }
});
