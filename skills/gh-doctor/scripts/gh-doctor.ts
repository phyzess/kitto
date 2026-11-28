import { spawnSync } from 'node:child_process';

type TokenType = 'oauth' | 'classic_pat' | 'fine_grained_pat' | 'installation_token' | 'user_to_server_token' | 'unknown' | 'none';
type TokenSource = 'env:GH_TOKEN' | 'env:GITHUB_TOKEN' | 'gh_config' | 'none';
type RequireCapability = 'auth' | 'repo' | 'checks' | 'project';
type ProjectOwnerType = 'auto' | 'user' | 'org';
type ProbeCode =
  | 'ok'
  | 'gh_missing'
  | 'unauthenticated'
  | 'invalid_token'
  | 'network_error'
  | 'repo_not_found'
  | 'repo_forbidden'
  | 'fine_grained_pat_unsupported'
  | 'checks_forbidden'
  | 'missing_project_scope'
  | 'project_not_found'
  | 'project_forbidden'
  | 'api_error';

type AuthCheckResult = {
  ok: boolean;
  code: ProbeCode;
  httpStatus: number | null;
  login?: string | null;
  message?: string;
};

type RepoCheckResult = {
  ok: boolean;
  code: ProbeCode;
  httpStatus: number | null;
  repo: string;
  defaultBranch?: string;
  private?: boolean | null;
  ownerType?: string | null;
  message?: string;
};

type ChecksCheckResult = {
  ok: boolean;
  code: ProbeCode;
  httpStatus: number | null;
  repo: string;
  branch: string;
  totalCount?: number | null;
  message?: string;
};

type ProjectCheckResult = {
  ok: boolean;
  code: ProbeCode;
  owner: string;
  number: number;
  ownerType: string | null;
  projectId: string | null;
  message?: string;
};

type DoctorReport = {
  ok: boolean;
  diagnosis: ProbeCode;
  host: string;
  auth: {
    loggedIn: boolean;
    account: string | null;
    missingAccountField: boolean;
    tokenSource: TokenSource;
    tokenType: TokenType;
    scopes: string[];
    envOverride: {
      present: boolean;
      variables: string[];
      tokenType: TokenType;
    };
  };
  checks: {
    auth: AuthCheckResult;
    repo?: RepoCheckResult;
    checks?: ChecksCheckResult;
    project?: ProjectCheckResult;
  };
  remediation: string[];
};

type ParsedOptions = {
  host: string;
  repo: string | undefined;
  branch: string | undefined;
  projectOwner: string | undefined;
  projectNumber: number | undefined;
  projectOwnerType: ProjectOwnerType;
  requireSet: Set<RequireCapability>;
  json: boolean;
};

type HttpResponse = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  json: Record<string, unknown> | null;
};

const VALID_CAPABILITIES = new Set<RequireCapability>(['auth', 'repo', 'checks', 'project']);
const VALID_OWNER_TYPES = new Set<ProjectOwnerType>(['auto', 'user', 'org']);
const GH_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 5_000;

const PROJECT_V2_QUERY = `query($owner: String!, $number: Int!) {
  repositoryOwner(login: $owner) {
    __typename
    login
    ... on User {
      projectV2(number: $number) {
        id
        number
      }
    }
    ... on Organization {
      projectV2(number: $number) {
        id
        number
      }
    }
  }
}`;

const USAGE = `Usage: gh-doctor.ts [options]

  --host <hostname>                GitHub host (default github.com)
  --repo <owner/name>              Repository slug (inferred from git origin if omitted)
  --branch <ref>                   Branch ref for checks probe (default repo default_branch or main)
  --project-owner <owner>          GitHub User or Organization owning the Project v2
  --project-number <n>             Positive Project v2 number
  --project-owner-type <mode>      auto | user | org (default auto)
  --require <csv>                  Comma-separated subset of auth,repo,checks,project
  --json                           Print strict JSON report only
  --help, -h                       Show this help

Exit codes: 0 all required checks passed, 1 diagnostic failure, 2 usage/argument error.`;

function collectEnvSecrets(): string[] {
  const secrets: string[] = [];
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
    const raw = process.env[name]?.trim() ?? '';
    if (raw.length >= 6) secrets.push(raw);
  }
  return secrets;
}

function redactText(text: string, envSecrets: readonly string[]): string {
  let out = text.replace(/(?:github_pat|gh[opusr])_[A-Za-z0-9_]+/g, '[REDACTED]');
  for (const secret of envSecrets) {
    if (secret.length >= 6) out = out.replaceAll(secret, '[REDACTED]');
  }
  return out;
}

function writeOut(text: string, envSecrets: readonly string[]): void {
  process.stdout.write(redactText(text, envSecrets));
}

function writeErr(text: string, envSecrets: readonly string[]): void {
  process.stderr.write(redactText(text, envSecrets));
}

function failUsage(message: string, envSecrets: readonly string[]): never {
  writeErr(`gh-doctor: ${message}\n`, envSecrets);
  process.exit(2);
}

function isValidHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (/[\s/\\]/.test(host)) return false;
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host);
}

function isValidRepo(repo: string): boolean {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return false;
  const [owner, name] = repo.split('/');
  if (!owner || !name) return false;
  if (owner === '.' || owner === '..' || name === '.' || name === '..') return false;
  if (owner.startsWith('-') || name.startsWith('-')) return false;
  return true;
}

function isValidOwner(owner: string): boolean {
  if (!/^[^/\s]+$/.test(owner)) return false;
  if (owner === '.' || owner === '..' || owner.startsWith('-')) return false;
  return true;
}

function isValidBranch(branch: string): boolean {
  return branch.length > 0 && !/\s/.test(branch) && !branch.startsWith('-');
}

function parsePositiveSafeInt(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseRemoteUrl(url: string, host: string): string | undefined {
  const trimmed = url.trim();
  const targetHost = host.toLowerCase();
  const httpsMatch = trimmed.match(/^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    const [, remoteHost, owner, repo] = httpsMatch;
    if (remoteHost?.toLowerCase() === targetHost && owner && repo) {
      const slug = `${owner}/${repo}`;
      return isValidRepo(slug) ? slug : undefined;
    }
    return undefined;
  }
  const sshMatch = trimmed.match(/^git@([^:\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (sshMatch) {
    const [, remoteHost, owner, repo] = sshMatch;
    if (remoteHost?.toLowerCase() === targetHost && owner && repo) {
      const slug = `${owner}/${repo}`;
      return isValidRepo(slug) ? slug : undefined;
    }
    return undefined;
  }
  return undefined;
}

function inferRepoFromGit(host: string): string | undefined {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) return undefined;
  return parseRemoteUrl(result.stdout ?? '', host);
}

function parseArgs(argv: readonly string[], envSecrets: readonly string[]): ParsedOptions {
  let host = 'github.com';
  let repo: string | undefined;
  let branch: string | undefined;
  let projectOwner: string | undefined;
  let projectNumber: number | undefined;
  let projectOwnerType: ProjectOwnerType = 'auto';
  let requireArg: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const nextValue = () => {
      const value = argv[i + 1];
      if (value === undefined) failUsage(`${arg} requires a value`, envSecrets);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') {
      writeOut(`${USAGE}\n`, envSecrets);
      process.exit(0);
    } else if (arg === '--host') {
      host = nextValue();
      if (!isValidHost(host)) failUsage(`invalid --host value: ${host}`, envSecrets);
    } else if (arg === '--repo') {
      repo = nextValue();
      if (!isValidRepo(repo)) failUsage(`invalid --repo value: ${repo}`, envSecrets);
    } else if (arg === '--branch') {
      branch = nextValue();
      if (!isValidBranch(branch)) failUsage(`invalid --branch value: ${branch}`, envSecrets);
    } else if (arg === '--project-owner') {
      projectOwner = nextValue();
      if (!isValidOwner(projectOwner)) failUsage(`invalid --project-owner value: ${projectOwner}`, envSecrets);
    } else if (arg === '--project-number') {
      const raw = nextValue();
      const parsed = parsePositiveSafeInt(raw);
      if (parsed === undefined) failUsage(`invalid --project-number value: ${raw}`, envSecrets);
      projectNumber = parsed;
    } else if (arg === '--project-owner-type') {
      const raw = nextValue();
      if (!VALID_OWNER_TYPES.has(raw as ProjectOwnerType)) {
        failUsage(`invalid --project-owner-type value: ${raw}`, envSecrets);
      }
      projectOwnerType = raw as ProjectOwnerType;
    } else if (arg === '--require') {
      requireArg = nextValue();
    } else if (arg === '--json') {
      json = true;
    } else {
      failUsage(`unknown argument ${arg}`, envSecrets);
    }
  }

  if ((projectOwner !== undefined) !== (projectNumber !== undefined)) {
    failUsage('--project-owner and --project-number must be provided together', envSecrets);
  }

  const requireSet = new Set<RequireCapability>();
  if (requireArg !== undefined) {
    const items = requireArg.split(',');
    if (items.length === 0 || items.some((item) => item.length === 0)) {
      failUsage(`invalid --require value: ${requireArg}`, envSecrets);
    }
    for (const item of items) {
      if (!VALID_CAPABILITIES.has(item as RequireCapability)) {
        failUsage(`unsupported capability in --require: ${item}`, envSecrets);
      }
      requireSet.add(item as RequireCapability);
    }
  } else {
    requireSet.add('auth');
    if (repo !== undefined) requireSet.add('repo');
    if (projectOwner !== undefined && projectNumber !== undefined) requireSet.add('project');
  }

  if (requireSet.has('project') && (projectOwner === undefined || projectNumber === undefined)) {
    failUsage('project check requires both --project-owner and --project-number', envSecrets);
  }

  if ((requireSet.has('repo') || requireSet.has('checks')) && repo === undefined) {
    repo = inferRepoFromGit(host);
    if (repo === undefined) {
      failUsage('--repo is required when git origin remote cannot be inferred for the target host', envSecrets);
    }
  }

  return {
    host,
    repo,
    branch,
    projectOwner,
    projectNumber,
    projectOwnerType,
    requireSet,
    json,
  };
}

function classifyToken(token: string | undefined): TokenType {
  if (!token) return 'none';
  if (token.startsWith('gho_')) return 'oauth';
  if (token.startsWith('ghp_')) return 'classic_pat';
  if (token.startsWith('github_pat_')) return 'fine_grained_pat';
  if (token.startsWith('ghs_')) return 'installation_token';
  if (token.startsWith('ghu_')) return 'user_to_server_token';
  return 'unknown';
}

function inspectEnvOverride(): {
  present: boolean;
  variables: string[];
  tokenType: TokenType;
  tokenSource: TokenSource;
} {
  const ghToken = process.env.GH_TOKEN?.trim() ?? '';
  const githubToken = process.env.GITHUB_TOKEN?.trim() ?? '';
  const variables: string[] = [];
  if (ghToken) variables.push('GH_TOKEN');
  if (githubToken) variables.push('GITHUB_TOKEN');
  const effective = ghToken || githubToken;
  const tokenSource: TokenSource = ghToken ? 'env:GH_TOKEN' : githubToken ? 'env:GITHUB_TOKEN' : 'none';
  return {
    present: variables.length > 0,
    variables,
    tokenType: classifyToken(effective),
    tokenSource,
  };
}

function runGh(args: readonly string[]) {
  return spawnSync('gh', [...args], {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_DEBUG: '',
    },
  });
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function parseHttpResponse(stdout: string, stderr: string): HttpResponse {
  let statusCode: number | null = null;
  let headers: Record<string, string> = {};
  let body = stdout.replace(/\r\n/g, '\n');

  while (/^HTTP\/\d+(?:\.\d+)?\s+(\d{3})/i.test(body.trimStart())) {
    const trimmed = body.trimStart();
    const separatorIdx = trimmed.indexOf('\n\n');
    const headerBlock = separatorIdx === -1 ? trimmed : trimmed.slice(0, separatorIdx);
    body = separatorIdx === -1 ? '' : trimmed.slice(separatorIdx + 2);

    const lines = headerBlock.split('\n');
    const statusLine = lines[0] ?? '';
    const statusMatch = statusLine.match(/^HTTP\/\d+(?:\.\d+)?\s+(\d{3})/i);
    statusCode = statusMatch ? Number(statusMatch[1]) : null;
    headers = {};
    for (const line of lines.slice(1)) {
      const colonIdx = line.indexOf(':');
      if (colonIdx <= 0) continue;
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
    }
  }

  if (statusCode === null) {
    const stderrStatus = stderr.match(/\(HTTP\s+(\d{3})\)/i);
    if (stderrStatus) {
      statusCode = Number(stderrStatus[1]);
    }
  }

  return {
    statusCode,
    headers,
    body,
    json: tryParseJsonObject(body),
  };
}

function extractMessage(json: Record<string, unknown> | null, stderr: string, envSecrets: readonly string[]): string | undefined {
  const jsonMsg = typeof json?.message === 'string' ? json.message.trim() : '';
  const stderrMsg = stderr.trim();
  const combined = jsonMsg || stderrMsg;
  return combined ? redactText(combined, envSecrets) : undefined;
}

function parseScopesList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter((part) => part.length > 0 && part.toLowerCase() !== 'none');
}

function parseAuthStatusOutput(text: string): {
  account: string | null;
  tokenType: TokenType;
  scopes: string[];
  loggedInMarker: boolean;
} {
  const loggedInMarker = /Logged in to\s+\S+/i.test(text) && !/not logged in/i.test(text);
  let account: string | null = null;
  const accountMatch = text.match(/Logged in to\s+\S+\s+(?:account|as)\s*([^\r\n]*)/i);
  if (accountMatch) {
    const cleaned = (accountMatch[1] ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    account = cleaned.length > 0 ? cleaned : null;
  }

  const tokenMatch = text.match(/^\s*(?:[-✓*•]\s*)?Token:\s*([^\s]+)/im);
  const tokenType = tokenMatch ? classifyToken(tokenMatch[1]) : 'none';

  const scopesMatch = text.match(/^\s*(?:[-✓*•]\s*)?Token scopes:\s*(.+)$/im);
  const scopes = scopesMatch ? parseScopesList(scopesMatch[1] ?? '') : [];

  return { account, tokenType, scopes, loggedInMarker };
}

function isNetworkFailureText(text: string): boolean {
  return /error connecting|dial tcp|tls handshake timeout|timed out|timeout|could not resolve|connection refused|econnrefused|enotfound|etimedout/i.test(
    text,
  );
}

function buildRemediation(report: DoctorReport): string[] {
  const steps: string[] = [];
  const add = (step: string) => {
    if (!steps.includes(step)) steps.push(step);
  };

  if (report.diagnosis === 'ok') return steps;

  if (report.diagnosis === 'gh_missing') {
    add('Install GitHub CLI: https://cli.github.com/');
    return steps;
  }

  const envUnset = report.auth.envOverride.present ? `unset ${report.auth.envOverride.variables.join(' ')}` : undefined;
  const authFailed =
    !report.checks.auth.ok && (report.checks.auth.code === 'unauthenticated' || report.checks.auth.code === 'invalid_token');
  const patUnsupported =
    report.checks.checks?.code === 'fine_grained_pat_unsupported' || report.checks.project?.code === 'fine_grained_pat_unsupported';
  const missingProjectScope = report.checks.project?.code === 'missing_project_scope';
  const forbidden =
    report.checks.checks?.code === 'checks_forbidden' ||
    report.checks.repo?.code === 'repo_forbidden' ||
    report.checks.project?.code === 'project_forbidden';

  if (envUnset && (authFailed || patUnsupported || missingProjectScope || forbidden)) {
    add(envUnset);
  }

  if (report.diagnosis === 'unauthenticated' || report.diagnosis === 'invalid_token' || patUnsupported) {
    add(`gh auth login -h ${report.host} -p https -w -s repo,read:org,project`);
  }

  if (missingProjectScope) {
    add(`gh auth refresh -h ${report.host} -s project`);
  }

  if (forbidden && !patUnsupported) {
    if (report.auth.tokenType === 'oauth' || report.auth.tokenType === 'classic_pat') {
      add(`gh auth refresh -h ${report.host} -s repo,read:org,project`);
    } else {
      add(`gh auth login -h ${report.host} -p https -w -s repo,read:org,project`);
    }
  }

  if (report.checks.repo?.code === 'repo_not_found') {
    add(`Verify repository ${report.checks.repo.repo} exists on ${report.host} and your account has read access.`);
  }

  if (report.checks.project?.code === 'project_not_found') {
    add(
      `Verify Project v2 #${report.checks.project.number} exists for ${report.checks.project.owner} on ${report.host} and your account has access.`,
    );
  }

  if (report.diagnosis === 'network_error') {
    add(`Check network connectivity to ${report.host} and retry.`);
  }

  if (steps.length === 0) {
    add(`gh auth status -h ${report.host}`);
  }

  return steps;
}

function selectDiagnosis(checks: DoctorReport['checks']): ProbeCode {
  const results: Array<{ ok: boolean; code: ProbeCode }> = [checks.auth];
  if (checks.repo) results.push(checks.repo);
  if (checks.checks) results.push(checks.checks);
  if (checks.project) results.push(checks.project);

  const failing = results.filter((entry) => !entry.ok);
  if (failing.length === 0) return 'ok';

  const priority: ProbeCode[] = [
    'gh_missing',
    'unauthenticated',
    'invalid_token',
    'fine_grained_pat_unsupported',
    'missing_project_scope',
    'checks_forbidden',
    'repo_forbidden',
    'project_forbidden',
    'repo_not_found',
    'project_not_found',
    'network_error',
    'api_error',
  ];

  for (const code of priority) {
    if (failing.some((entry) => entry.code === code)) return code;
  }
  return failing[0]?.code ?? 'api_error';
}

function formatHumanReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`${report.ok ? 'OK' : 'FAIL'} diagnosis=${report.diagnosis} host=${report.host}`);
  lines.push(
    `auth: loggedIn=${report.auth.loggedIn} account=${report.auth.account ?? '(none)'} source=${report.auth.tokenSource} type=${report.auth.tokenType} scopes=${report.auth.scopes.length ? report.auth.scopes.join(',') : '(none)'}`,
  );
  if (report.auth.missingAccountField) {
    lines.push('warning: gh_config entry is missing account field');
  }
  if (report.auth.envOverride.present) {
    lines.push(`envOverride: ${report.auth.envOverride.variables.join(',')} (${report.auth.envOverride.tokenType})`);
  }
  lines.push(
    `probe.auth: ${report.checks.auth.ok ? 'ok' : 'fail'} code=${report.checks.auth.code}${report.checks.auth.httpStatus !== null ? ` http=${report.checks.auth.httpStatus}` : ''}`,
  );
  if (report.checks.repo) {
    lines.push(
      `probe.repo: ${report.checks.repo.ok ? 'ok' : 'fail'} code=${report.checks.repo.code} repo=${report.checks.repo.repo}${report.checks.repo.httpStatus !== null ? ` http=${report.checks.repo.httpStatus}` : ''}`,
    );
  }
  if (report.checks.checks) {
    lines.push(
      `probe.checks: ${report.checks.checks.ok ? 'ok' : 'fail'} code=${report.checks.checks.code} repo=${report.checks.checks.repo} branch=${report.checks.checks.branch}${report.checks.checks.httpStatus !== null ? ` http=${report.checks.checks.httpStatus}` : ''}`,
    );
  }
  if (report.checks.project) {
    lines.push(
      `probe.project: ${report.checks.project.ok ? 'ok' : 'fail'} code=${report.checks.project.code} owner=${report.checks.project.owner} number=${report.checks.project.number} ownerType=${report.checks.project.ownerType ?? 'unknown'}`,
    );
  }
  if (report.remediation.length > 0) {
    lines.push('Remediation:');
    for (const step of report.remediation) {
      lines.push(`  ${step}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function finalizeReport(report: DoctorReport, jsonMode: boolean, envSecrets: readonly string[]): never {
  report.diagnosis = selectDiagnosis(report.checks);
  report.ok = report.diagnosis === 'ok';
  report.remediation = buildRemediation(report);

  if (jsonMode) {
    writeOut(`${JSON.stringify(report, null, 2)}\n`, envSecrets);
  } else {
    writeOut(formatHumanReport(report), envSecrets);
  }
  process.exit(report.ok ? 0 : 1);
}

function probeProject(
  opts: ParsedOptions,
  tokenType: TokenType,
  scopes: readonly string[],
  envSecrets: readonly string[],
): ProjectCheckResult {
  const owner = opts.projectOwner!;
  const number = opts.projectNumber!;
  const res = runGh([
    'api',
    'graphql',
    '--hostname',
    opts.host,
    '-f',
    `query=${PROJECT_V2_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-F',
    `number=${number}`,
  ]);

  const json = tryParseJsonObject(res.stdout ?? '');
  const fallbackOwnerType = opts.projectOwnerType === 'user' ? 'User' : opts.projectOwnerType === 'org' ? 'Organization' : null;

  if (!json) {
    const stderrText = res.stderr ?? '';
    if (/INSUFFICIENT_SCOPES|read:project|\bproject\b.*scope/i.test(stderrText)) {
      return {
        ok: false,
        code: 'missing_project_scope',
        owner,
        number,
        ownerType: fallbackOwnerType,
        projectId: null,
        message: redactText(stderrText.trim(), envSecrets),
      };
    }
    if (tokenType === 'fine_grained_pat' && /FORBIDDEN|Resource not accessible by personal access token/i.test(stderrText)) {
      return {
        ok: false,
        code: 'fine_grained_pat_unsupported',
        owner,
        number,
        ownerType: fallbackOwnerType,
        projectId: null,
        message: redactText(stderrText.trim(), envSecrets),
      };
    }
    return {
      ok: false,
      code: 'network_error',
      owner,
      number,
      ownerType: fallbackOwnerType,
      projectId: null,
      message: redactText((stderrText || res.error?.message || 'GraphQL request failed without JSON response').trim(), envSecrets),
    };
  }

  const data = typeof json.data === 'object' && json.data !== null ? (json.data as Record<string, unknown>) : null;
  const repoOwner =
    data && typeof data.repositoryOwner === 'object' && data.repositoryOwner !== null
      ? (data.repositoryOwner as Record<string, unknown>)
      : null;
  const resolvedOwnerType = typeof repoOwner?.__typename === 'string' ? repoOwner.__typename : fallbackOwnerType;
  const projectV2 =
    repoOwner && typeof repoOwner.projectV2 === 'object' && repoOwner.projectV2 !== null
      ? (repoOwner.projectV2 as Record<string, unknown>)
      : null;
  const projectId = typeof projectV2?.id === 'string' && projectV2.id.length > 0 ? projectV2.id : null;

  const rawErrors = Array.isArray(json.errors) ? json.errors : [];
  const errors = rawErrors.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);

  if (projectId !== null && errors.length === 0) {
    return {
      ok: true,
      code: 'ok',
      owner,
      number,
      ownerType: resolvedOwnerType,
      projectId,
    };
  }

  const errorTypes = errors.map((err) => (typeof err.type === 'string' ? err.type : ''));
  const errorMessages = errors.map((err) => (typeof err.message === 'string' ? err.message : '')).filter(Boolean);
  const combinedErrors = redactText(`${errorMessages.join('; ')} ${res.stderr ?? ''}`.trim(), envSecrets);

  const hasForbidden =
    errorTypes.includes('FORBIDDEN') || /Resource not accessible by personal access token|\bFORBIDDEN\b/i.test(combinedErrors);
  const hasInsufficientScope =
    errorTypes.includes('INSUFFICIENT_SCOPES') || /INSUFFICIENT_SCOPES|read:project|\bproject\b.*scope/i.test(combinedErrors);
  const lacksClassicProjectScope =
    (tokenType === 'oauth' || tokenType === 'classic_pat') &&
    scopes.length > 0 &&
    !scopes.includes('project') &&
    !scopes.includes('read:project');

  if (tokenType === 'fine_grained_pat' && (resolvedOwnerType === 'User' || hasForbidden)) {
    return {
      ok: false,
      code: 'fine_grained_pat_unsupported',
      owner,
      number,
      ownerType: resolvedOwnerType,
      projectId,
      message: combinedErrors || 'GitHub Fine-Grained PATs do not support User-owned Projects v2',
    };
  }

  if (hasInsufficientScope || lacksClassicProjectScope) {
    return {
      ok: false,
      code: 'missing_project_scope',
      owner,
      number,
      ownerType: resolvedOwnerType,
      projectId,
      message: combinedErrors || 'Token lacks project / read:project scope',
    };
  }

  if (projectV2 === null && !hasForbidden) {
    return {
      ok: false,
      code: 'project_not_found',
      owner,
      number,
      ownerType: resolvedOwnerType,
      projectId: null,
      message: combinedErrors || undefined,
    };
  }

  return {
    ok: false,
    code: hasForbidden ? 'project_forbidden' : 'api_error',
    owner,
    number,
    ownerType: resolvedOwnerType,
    projectId,
    message: combinedErrors || undefined,
  };
}

function main(): void {
  const envSecrets = collectEnvSecrets();
  const opts = parseArgs(process.argv.slice(2), envSecrets);
  const envInfo = inspectEnvOverride();

  const report: DoctorReport = {
    ok: false,
    diagnosis: 'ok',
    host: opts.host,
    auth: {
      loggedIn: false,
      account: null,
      missingAccountField: false,
      tokenSource: envInfo.tokenSource,
      tokenType: envInfo.tokenType,
      scopes: [],
      envOverride: {
        present: envInfo.present,
        variables: envInfo.variables,
        tokenType: envInfo.tokenType,
      },
    },
    checks: {
      auth: {
        ok: false,
        code: 'unauthenticated',
        httpStatus: null,
      },
    },
    remediation: [],
  };

  const versionRes = runGh(['--version']);
  if (versionRes.error || versionRes.status !== 0) {
    report.checks.auth = {
      ok: false,
      code: 'gh_missing',
      httpStatus: null,
      message: redactText(versionRes.error?.message || versionRes.stderr?.trim() || 'gh CLI not available', envSecrets),
    };
    finalizeReport(report, opts.json, envSecrets);
  }

  const statusRes = runGh(['auth', 'status', '--hostname', opts.host]);
  const statusText = `${statusRes.stdout ?? ''}\n${statusRes.stderr ?? ''}`;

  if (statusRes.error || (statusRes.status !== 0 && isNetworkFailureText(statusText))) {
    report.checks.auth = {
      ok: false,
      code: 'network_error',
      httpStatus: null,
      message: redactText(statusRes.error?.message || statusText.trim() || 'Network error running gh auth status', envSecrets),
    };
    finalizeReport(report, opts.json, envSecrets);
  }

  if (statusRes.status !== 0) {
    const invalidFromStatus = /the token .* is invalid|bad credentials|\(HTTP 401\)/i.test(statusText);
    report.checks.auth = {
      ok: false,
      code: invalidFromStatus ? 'invalid_token' : 'unauthenticated',
      httpStatus: invalidFromStatus ? 401 : null,
      message: redactText(statusText.trim(), envSecrets) || undefined,
    };
    finalizeReport(report, opts.json, envSecrets);
  }

  const parsedStatus = parseAuthStatusOutput(statusText);
  if (!parsedStatus.loggedInMarker && !envInfo.present) {
    report.checks.auth = {
      ok: false,
      code: 'unauthenticated',
      httpStatus: null,
      message: redactText(statusText.trim(), envSecrets) || undefined,
    };
    finalizeReport(report, opts.json, envSecrets);
  }

  report.auth.loggedIn = true;
  report.auth.account = parsedStatus.account ? redactText(parsedStatus.account, envSecrets) : null;
  report.auth.tokenSource = envInfo.tokenSource !== 'none' ? envInfo.tokenSource : 'gh_config';
  report.auth.missingAccountField = report.auth.tokenSource === 'gh_config' && report.auth.account === null;
  if (report.auth.tokenType === 'none') {
    report.auth.tokenType = parsedStatus.tokenType;
  }
  report.auth.scopes = parsedStatus.scopes;

  const userRes = runGh(['api', '--hostname', opts.host, '-i', '/user']);
  const userHttp = parseHttpResponse(userRes.stdout ?? '', userRes.stderr ?? '');

  const headerScopes = userHttp.headers['x-oauth-scopes'] ? parseScopesList(userHttp.headers['x-oauth-scopes']) : [];
  if (headerScopes.length > 0) {
    report.auth.scopes = Array.from(new Set([...report.auth.scopes, ...headerScopes]));
  }

  if (userRes.error || userHttp.statusCode === null) {
    report.checks.auth = {
      ok: false,
      code: 'network_error',
      httpStatus: null,
      message: redactText(userRes.error?.message || userRes.stderr?.trim() || 'Network error probing /user', envSecrets),
    };
    finalizeReport(report, opts.json, envSecrets);
  }

  if (userHttp.statusCode === 401 || /bad credentials/i.test(`${userHttp.body}\n${userRes.stderr ?? ''}`)) {
    report.checks.auth = {
      ok: false,
      code: 'invalid_token',
      httpStatus: 401,
      message: extractMessage(userHttp.json, userRes.stderr ?? '', envSecrets),
    };
    finalizeReport(report, opts.json, envSecrets);
  }

  if (userHttp.statusCode >= 400) {
    report.checks.auth = {
      ok: false,
      code: 'api_error',
      httpStatus: userHttp.statusCode,
      message: extractMessage(userHttp.json, userRes.stderr ?? '', envSecrets),
    };
    finalizeReport(report, opts.json, envSecrets);
  }

  const login = typeof userHttp.json?.login === 'string' && userHttp.json.login ? userHttp.json.login : null;
  report.checks.auth = {
    ok: true,
    code: 'ok',
    httpStatus: userHttp.statusCode,
    login,
  };

  if (opts.requireSet.has('repo') && opts.repo) {
    const repoRes = runGh(['api', '--hostname', opts.host, '-i', `/repos/${opts.repo}`]);
    const repoHttp = parseHttpResponse(repoRes.stdout ?? '', repoRes.stderr ?? '');

    if (repoRes.error || repoHttp.statusCode === null) {
      report.checks.repo = {
        ok: false,
        code: 'network_error',
        httpStatus: null,
        repo: opts.repo,
        message: redactText(repoRes.error?.message || repoRes.stderr?.trim() || 'Network error probing repo', envSecrets),
      };
    } else if (repoHttp.statusCode >= 200 && repoHttp.statusCode < 300) {
      const ownerObj =
        typeof repoHttp.json?.owner === 'object' && repoHttp.json.owner !== null ? (repoHttp.json.owner as Record<string, unknown>) : null;
      report.checks.repo = {
        ok: true,
        code: 'ok',
        httpStatus: repoHttp.statusCode,
        repo: opts.repo,
        defaultBranch:
          typeof repoHttp.json?.default_branch === 'string' && repoHttp.json.default_branch ? repoHttp.json.default_branch : 'main',
        private: typeof repoHttp.json?.private === 'boolean' ? repoHttp.json.private : null,
        ownerType: typeof ownerObj?.type === 'string' ? ownerObj.type : null,
      };
    } else {
      const code: ProbeCode = repoHttp.statusCode === 403 ? 'repo_forbidden' : repoHttp.statusCode === 404 ? 'repo_not_found' : 'api_error';
      report.checks.repo = {
        ok: false,
        code,
        httpStatus: repoHttp.statusCode,
        repo: opts.repo,
        message: extractMessage(repoHttp.json, repoRes.stderr ?? '', envSecrets),
      };
    }
  }

  if (opts.requireSet.has('checks') && opts.repo && (!report.checks.repo || report.checks.repo.ok)) {
    const targetBranch = opts.branch ?? report.checks.repo?.defaultBranch ?? 'main';
    const checksRes = runGh([
      'api',
      '--hostname',
      opts.host,
      '-i',
      `/repos/${opts.repo}/commits/${encodeURIComponent(targetBranch)}/check-runs?per_page=1`,
    ]);
    const checksHttp = parseHttpResponse(checksRes.stdout ?? '', checksRes.stderr ?? '');

    if (checksRes.error || checksHttp.statusCode === null) {
      report.checks.checks = {
        ok: false,
        code: 'network_error',
        httpStatus: null,
        repo: opts.repo,
        branch: targetBranch,
        message: redactText(checksRes.error?.message || checksRes.stderr?.trim() || 'Network error probing check-runs', envSecrets),
      };
    } else if (checksHttp.statusCode >= 200 && checksHttp.statusCode < 300) {
      report.checks.checks = {
        ok: true,
        code: 'ok',
        httpStatus: checksHttp.statusCode,
        repo: opts.repo,
        branch: targetBranch,
        totalCount: typeof checksHttp.json?.total_count === 'number' ? checksHttp.json.total_count : null,
      };
    } else if (checksHttp.statusCode === 403) {
      const acceptedPerms = checksHttp.headers['x-accepted-github-permissions'] ?? '';
      const msgText = extractMessage(checksHttp.json, checksRes.stderr ?? '', envSecrets) ?? '';
      const signalText = `${acceptedPerms}\n${msgText}\n${checksHttp.body}\n${checksRes.stderr ?? ''}`;
      const isChecksPatLimitation = /checks=read|Resource not accessible by personal access token/i.test(signalText);
      const code: ProbeCode =
        isChecksPatLimitation && report.auth.tokenType === 'fine_grained_pat' ? 'fine_grained_pat_unsupported' : 'checks_forbidden';
      report.checks.checks = {
        ok: false,
        code,
        httpStatus: 403,
        repo: opts.repo,
        branch: targetBranch,
        message: msgText || undefined,
      };
    } else {
      const code: ProbeCode = checksHttp.statusCode === 404 ? 'repo_not_found' : 'api_error';
      report.checks.checks = {
        ok: false,
        code,
        httpStatus: checksHttp.statusCode,
        repo: opts.repo,
        branch: targetBranch,
        message: extractMessage(checksHttp.json, checksRes.stderr ?? '', envSecrets),
      };
    }
  }

  if (opts.requireSet.has('project')) {
    report.checks.project = probeProject(opts, report.auth.tokenType, report.auth.scopes, envSecrets);
  }

  finalizeReport(report, opts.json, envSecrets);
}

main();
