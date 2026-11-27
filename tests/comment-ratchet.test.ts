import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'vitest';
import { parse } from 'yaml';
import { command, formatFor, inspect, nativeParser } from '../scripts/comment-ratchet.ts';
import { compare, repository } from '../scripts/comment-ratchet/snapshots.ts';

const parser = nativeParser();
const genesis = '4400a587ef93343ec6c5c52d20b7dc8e8468638c';
const scan = (path: string, source: string | Buffer) => inspect(parser, path, formatFor(path), Buffer.from(source));
const snap = (files: Record<string, string>, snapshot = 'fixture') => ({
  snapshot,
  files: Object.entries(files).map(([path, source]) => scan(path, source)),
});
const workflow = (run: string) =>
  `name: Checks\non: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - id: example\n        run: ${run}\n`;

function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'kitto-comment-test-'));
  t.onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (args: string[], input?: string) => command('git', args, { cwd, input }).toString().trim();
  git(['init', '-q', '--object-format=sha1']);
  function blob(source: string) {
    return git(['hash-object', '-w', '--stdin'], source);
  }
  function commit(source: string, ...parents: string[]) {
    const tree = git(['mktree'], `100644 blob ${blob(source)}\tsource.mjs\n`);
    return git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit-tree',
      tree,
      ...parents.flatMap((parent) => ['-p', parent]),
      '-m',
      'Fixture',
    ]);
  }
  const repo = repository(cwd, parser);
  return { cwd, git, blob, commit, repo, inventory: (ref: string) => repo.inventory(ref, { protect: false }) };
}

test('JavaScript inventory gives exact Unicode spans, ignores data, and unions physical lines', () => {
  const source =
    'const 笑 = /[/*#]/; // 😀 note\r\nconst url = "https://example.invalid/#data";\r\n' +
    'const tpl = `literal // data ${笑 /* interpolation */}`;\r\n' +
    '/* beginning\r\n\r\n   ending */ /* second */\r\n/* split\r\n*/ export {};\r\n' +
    '// ast-grep-' +
    'ignore\r\n// must still be counted';
  const inv = scan('file.mjs', source);
  assert.deepEqual(
    inv.tokens.map((t) => t.text),
    [
      '// 😀 note',
      '/* interpolation */',
      '/* beginning\r\n\r\n   ending */',
      '/* second */',
      '/* split\r\n*/',
      '// ast-grep-' + 'ignore',
      '// must still be counted',
    ],
  );
  assert.deepEqual(inv.commentOnlyLines, [4, 5, 6, 7, 9, 10]);
  assert.equal(inv.physicalLines, 10);
  const first = inv.tokens[0];
  assert.equal(first.byteStart, Buffer.byteLength('const 笑 = /[/*#]/; '));
  assert.deepEqual(first.start, { line: 1, column: 20 });
  assert.equal(first.hash, createHash('sha256').update(first.raw).digest('hex'));
  for (const t of inv.tokens) assert.equal(Buffer.from(source).subarray(t.byteStart, t.byteEnd).toString(), t.raw);
});

test('Python, Bash, YAML and TypeScript distinguish literals, docs, and code comments', () => {
  assert.deepEqual(
    scan('a.py', '#!/usr/bin/env python3\n"""# docstring"""\nx = "# literal" # comment\n').tokens.map((t) => t.kind),
    ['shebang', 'comment'],
  );
  assert.deepEqual(
    scan(
      'a.sh',
      '#!/usr/bin/env bash\nprintf "%s" "# literal" # comment\n' +
        "cat <<'HELP'\n# data\nHELP\npython3 - <<'PY'\n# comment in Python\nprint('# data')\nPY\n",
    ).tokens.map((t) => t.language),
    ['Bash', 'Bash', 'Python'],
  );
  assert.deepEqual(
    scan('config.yml', 'str: "# data" # inline\nliteral: |\n  # data\n# outer\n').tokens.map((t) => t.text),
    ['# inline', '# outer'],
  );
  const before = snap({ 'v.ts': '// @ts-nocheck\nconst n: number = 1;\n' });
  const next = snap({ 'v.ts': '// @ts-nocheck\ninterface Value { n: number }\nconst n: number = 2;\n' });
  assert.equal(compare(before, next).violations.length, 0);
  assert.equal(
    compare(before, snap({ 'v.ts': 'const n: number = 1;\n' })).violations[0].reason,
    'existing semantic directive removed or changed',
  );
  assert.equal(compare(next, snap({ 'v.ts': '// @ts-nocheck\n// @ts-ignore\nconst n: number = 1;\n' })).violations[0].kind, 'directive');
  assert.equal(
    compare(snap({ 'config.yml': 'str: "# not a comment"\n' }), snap({ 'config.yml': 'str: "# different data"\nsequence: [foo, bar]\n' }))
      .violations.length,
    0,
  );
});

test('workflow maps YAML, Bash and executable heredoc byte ranges to original source', () => {
  const source = workflow(
    '|- # header\n          # Bash\n          printf "%s" "# data"\n' +
      "          node --input-type=module <<'JS'\n          /* JS\n          interior */\n          JS",
  );
  const inv = scan('.github/workflows/check.yml', source);
  assert.deepEqual(
    inv.tokens.map((t) => [t.language, t.start.line, t.start.column]),
    [
      ['Yaml', 8, 17],
      ['Bash', 9, 11],
      ['JavaScript', 12, 11],
    ],
  );
  assert.deepEqual(inv.commentOnlyLines, [9, 12, 13]);
  assert.deepEqual(inv.tokens[2].fragment, ['jobs/test/id:example', 'node:JS:1']);
  assert.equal(inv.tokens[2].raw, '/* JS\n          interior */');
  assert.equal(inv.tokens[2].text, '/* JS\ninterior */');
  assert.equal(scan('.github/workflows/check.yml', workflow("'echo ok # note'")).tokens[0].language, 'Bash');
  assert.equal(scan('config.yml', source).tokens.length, 1);
});

test('recognized embedded contexts fail closed on unsupported or malformed input', () => {
  const cases: [string, string, RegExp][] = [
    ['bad.mjs', 'function f() {\n// not a valid input\n', /node .*failed/u],
    ['bad.mjs', 'const value = "unterminated\n// concealed\n', /node .*failed/u],
    ['bad.ts', 'function f(): number {\n// not a valid input\n', /TypeScript|Expected/u],
    ['bad.py', 'if True:\n# not a valid input\n', /python3 .*failed/u],
    ['bad.sh', 'if true; then\n# not a valid input\n', /bash .*failed/u],
    ['bad.yml', 'value: [one\n# not a valid input\n', /Yaml parse error/u],
    ['bad.json', '{ /* no */ }', /JSON|property name/u],
    ['unknown.rst', '.. comment', /Unsupported source format/u],
    ['.env.example', 'A="quoted\n# ambiguous\n', /Unclosed env quote/u],
    ['.github/workflows/a.yml', workflow('>\n          echo script'), /Unsupported workflow run scalar/u],
    ['.github/workflows/a.yml', workflow('echo $' + '{{ inputs.dynamic }}'), /workflow expressions/u],
    ['.github/workflows/a.yml', workflow("|\n          bash -c 'echo ok # unpublished'"), /inline interpreter/u],
    [
      '.github/workflows/a.yml',
      workflow("|\n          ruby <<'RB'\n          # no parser\n          RB"),
      /Unsupported executable heredoc/u,
    ],
    [
      '.github/workflows/a.yml',
      workflow("|\n          node --input-type=module <<'JS'\n          const v = ;\n          JS"),
      /node .*failed/u,
    ],
    ['.github/workflows/a.yml', workflow('echo ok\n        shell: pwsh'), /workflow field or shell/u],
  ];
  for (const [path, source, error] of cases) assert.throws(() => scan(path, source), error, path);
});

test('TypeScript detects incomplete recovery even when the ERROR selector returns no nodes', () => {
  const source = 'function f() {\n';
  const errors = command(parser, ['run', '--stdin', '--lang', 'TypeScript', '--kind', 'ERROR', '--json=compact'], {
    input: source,
    emptyMatch: true,
  });
  assert.deepEqual(JSON.parse(errors.toString()), []);
  assert.throws(() => scan('a.ts', source), /TypeScript parse error: incomplete or recovered syntax/u);
});

test('YAML validation rejects recovered syntax in configuration and workflow YAML', () => {
  const malformed: [string, RegExp][] = [
    [' \tvalue', /Use spaces for YAML separation/u],
    [' "\\U00110000"', /BAD_DQ_ESCAPE/u],
    [' "\\uD800"', /Invalid Unicode scalar value/u],
    [' *undefined_anchor', /Alias does not reference a preceding anchor/u],
  ];
  for (const [value, diagnostic] of malformed) {
    assert.throws(() => scan('config.yml', `key:${value}\n`), diagnostic);
    assert.throws(() => scan('.github/workflows/check.yml', workflow('echo ok') + `        env:\n          VALUE:${value}\n`), diagnostic);
  }
});

test('ordinary YAML edits accept valid anchors and data-only tags without relaxing the comment ratchet', () => {
  const path = 'config/dsh/example.yml';
  const source = 'options: &defaults [one, two]\nconfig: !replace [*defaults, "a\tb", "\\U0001F600"]\n';
  const baseline = snap({ [path]: '# note\n' + source });
  assert.equal(compare(baseline, snap({ [path]: source.replace('one', 'edited') })).violations.length, 0);
  assert.equal(compare(snap({}), snap({ [path]: source })).violations.length, 0);
  assert.deepEqual(
    compare(baseline, snap({ [path]: '# new\n' + source })).violations.map((v) => v.text),
    ['# new'],
  );
  const run = workflow('|\n          printf "%s" "a\tb"');
  assert.equal(scan('.github/workflows/check.yml', run).tokens.length, 0);
});

test('line and region directives cannot move unchanged to a different statement', () => {
  const directive = '// @ts-ignore\n';
  const first = 'const bad: number = "bad";\n';
  const second = 'const fine: number = 1;\n';
  const ts = (source: string) => snap({ 'a.ts': source });
  const baseline = ts('// explanation\n' + directive + first + second);
  assert.equal(compare(baseline, ts(directive + first + second)).violations.length, 0);
  assert.ok(compare(baseline, ts(first + directive + second)).violations.some((item) => item.kind === 'directive'));
  const start = '/* eslint-disable some-rule */\n';
  const end = '/* eslint-enable some-rule */\n';
  const js = (source: string) => snap({ 'a.mjs': source });
  assert.ok(
    compare(js(start + 'a();\n' + end + 'b();\n'), js('a();\n' + start + 'b();\n' + end)).violations.some(
      (item) => item.kind === 'directive',
    ),
  );
});

const padding = (bytes: number) => `export const pad = '${'x'.repeat(bytes)}';\n`;
const incomplete = 'export const call = (value: number) => value;\ncall(1, 2\n';

test('TypeScript full-tree check is not limited by the argv size and rejects MISSING-only recovery', () => {
  const big = padding(120 * 1024);
  assert.ok(big.length > 96 * 1024);
  assert.deepEqual(
    scan('big.ts', big + '// counted\n').tokens.map((t) => t.text),
    ['// counted'],
  );
  assert.throws(() => scan('big.ts', big + incomplete), /incomplete or recovered syntax/u);
  assert.throws(() => scan('small.ts', incomplete), /incomplete or recovered syntax/u);
  assert.throws(() => scan('small.ts', 'export const v = ;\n'), /TypeScript parse error/u);
  assert.throws(() => scan('huge.ts', padding(8 * 1024 * 1024)), /exceeds the supported source size/u);
});

test('hash-comment ignore files are counted like gitignore comments', () => {
  for (const name of ['.gitignore', '.prettierignore', '.npmignore', '.dockerignore']) {
    for (const path of [name, `sub/dir/${name}`]) {
      assert.equal(formatFor(path), 'Gitignore');
      assert.deepEqual(
        scan(path, '# note\n\\#pattern\npath#part\n  # data\n').tokens.map((t) => t.text),
        ['# note'],
      );
      const before = snap({ [path]: 'dist\n' });
      assert.equal(compare(before, snap({ [path]: 'dist\n' })).violations.length, 0);
      assert.equal(compare(before, snap({ [path]: '# added\ndist\n' })).violations.length, 1);
    }
  }
  assert.throws(() => formatFor('.oxlintignore'), /Unsupported source format/u);
});

test('git-blame-ignore-revs counts full-line and trailing hash comments', () => {
  const sha = '8da1fae0123456789abcdef0123456789abcdef0';
  assert.equal(formatFor('.git-blame-ignore-revs'), 'GitRevs');
  const inv = scan('.git-blame-ignore-revs', `# Oxfmt\r\n${sha} # trailing 笑\r\n${sha}\r\n`);
  assert.deepEqual(
    inv.tokens.map((t) => t.text),
    ['# Oxfmt', '# trailing 笑'],
  );
  assert.equal(inv.tokens[1].start.column, 42);
  const before = snap({ '.git-blame-ignore-revs': `${sha}\n` });
  assert.equal(compare(before, snap({ '.git-blame-ignore-revs': `${sha} # added\n` })).violations.length, 1);
  assert.equal(compare(before, snap({ '.git-blame-ignore-revs': `${sha}\n` })).violations.length, 0);
});

test('dotenv and gitignore lexical rules respect quoted and escaped hashes', () => {
  assert.deepEqual(
    scan('.gitignore', '# only comment\n\\#pattern\n  # leading spaces are part of a pattern\npath#part\n').tokens.map((t) => t.text),
    ['# only comment'],
  );
  assert.deepEqual(
    scan(
      '.env.example',
      '# first\nA=unquoted#value\nB=#value\nC="value#part" # inline\nD= # shell comment\n' +
        "export E='quote # still data'\nF=some-value # trailing\n",
    ).tokens.map((t) => t.text),
    ['# first', '# inline', '# shell comment', '# trailing'],
  );
});

test('ratchet ignores code line shifts, rejects edits, extra copies, renames and reintroduction', () => {
  const base = snap({ 'a.mjs': '// one\n// duplicate\n// duplicate\nconst x = 1;\n' }, 'older');
  const reduced = snap({ 'a.mjs': 'const y = 0;\n// duplicate\nconst x = 3;\n' }, 'target');
  assert.equal(compare(base, reduced).violations.length, 0);
  assert.deepEqual(
    compare(base, snap({ 'a.mjs': '// edit\n' })).violations.map((t) => t.text),
    ['// edit'],
  );
  assert.equal(compare(base, snap({ 'a.mjs': '// duplicate\n// duplicate\n// duplicate\n' })).violations[0].occurrence, 3);
  assert.equal(compare(base, snap({ 'renamed.mjs': '// one\n' })).violations[0].path, 'renamed.mjs');
  assert.equal(compare(reduced, base).violations.length, 2);
  const newScript = snap({ 'bin/a.mjs': '#!/usr/bin/env node\nexport {};\n' });
  assert.equal(compare(snap({}), newScript).violations.length, 0);
  assert.equal(compare(newScript, snap({ 'bin/a.mjs': 'export {};\n' })).violations.length, 1);
  assert.equal(compare(snap({}), snap({ 'bin/a.mjs': '#!/tmp/unsupported node\nexport {};\n' })).violations.length, 1);
  const oldRun = workflow('|\n          # fixed\n          echo before');
  const newRun = workflow('|\n          # fixed\n          echo after').replace('id: example', 'id: moved');
  assert.equal(compare(snap({ '.github/workflows/a.yml': oldRun }), snap({ '.github/workflows/a.yml': newRun })).violations.length, 1);
});

test('snapshots bind the push ancestor and the two PR parents, and inspect index plus untracked files', (t) => {
  const { cwd, git, blob, commit, repo, inventory } = fixture(t);
  const base = commit('// retained\nexport {};\n');
  const branch = commit('// branch debt\nexport {};\n', base);
  const target = commit('export {};\n', base);
  const merge = commit('export {};\n', target, branch);
  assert.doesNotThrow(() => repo.verifyRange(base, branch));
  assert.doesNotThrow(() => repo.verifyRange(target, merge, branch));
  assert.throws(() => repo.verifyRange(base, merge, branch), /two parents/u);
  assert.throws(() => repo.verifyRange(branch, target), /not an available ancestor/u);
  assert.throws(() => repo.resolveCommit('0'.repeat(40)), /failed|commit SHA/u);
  assert.equal(compare(inventory(target), inventory(merge)).violations.length, 0);
  assert.equal(compare(inventory(target), inventory(branch)).violations.length, 1);
  const staged = blob('// staged debt\nexport {};\n');
  git(['update-index', '--add', '--cacheinfo', `100644,${staged},source.mjs`]);
  writeFileSync(join(cwd, 'source.mjs'), 'export {};\n');
  writeFileSync(join(cwd, 'untracked.mjs'), '// new untracked debt\n');
  writeFileSync(join(cwd, '.gitignore'), 'ignored.mjs\n');
  writeFileSync(join(cwd, 'ignored.mjs'), '// ignored data\n');
  mkdirSync(join(cwd, '.agent-teams'));
  writeFileSync(join(cwd, '.agent-teams', 'harness-state'), 'local diagnostics');
  assert.deepEqual(
    compare(inventory(target), inventory('index')).violations.map((v) => v.path),
    ['source.mjs'],
  );
  assert.deepEqual(
    compare(inventory(target), inventory('worktree')).violations.map((v) => v.path),
    ['untracked.mjs'],
  );
  symlinkSync('source.mjs', join(cwd, 'bad.mjs'));
  assert.throws(() => inventory('worktree'), /Only regular files/u);
});

test('renames carry comments across .mjs to .ts, but copies and dissimilar rewrites do not', (t) => {
  const { git, blob, repo, inventory } = fixture(t);
  const commitFiles = (files: Record<string, string>, ...parents: string[]) => {
    const tree = git(
      ['mktree'],
      Object.entries(files)
        .map(([name, source]) => `100644 blob ${blob(source)}\t${name}\n`)
        .join(''),
    );
    return git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit-tree',
      tree,
      ...parents.flatMap((parent) => ['-p', parent]),
      '-m',
      'Fixture',
    ]);
  };
  const body = Array.from({ length: 12 }, (_, i) => `export function f${i}(a) { return a + ${i}; }\n`).join('');
  const typed = body.replaceAll('f1(a)', 'f1(a: number): number').replaceAll('f2(a)', 'f2(a: number): number');
  const source = `// kept note\n/* block note */\n${body}`;
  const base = commitFiles({ 'a.mjs': source });
  const check = (files: Record<string, string>) => {
    const head = commitFiles(files, base);
    return compare(inventory(base), inventory(head), repo.renames(base, head)).violations;
  };
  const renames = (head: string) => [...repo.renames(base, head)];
  const same = commitFiles({ 'a.ts': `// kept note\n/* block note */\n${typed}` }, base);
  assert.deepEqual(renames(same), [['a.ts', 'a.mjs']]);
  assert.equal(check({ 'a.ts': `// kept note\n/* block note */\n${typed}` }).length, 0);
  assert.equal(check({ 'a.ts': `${typed}` }).length, 0);
  assert.deepEqual(
    check({ 'a.ts': `// kept note\n// extra\n/* block note */\n${typed}` }).map((v) => [v.path, v.text]),
    [['a.ts', '// extra']],
  );
  assert.deepEqual(
    check({ 'a.ts': `// kept note\n/* block note */\n${typed}`, 'a.mjs': source }).map((v) => v.path),
    ['a.ts', 'a.ts'],
  );
  const rewritten = Array.from({ length: 12 }, (_, i) => `export const other${i}: string = 'unrelated ${i * 7919}';\n`).join('');
  assert.deepEqual(renames(commitFiles({ 'a.ts': `// kept note\n${rewritten}` }, base)), []);
  assert.deepEqual(
    check({ 'a.ts': `// kept note\n${rewritten}` }).map((v) => v.path),
    ['a.ts'],
  );
  const withTypes = commitFiles({ 'b.mjs': 'export const n = 1;\n' });
  assert.equal(
    compare(
      inventory(withTypes),
      inventory(commitFiles({ 'b.ts': 'export const n: number = 1;\n' }, withTypes)),
      repo.renames(withTypes, commitFiles({ 'b.ts': 'export const n: number = 1;\n' }, withTypes)),
    ).violations.length,
    0,
  );
  const script = commitFiles({ 's.mjs': `#!/usr/bin/env node\n${body}` });
  const moved = commitFiles({ 's.ts': `${body}` }, script);
  assert.equal(
    compare(inventory(script), inventory(moved), repo.renames(script, moved)).violations[0].reason,
    'existing semantic directive removed or changed',
  );
});

function ratchetStep() {
  const text = readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8');
  const step = parse(text).jobs.test.steps.find(
    (step: { name?: string }) => step.name === 'Check comment ratchet or report required bootstrap review',
  );
  assert.equal(step?.shell, 'bash');
  assert.equal(typeof step.run, 'string');
  return step;
}

function runRatchetStep(cwd: string, prefix: string, env: Record<string, string>) {
  return spawnSync('bash', ['-euo', 'pipefail', '-c', `${prefix}\n${ratchetStep().run}`], {
    cwd,
    env: { ...process.env, RUNNER_TEMP: cwd, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('normal PRs and main pushes run only the trusted base package, checker and imports', (t) => {
  const { cwd, git, commit } = fixture(t);
  const checker = `import { lock } from './comment-ratchet/snapshots.ts';
    import { implementation } from './comment-ratchet.ts';
    console.log(JSON.stringify([lock, implementation, ...process.argv.slice(2)]));\n`;
  const lockfile = JSON.stringify({ marker: 'trusted lock' });
  const trustedFiles = {
    'package.json': JSON.stringify({ name: 'trusted-tool', type: 'module' }),
    'package-lock.json': lockfile,
    'scripts/check-comments.ts': checker,
    'scripts/comment-ratchet.ts': 'export const implementation = "trusted implementation";\n',
    'scripts/comment-ratchet/snapshots.ts': `import { readFileSync } from 'node:fs';
      export const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url))).marker;\n`,
  };
  mkdirSync(join(cwd, 'scripts/comment-ratchet'), { recursive: true });
  for (const [path, bytes] of Object.entries(trustedFiles)) writeFileSync(join(cwd, path), bytes);
  git(['add', '--', ...Object.keys(trustedFiles)]);
  const parent = commit('export {};\n');
  const makeCommit = (...parents: string[]) =>
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit-tree',
      git(['write-tree']),
      ...parents.flatMap((parent) => ['-p', parent]),
      '-m',
      'Fixture',
    ]);
  const base = makeCommit(parent);
  for (const path of Object.keys(trustedFiles)) writeFileSync(join(cwd, path), 'candidate must not execute\n');
  git(['add', '--', ...Object.keys(trustedFiles)]);
  const tip = makeCommit(base);
  const head = makeCommit(base, tip);
  git(['update-ref', 'HEAD', head]);
  const spies = `npm() {
    [[ "$#" == 4 && "$1" == ci && "$2" == --ignore-scripts && "$3" == --prefix ]]
    test "$(<"$4/package.json")" = '${trustedFiles['package.json']}'
    test "$(<"$4/package-lock.json")" = '${lockfile}'
  }`;
  const env = { BASE_SHA: base, HEAD_SHA: head, GITHUB_REPOSITORY: 'phyzess/kitto' };
  for (const [event, ref, pr] of [
    ['pull_request', 'refs/pull/51/merge', tip],
    ['push', 'refs/heads/main', ''],
  ]) {
    const result = runRatchetStep(cwd, spies, { ...env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, PR_HEAD_SHA: pr });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      'trusted lock',
      'trusted implementation',
      '--base',
      base,
      '--head',
      head,
      ...(pr ? ['--pr-head', pr] : []),
    ]);
  }
  const missing = runRatchetStep(cwd, spies, {
    ...env,
    BASE_SHA: parent,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    PR_HEAD_SHA: '',
  });
  assert.ok(missing.status !== null && missing.status > 0, missing.stderr);
  assert.match(missing.stderr, /pathspec.*did not match/u);
  assert.equal(missing.stdout, '');
});

test('a missing parser fails', () => {
  assert.throws(() => inspect('/no/such/ast-grep', 'a.mjs', 'JavaScript', Buffer.from('export {};\n')), /ENOENT/u);
});

const hasHistory = spawnSync('git', ['cat-file', '-e', genesis], { stdio: 'ignore' }).status === 0;

test.skipIf(!hasHistory)('the original workflow is auditable at the fixed bootstrap', () => {
  const original = command('git', ['show', `${genesis}:.github/workflows/check.yml`]);
  const comments = inspect(parser, '.github/workflows/check.yml', 'Yaml', original).tokens;
  assert.deepEqual(
    comments.map((t) => [t.language, t.start.line]),
    [
      ['JavaScript', 37],
      ['JavaScript', 38],
    ],
  );
  assert.equal(
    scan('scripts/ci-install-native.ts', readFileSync(new URL('../scripts/ci-install-native.ts', import.meta.url))).tokens.length,
    0,
  );
});
