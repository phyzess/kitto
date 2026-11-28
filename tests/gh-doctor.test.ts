import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import type { TestContext } from 'vitest';

const script = fileURLToPath(new URL('../skills/gh-doctor/scripts/gh-doctor.ts', import.meta.url));

type StepReply = {
  status?: number;
  stdout?: string;
  stderr?: string;
};

type FakeGhScenario = {
  version?: StepReply;
  authStatus?: StepReply;
  user?: StepReply;
  repo?: StepReply;
  checks?: StepReply;
  graphql?: StepReply;
  gitOrigin?: StepReply;
};

const DEFAULT_VERSION: StepReply = {
  status: 0,
  stdout: 'gh version 2.70.0 (2026-01-01)\n',
};

function httpReply(statusCode: number, body: unknown, headers: Record<string, string> = {}): StepReply {
  const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status: statusCode >= 400 ? 1 : 0,
    stdout: [`HTTP/2.0 ${statusCode}`, 'Content-Type: application/json; charset=utf-8', ...headerLines, '', payload].join('\r\n'),
    stderr: statusCode >= 400 ? `gh: HTTP ${statusCode}` : '',
  };
}

function fixture(t: TestContext, scenario: FakeGhScenario, { includeGh = true, includeGit = false } = {}) {
  const base = realpathSync(tmpdir());
  const home = mkdtempSync(join(base, 'kitto-gh-doctor-'));
  assert.match(relative(base, home), /^kitto-gh-doctor-[^/]+$/);
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const scenarioFile = join(home, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify({ version: DEFAULT_VERSION, ...scenario }));

  if (includeGh) {
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh
exec '${process.execPath.replaceAll("'", "'\\''")}' "$0.cjs" "$@"
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'gh.cjs'),
      `
const { readFileSync } = require('node:fs');
const scenario = JSON.parse(readFileSync(process.env.GH_FAKE_SCENARIO, 'utf8'));
const args = process.argv.slice(2);
if (args.includes('--show-token')) {
  process.stderr.write('forbidden flag --show-token\\n');
  process.exit(99);
}
if (args[0] === 'auth' && (args[1] === 'login' || args[1] === 'refresh')) {
  process.stderr.write('forbidden mutating auth command\\n');
  process.exit(99);
}
let reply;
if (args[0] === '--version') reply = scenario.version;
else if (args[0] === 'auth' && args[1] === 'status') reply = scenario.authStatus;
else if (args[0] === 'api' && args[1] === 'graphql') reply = scenario.graphql;
else if (args[0] === 'api' && args.includes('/user')) reply = scenario.user;
else if (args[0] === 'api' && args.some((a) => a.includes('/check-runs'))) reply = scenario.checks;
else if (args[0] === 'api' && args.some((a) => a.startsWith('/repos/'))) reply = scenario.repo;
else reply = { status: 1, stderr: 'unexpected gh args: ' + args.join(' ') };
if (reply.stdout) process.stdout.write(reply.stdout);
if (reply.stderr) process.stderr.write(reply.stderr);
process.exit(reply.status ?? 0);
`,
    );
  }

  if (includeGit) {
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh
exec '${process.execPath.replaceAll("'", "'\\''")}' "$0.cjs" "$@"
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'git.cjs'),
      `
const { readFileSync } = require('node:fs');
const scenario = JSON.parse(readFileSync(process.env.GH_FAKE_SCENARIO, 'utf8'));
const reply = scenario.gitOrigin || { status: 1, stderr: 'fatal: not a git repository' };
if (reply.stdout) process.stdout.write(reply.stdout);
if (reply.stderr) process.stderr.write(reply.stderr);
process.exit(reply.status ?? 0);
`,
    );
  }

  return {
    run(args: string[], extraEnv: Record<string, string | undefined> = {}): SpawnSyncReturns<string> {
      const env: NodeJS.ProcessEnv = {
        HOME: home,
        PATH: bin,
        GH_FAKE_SCENARIO: scenarioFile,
      };
      for (const [key, value] of Object.entries(extraEnv)) {
        if (value !== undefined) env[key] = value;
      }
      const result = spawnSync(process.execPath, [script, ...args], {
        encoding: 'utf8',
        timeout: 60_000,
        env,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    },
  };
}

test('oauth token with repo and project scopes passes all probes', (t) => {
  const f = fixture(t, {
    authStatus: {
      status: 0,
      stdout: [
        'github.com',
        '  ✓ Logged in to github.com account octocat (keyring)',
        '  - Token: gho_************************************',
        "  - Token scopes: 'repo', 'read:org', 'project'",
        '',
      ].join('\n'),
    },
    user: httpReply(200, { login: 'octocat' }, { 'X-Oauth-Scopes': 'project, read:org, repo' }),
    repo: httpReply(200, { default_branch: 'main', private: true, owner: { type: 'User' } }),
    checks: httpReply(200, { total_count: 2, check_runs: [] }),
    graphql: {
      status: 0,
      stdout: JSON.stringify({
        data: {
          repositoryOwner: {
            __typename: 'User',
            login: 'octocat',
            projectV2: { id: 'PVT_123', number: 7 },
          },
        },
      }),
    },
  });

  const args = [
    '--repo',
    'octocat/example',
    '--project-owner',
    'octocat',
    '--project-number',
    '7',
    '--require',
    'auth,repo,checks,project',
  ];
  const jsonRes = f.run([...args, '--json']);
  assert.equal(jsonRes.status, 0, jsonRes.stderr);
  assert.equal(jsonRes.stderr, '');
  const report = JSON.parse(jsonRes.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.diagnosis, 'ok');
  assert.equal(report.host, 'github.com');
  assert.equal(report.auth.loggedIn, true);
  assert.equal(report.auth.account, 'octocat');
  assert.equal(report.auth.missingAccountField, false);
  assert.equal(report.auth.tokenSource, 'gh_config');
  assert.equal(report.auth.tokenType, 'oauth');
  assert.deepEqual(report.auth.scopes, ['repo', 'read:org', 'project']);
  assert.equal(report.checks.auth.ok, true);
  assert.equal(report.checks.repo.ok, true);
  assert.equal(report.checks.checks.ok, true);
  assert.equal(report.checks.project.ok, true);
  assert.deepEqual(report.remediation, []);

  const humanRes = f.run(args);
  assert.equal(humanRes.status, 0);
  assert.match(humanRes.stdout, /^OK diagnosis=ok/);
});

test('fine-grained PAT failing checks and user project reports fine_grained_pat_unsupported', (t) => {
  const f = fixture(t, {
    authStatus: {
      status: 0,
      stdout: [
        'github.com',
        '  ✓ Logged in to github.com account octocat (keyring)',
        '  - Token: github_pat_************************************',
        '',
      ].join('\n'),
    },
    user: httpReply(200, { login: 'octocat' }),
    repo: httpReply(200, { default_branch: 'main', private: false, owner: { type: 'User' } }),
    checks: httpReply(
      403,
      { message: 'Resource not accessible by personal access token' },
      { 'X-Accepted-GitHub-Permissions': 'checks=read' },
    ),
    graphql: {
      status: 1,
      stdout: JSON.stringify({
        data: { repositoryOwner: { __typename: 'User', login: 'octocat', projectV2: null } },
        errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }],
      }),
      stderr: 'gh: Resource not accessible by personal access token',
    },
  });

  const res = f.run([
    '--repo',
    'octocat/example',
    '--project-owner',
    'octocat',
    '--project-number',
    '3',
    '--require',
    'auth,repo,checks,project',
    '--json',
  ]);
  assert.equal(res.status, 1, res.stderr);
  assert.equal(res.stderr, '');
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, 'fine_grained_pat_unsupported');
  assert.equal(report.auth.tokenType, 'fine_grained_pat');
  assert.equal(report.checks.checks.code, 'fine_grained_pat_unsupported');
  assert.equal(report.checks.project.code, 'fine_grained_pat_unsupported');
  assert.ok(report.remediation.includes('gh auth login -h github.com -p https -w -s repo,read:org,project'));
});

test('oauth token missing project scope reports missing_project_scope with gh auth refresh remediation', (t) => {
  const f = fixture(t, {
    authStatus: {
      status: 0,
      stdout: [
        'github.com',
        '  ✓ Logged in to github.com account octocat (keyring)',
        '  - Token: gho_************************************',
        "  - Token scopes: 'repo', 'read:org'",
        '',
      ].join('\n'),
    },
    user: httpReply(200, { login: 'octocat' }, { 'X-Oauth-Scopes': 'repo, read:org' }),
    graphql: {
      status: 1,
      stdout: JSON.stringify({
        data: { repositoryOwner: { __typename: 'User', login: 'octocat', projectV2: null } },
        errors: [
          {
            type: 'INSUFFICIENT_SCOPES',
            message: 'Your token has not been granted the required scopes to execute this query. Requires read:project.',
          },
        ],
      }),
    },
  });

  const res = f.run(['--project-owner', 'octocat', '--project-number', '4', '--json']);
  assert.equal(res.status, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, 'missing_project_scope');
  assert.equal(report.checks.project.code, 'missing_project_scope');
  assert.ok(report.remediation.includes('gh auth refresh -h github.com -s project'));
});

test('GH_TOKEN env override sets tokenSource, recommends unset GH_TOKEN, and never leaks secret', (t) => {
  const fakeToken = 'github_pat_FAKE_ENV_SECRET_VALUE_987654';
  const f = fixture(t, {
    authStatus: {
      status: 0,
      stdout: 'github.com\n  ✓ Logged in to github.com account  (GH_TOKEN)\n  - Token: github_pat_****\n',
    },
    user: httpReply(200, { login: 'octocat' }),
    repo: httpReply(200, { default_branch: 'main', private: true, owner: { type: 'User' } }),
    checks: httpReply(
      403,
      { message: 'Resource not accessible by personal access token' },
      { 'X-Accepted-GitHub-Permissions': 'checks=read' },
    ),
  });

  const args = ['--repo', 'octocat/example', '--require', 'auth,repo,checks'];
  const jsonRes = f.run([...args, '--json'], { GH_TOKEN: fakeToken });
  assert.equal(jsonRes.status, 1);
  assert.doesNotMatch(jsonRes.stdout + jsonRes.stderr, /FAKE_ENV_SECRET_VALUE_987654|github_pat_/);
  const report = JSON.parse(jsonRes.stdout);
  assert.equal(report.diagnosis, 'fine_grained_pat_unsupported');
  assert.equal(report.auth.tokenSource, 'env:GH_TOKEN');
  assert.equal(report.auth.envOverride.present, true);
  assert.deepEqual(report.auth.envOverride.variables, ['GH_TOKEN']);
  assert.equal(report.auth.envOverride.tokenType, 'fine_grained_pat');
  assert.ok(report.remediation.includes('unset GH_TOKEN'));

  const humanRes = f.run(args, { GH_TOKEN: fakeToken });
  assert.equal(humanRes.status, 1);
  assert.doesNotMatch(humanRes.stdout + humanRes.stderr, /FAKE_ENV_SECRET_VALUE_987654|github_pat_/);
  assert.match(humanRes.stdout, /unset GH_TOKEN/);
});

test('redacts token-like substrings emitted by gh on stdout and stderr', (t) => {
  const classicSecret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
  const patSecret = 'github_pat_11ABCDEFGH_secretvalue123456';
  const f = fixture(t, {
    authStatus: {
      status: 0,
      stdout: 'github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Token: ghp_****\n',
    },
    user: {
      status: 1,
      stdout: `HTTP/2.0 401\r\n\r\n{"message":"Bad credentials for ${classicSecret}"}`,
      stderr: `gh: failed with ${patSecret} (HTTP 401)`,
    },
  });

  const jsonRes = f.run(['--json']);
  assert.equal(jsonRes.status, 1);
  assert.doesNotMatch(jsonRes.stdout + jsonRes.stderr, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456|github_pat_11ABCDEFGH_secretvalue123456/);
  const report = JSON.parse(jsonRes.stdout);
  assert.equal(report.diagnosis, 'invalid_token');

  const humanRes = f.run([]);
  assert.equal(humanRes.status, 1);
  assert.doesNotMatch(humanRes.stdout + humanRes.stderr, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456|github_pat_11ABCDEFGH_secretvalue123456/);
});

test('unauthenticated gh auth status returns diagnosis unauthenticated', (t) => {
  const f = fixture(t, {
    authStatus: {
      status: 1,
      stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login',
    },
  });

  const res = f.run(['--json']);
  assert.equal(res.status, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, 'unauthenticated');
  assert.equal(report.auth.loggedIn, false);
  assert.ok(report.remediation.includes('gh auth login -h github.com -p https -w -s repo,read:org,project'));
});

test('missing gh binary returns diagnosis gh_missing', (t) => {
  const f = fixture(t, {}, { includeGh: false });
  const res = f.run(['--json']);
  assert.equal(res.status, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, 'gh_missing');
  assert.equal(report.checks.auth.code, 'gh_missing');
});

test('network error without HTTP status returns diagnosis network_error', (t) => {
  const f = fixture(t, {
    authStatus: {
      status: 0,
      stdout: 'github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Token: gho_****\n',
    },
    user: {
      status: 1,
      stdout: '',
      stderr: 'dial tcp: lookup api.github.com: i/o timeout',
    },
  });

  const res = f.run(['--json']);
  assert.equal(res.status, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, 'network_error');
  assert.equal(report.checks.auth.code, 'network_error');
});

test('usage errors exit with code 2 and write only to stderr', (t) => {
  const f = fixture(t, {});
  const cases = [
    ['--unknown-flag'],
    ['--repo', 'not-a-repo'],
    ['--repo', 'owner/repo/extra'],
    ['--project-owner', 'octocat'],
    ['--project-number', '1'],
    ['--project-owner', 'octocat', '--project-number', '0'],
    ['--project-owner-type', 'invalid'],
    ['--host', 'bad/host'],
    ['--require', 'checks'],
    ['--require', 'unknown'],
  ];

  for (const args of cases) {
    const res = f.run(args);
    assert.equal(res.status, 2, `expected exit 2 for ${args.join(' ')}`);
    assert.equal(res.stdout, '', `expected empty stdout for ${args.join(' ')}`);
    assert.notEqual(res.stderr, '', `expected error on stderr for ${args.join(' ')}`);
  }
});

test('detects missingAccountField on gh_config and infers repo from git origin', (t) => {
  const f = fixture(
    t,
    {
      authStatus: {
        status: 0,
        stdout:
          'github.com\n  ✓ Logged in to github.com account  (/home/user/.config/gh/hosts.yml)\n  - Token: gho_****\n  - Token scopes: repo\n',
      },
      user: httpReply(200, { login: 'octocat' }),
      repo: httpReply(200, { default_branch: 'develop', private: false, owner: { type: 'Organization' } }),
      checks: httpReply(200, { total_count: 1, check_runs: [] }),
      gitOrigin: {
        status: 0,
        stdout: 'git@github.com:acme/widget.git\n',
      },
    },
    { includeGit: true },
  );

  const res = f.run(['--require', 'auth,repo,checks', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.auth.missingAccountField, true);
  assert.equal(report.auth.account, null);
  assert.equal(report.checks.repo.repo, 'acme/widget');
  assert.equal(report.checks.checks.branch, 'develop');
});

test('projectV2 null without auth errors reports project_not_found', (t) => {
  const f = fixture(t, {
    authStatus: {
      status: 0,
      stdout: 'github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Token: gho_****\n  - Token scopes: repo, project\n',
    },
    user: httpReply(200, { login: 'octocat' }),
    graphql: {
      status: 0,
      stdout: JSON.stringify({
        data: { repositoryOwner: { __typename: 'Organization', login: 'acme', projectV2: null } },
      }),
    },
  });

  const res = f.run(['--project-owner', 'acme', '--project-number', '999', '--json']);
  assert.equal(res.status, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.diagnosis, 'project_not_found');
  assert.equal(report.checks.project.code, 'project_not_found');
});
