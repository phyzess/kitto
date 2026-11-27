import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, cpSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnSyncReturns } from 'node:child_process';
import type { TestContext } from 'vitest';
import { list } from '../../lib/ownership.ts';
import type { OwnershipStatus } from '../../lib/ownership.ts';
import type { State } from '../../types/kitto.d.ts';

export interface Fixture {
  temp: string;
  home: string;
  source: string;
  env: NodeJS.ProcessEnv;
  cli: (...args: string[]) => SpawnSyncReturns<string>;
  maintain: (...args: string[]) => SpawnSyncReturns<string>;
  log: string;
}

export const skillNames = (state: State, group: string, status: OwnershipStatus) =>
  list(state, 'skill', group, status)
    .map((entry) => entry.name)
    .sort();
export const re = (value: string) => value.replace(/[.+]/g, '\\$&');
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const dist = join(root, 'dist');
export const publishRoot = existsSync(join(root, 'dist/package.json')) ? join(root, 'dist') : root;
export const cliTimeout = 180_000;
export function command(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string = root): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, { env, cwd, encoding: 'utf8', timeout: cliTimeout });
}
export function fixture(t: Pick<TestContext, 'onTestFinished'>): Fixture {
  const temp = mkdtempSync(join(tmpdir(), "kitto's test "));
  t.onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, 'home'),
    source = join(temp, 'source'),
    bin = join(temp, 'bin');
  for (const dir of [home, bin, join(source, 'config/pi'), join(source, 'config/instructions'), join(source, 'skills/example')])
    mkdirSync(dir, { recursive: true });
  const files = {
    'config/pi/settings.json': '{"packages": []}',
    'config/pi/mcp.json': '{"mcpServers": {}}',
    'config/pi/AGENTS.md': 'Pi instructions',
    'config/pi/i-have-adhd-always': '',
    'config/instructions/common.md':
      '# 共享规则\n\n- shared-marker: 先检查工具，CodeGraph 可用时优先。\n- 每次会话开始先加载 `i-have-adhd` skill。\n- 每次会话开始先加载 `hindsight` skill。\n',
    'config/env.example': '# no secrets',
    'skills/example/SKILL.md': '---\nname: example\ndescription: Example task\n---\nExample body',
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(source, name), content);
  const log = join(temp, 'calls.jsonl');
  for (const name of ['pi', 'codex', 'dsh', 'pnpm', 'codegraph']) {
    writeFileSync(join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(join(root, 'tests/helpers/fake-agent.cjs'))});\n`, {
      mode: 0o755,
    });
  }
  const env = {
    ...process.env,
    HOME: home,
    KITTO_HOME: join(home, 'kitto'),
    PATH: `${bin}:${process.env.PATH}`,
    CALL_LOG: log,
    PI_CODING_AGENT_DIR: join(home, 'pi'),
    PI_AGENTS_DIR: join(home, '.agents'),
    DSH_AGENTS_HOME: join(home, '.agents'),
    DSH_HOME: join(home, 'dsh'),
    CODEX_HOME: join(home, 'codex'),
    FAKE_CODEX_STATE: join(home, 'codex/_fake-codex.json'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    MISE_STATE_DIR: join(temp, 'mise/state'),
    MISE_CACHE_DIR: join(temp, 'mise/cache'),
    MISE_DATA_DIR: join(temp, 'mise/data'),
  };
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'user.name', 'Test'],
    ['add', '.'],
    ['commit', '-m', 'fixture'],
  ]) {
    const result = command('git', args, env, source);
    assert.equal(result.status, 0, result.stderr);
  }
  const cli = (...args: string[]) => command(process.execPath, [join(dist, 'bin/kitto.mjs'), ...args], env);
  const maintain = (...args: string[]) => command(process.execPath, [join(env.KITTO_HOME, 'runtime/bin/maintain.mjs'), ...args], env);
  return { temp, home, source, env, cli, maintain, log };
}
export const good = (result: SpawnSyncReturns<string>) => assert.equal(result.status, 0, result.stdout + result.stderr);
export const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
export function callsOf(f: Pick<Fixture, 'log'>): unknown[] {
  if (!existsSync(f.log)) return [];
  return readFileSync(f.log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
export function snapshot(directory: string): string[] | null {
  if (!existsSync(directory)) return null;
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .map((name) => {
      const path = join(directory, name);
      return lstatSync(path).isDirectory() ? `dir:${name}` : `file:${name}:${readFileSync(path, 'utf8')}`;
    })
    .sort();
}
export function release(f: Pick<Fixture, 'temp' | 'env'>, version: string, operation = 'setup') {
  const directory = join(f.temp, version);
  mkdirSync(directory);
  for (const name of ['package.json', 'bin', 'lib', 'integration', 'CHANGELOG.md']) {
    cpSync(join(dist, name), join(directory, name), { recursive: true });
  }
  for (const name of ['package.json', 'integration/plugin.json']) {
    const file = join(directory, name),
      data = readJson(file);
    data.version = version;
    writeFileSync(file, JSON.stringify(data));
  }
  return (...args: string[]) => command(process.execPath, [join(directory, 'bin/kitto.mjs'), operation, ...args], f.env);
}
export const bootstrapMarkerFor = (source: string) => join(source, '.git', 'kitto-bootstrap.json');
export function withRemote(f: Pick<Fixture, 'temp' | 'env' | 'source'>): string {
  const mirror = join(f.temp, 'remote.git');
  good(command('git', ['clone', '--bare', f.source, mirror], f.env));
  good(command('git', ['remote', 'add', 'origin', mirror], f.env, f.source));
  good(command('git', ['push', '-u', 'origin', 'main'], f.env, f.source));
  return mirror;
}
export function commitAll(f: Pick<Fixture, 'env' | 'source'>, message = 'update'): void {
  for (const args of [
    ['add', '.'],
    ['commit', '-m', message],
  ])
    good(command('git', args, f.env, f.source));
}
export function mirrorOf(f: Pick<Fixture, 'temp' | 'env' | 'source'>, ...urls: string[]) {
  if (!urls.length) urls = ['https://kitto.invalid/config.git'];
  const mirror = join(f.temp, 'remote.git');
  good(command('git', ['clone', '--bare', f.source, mirror], f.env));
  const config = join(f.temp, 'gitconfig');
  writeFileSync(config, '');
  f.env.GIT_CONFIG_GLOBAL = config;
  for (const url of urls) good(command('git', ['config', '--add', '--file', config, `url.${mirror}.insteadOf`, url], f.env));
  return { mirror, config, url: urls[0] };
}
