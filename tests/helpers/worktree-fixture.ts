import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { TestContext } from 'vitest';

export type Json = Record<string, any>;

export interface RunOptions {
  task?: string;
  session?: string;
}

export const cli = fileURLToPath(new URL('../../bin/kitto.ts', import.meta.url));

export async function fixture(t: TestContext, objectFormat = 'sha1') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kitto-lifecycle-')));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    repo = join(root, 'repo'),
    scopes = join(home, 'data');
  const state = join(home, 'state');
  await mkdir(scopes, { recursive: true });
  await mkdir(repo);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_STATE_HOME: state,
    KITTO_HOME: scopes,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  function git(...args: string[]) {
    const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org', ...args], {
      cwd: repo,
      env,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }
  async function scope(workspaces = [repo]) {
    await writeFile(join(scopes, 'scopes.json'), JSON.stringify({ version: 1, global: true, workspaces }));
  }
  git('init', `--object-format=${objectFormat}`, '-b', 'main');
  await writeFile(join(repo, 'tracked'), 'base\n');
  await writeFile(join(repo, '.gitignore'), '*.ignored\n');
  git('add', '.');
  git('commit', '-m', 'Base');
  await scope();
  const args = (command: string, flags: string[] = [], { task = 'ticket-42', session = 'parent' }: RunOptions = {}) => [
    cli,
    'worktree',
    command,
    '--repo',
    repo,
    '--task',
    task,
    '--session',
    session,
    ...flags,
  ];
  function run(command: string, flags?: string[], options?: RunOptions, cwd: string = repo) {
    return spawnSync(process.execPath, args(command, flags, options), { cwd, env, encoding: 'utf8' });
  }
  function invoke(command: string, flags?: string[], options?: RunOptions) {
    const r = run(command, flags, options);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  }
  function start(options?: RunOptions) {
    const preview = invoke('start', [], options);
    return invoke('start', ['--confirm', preview.confirm], options);
  }
  function concurrently(command: string, flags?: string[], options?: RunOptions) {
    return new Promise<{ status: number | null; stderr: string; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args(command, flags, options), { cwd: repo, env });
      let stderr = '',
        stdout = '';
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
      });
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk;
      });
      child.once('error', reject).once('close', (status) => resolve({ status, stderr, stdout }));
    });
  }
  return { root, repo, state, git, scope, run, invoke, start, concurrently, env };
}
