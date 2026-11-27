import { spawnSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { executable } from './dependencies.mjs';
import { processAlive } from './process-alive.mjs';
import {
  composeAgents, exportMcp, extractAgents, listSharedPackages, loadJson, mergeMcp, mergeSettings, recordSettings, sanitizeSettings,
} from './pi-settings.mjs';

const color = { red: '\u001b[0;31m', green: '\u001b[0;32m', cyan: '\u001b[0;36m', yellow: '\u001b[0;33m', dim: '\u001b[2m', none: '\u001b[0m' };
const tag = (name, text, message) => `${color[name]}${text}${color.none}${message}`;
const info = message => console.log(tag('cyan', '[info]', ` ${message}`));
const ok = message => console.log(tag('green', '[ok]', `   ${message}`));
const same = message => console.log(tag('dim', '[=]', `    ${message}`));
const warn = message => console.log(tag('yellow', '[skip]', ` ${message}`));
const fail = message => console.log(tag('red', '[fail]', ` ${message}`));
const indent = lines => lines.map(line => `    ${line}`);

const platformName = platform => (platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : 'unknown');
const sameFileBytes = (a, b) => existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
const jsonOrNull = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const jsonSame = (a, b) => isDeepStrictEqual(jsonOrNull(a), jsonOrNull(b));
const managedFiles = (directory, suffix) => (existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(suffix)).sort() : []);

function subdirectories(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).filter(entry => {
    try { return statSync(join(directory, entry.name)).isDirectory(); } catch { return false; }
  }).map(entry => entry.name).sort();
}

function sameTree(a, b) {
  const left = readdirSync(a).sort(), right = readdirSync(b).sort();
  if (!isDeepStrictEqual(left, right)) return false;
  return left.every(name => {
    const x = join(a, name), y = join(b, name);
    const xs = statSync(x), ys = statSync(y);
    if (xs.isDirectory() !== ys.isDirectory()) return false;
    return xs.isDirectory() ? sameTree(x, y) : xs.isFile() && ys.isFile() && readFileSync(x).equals(readFileSync(y));
  });
}

function lockHolder(pid, isAlive) {
  if (!/^\d+$/.test(pid)) return 'unknown';
  const alive = isAlive(Number(pid));
  return alive === undefined ? 'unknown' : alive ? 'alive' : 'dead';
}

function acquireSyncLock(local, isAlive, onLock) {
  mkdirSync(local, { recursive: true });
  const lock = join(local, '.sync-lock');
  try { mkdirSync(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pidFile = join(lock, 'pid');
    const holder = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '';
    const state = holder ? lockHolder(holder, isAlive) : '';
    if (state === 'alive') fail(`另一个同步操作仍在运行（pid ${holder}）。等它结束后重试。`);
    else if (state === 'dead') fail(`残留的同步锁：pid ${holder} 已退出。重跑命令并加 --break-lock 自动清理，或 rm -rf ${lock}`);
    else if (holder) fail(`无法确认同步锁持有者（pid ${holder}）是否仍在运行。不要删除 ${lock}；确认该进程已结束后再手动处理。`);
    else fail(`${lock} 存在但没有 pid 记录（旧版 Kitto 留下的）。确认没有进程在写后 rm -rf ${lock}`);
    throw new Error('Pi sync lock is held.');
  }
  writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
  onLock?.(lock);
  return lock;
}

export function piAdapter(command, options) {
  const {
    source: root, piHome, agentsHome, dryRun = false, platform = process.platform, env = process.env,
    home = homedir(), isAlive = processAlive, onLock, onUnlock,
  } = options;
  if (!['status', 'pull', 'push'].includes(command)) throw new Error(`unknown command: ${command}`);
  const dry = dryRun && command !== 'status';
  const local = join(root, 'config/pi/local');
  const commonAgents = join(root, 'config/instructions/common.md');
  const piAgents = join(root, 'config/pi/AGENTS.md');
  const platformKey = platformName(platform);
  const childEnv = { ...env, PI_CODING_AGENT_DIR: piHome, PI_AGENTS_DIR: agentsHome };
  const temp = mkdtempSync(join(tmpdir(), 'kitto-pi-'));
  let lock = null;

  const run = (label, action) => {
    if (dry) info(`[dry-run] ${label}`);
    else action();
  };

  const showJsonDiff = (current, next, label) => {
    if (jsonSame(current, next)) { same(`${label}（内容一致，仅格式差异）`); return; }
    const result = spawnSync('diff', ['-u', current, next], { encoding: 'utf8' });
    const lines = (result.stdout ?? '').split('\n').slice(2, 60);
    if (lines.at(-1) === '') lines.pop();
    for (const line of indent(lines)) console.log(line);
  };

  const deployFile = (src, dst, label = dst) => {
    if (existsSync(dst) && statSync(dst).isFile() && sameFileBytes(src, dst)) { same(label); return; }
    info(`${existsSync(dst) && statSync(dst).isFile() ? 'update' : 'create'} ${label}`);
    run(`mkdir -p ${dirname(dst)}`, () => mkdirSync(dirname(dst), { recursive: true }));
    run(`cp -f ${src} ${dst}`, () => writeFileSync(dst, readFileSync(src), { mode: statSync(src).mode & 0o777 }));
  };

  const deployDirectory = (src, dst, label = dst) => {
    if (existsSync(dst) && lstatSync(dst).isSymbolicLink()) { warn(`${label} 是指向别处的软链，保持不动`); return; }
    const present = existsSync(dst) && statSync(dst).isDirectory();
    if (present && sameTree(src, dst)) { same(label); return; }
    info(`${present ? 'update' : 'create'} ${label}`);
    if (present) run(`rm -rf ${dst}`, () => rmSync(dst, { recursive: true, force: true }));
    run(`mkdir -p ${dirname(dst)}`, () => mkdirSync(dirname(dst), { recursive: true }));
    run(`cp -R ${src} ${dst}`, () => cpSync(src, dst, { recursive: true }));
  };

  const extensionSkipped = name => platformKey === 'linux' && name === 'herdr-agent-state.ts';

  const composeSource = out => {
    try { composeAgents(commonAgents, piAgents, out); } catch (error) {
      fail(`组合 ${commonAgents} 与 ${piAgents} 失败`);
      throw new Error(`Could not compose ${commonAgents} with ${piAgents}: ${error.message}`);
    }
    return out;
  };

  const stepPackages = () => {
    info('pi 扩展包');
    if (!executable('pi')) { warn('pi 未安装，跳过（先装 @earendil-works/pi-coding-agent）'); return; }
    const packages = listSharedPackages(join(root, 'config/pi/settings.json'), join(local, 'packages.skip.txt'));
    const installed = spawnSync('pi', ['list'], { encoding: 'utf8', env: childEnv }).stdout ?? '';
    for (const item of packages) {
      if (!item) continue;
      if (installed.includes(item)) { same(item); continue; }
      info(`pi install ${item}`);
      run(`pi install ${item}`, () => {
        const result = spawnSync('pi', ['install', item], { stdio: 'inherit', env: childEnv });
        if (result.error || result.status !== 0) {
          fail(`pi install ${item} 失败`);
          throw new Error(`pi install ${item} failed`);
        }
      });
    }
  };

  const stepSettings = () => {
    const out = join(piHome, 'settings.json');
    const target = dry ? join(temp, 'settings.json') : out;
    const repo = join(root, 'config/pi/settings.json');
    info('settings.json');
    const lines = mergeSettings(repo, out, local, target);
    if (dry && existsSync(out)) showJsonDiff(out, target, 'settings.json');
    else for (const line of lines) console.log(line);
    if (!dry) recordSettings(repo, out, local);
  };

  const stepMcp = () => {
    const out = join(piHome, 'mcp.json');
    const target = dry ? join(temp, 'mcp.json') : out;
    info('mcp.json');
    const lines = mergeMcp(join(root, 'config/pi/mcp.json'), join(root, 'config/pi/platform', platformKey, 'mcp.json'),
      join(local, 'mcp.json'), out, target);
    for (const line of lines) console.log(line);
    const privatePath = join(root, 'config/pi/mcp.private.json');
    if (existsSync(privatePath) && !readFileSync(privatePath, 'utf8').includes('YOUR_')) {
      for (const line of indent(mergeMcp(target, privatePath, '', '', target))) console.log(line);
    } else if (existsSync(privatePath)) warn('mcp.private.json 还含 YOUR_* 占位符，跳过');
    if (dry && existsSync(out)) showJsonDiff(out, target, 'mcp.json');
  };

  const stepExtensions = () => {
    info('extensions');
    for (const name of managedFiles(join(root, 'config/pi/extensions'), '.ts')) {
      if (extensionSkipped(name)) { warn(`${name}（${platformKey} 不适用）`); continue; }
      deployFile(join(root, 'config/pi/extensions', name), join(piHome, 'extensions', name), `~/.pi/agent/extensions/${name}`);
    }
  };

  const stepEnv = () => {
    info('环境变量');
    const envFile = join(home, '.pi-agent-env');
    let present = existsSync(envFile);
    if (!present) try { lstatSync(envFile); present = true; } catch {}
    if (present) same('~/.pi-agent-env（保留本机内容）');
    else {
      deployFile(join(root, 'config/env.example'), envFile, '~/.pi-agent-env');
      run(`chmod 600 ${envFile}`, () => chmodSync(envFile, 0o600));
    }
    const shell = basename(env.SHELL ?? '');
    let rc;
    if (shell === 'zsh') rc = join(env.ZDOTDIR || home, '.zshrc');
    else if (shell === 'bash') rc = join(home, '.bashrc');
    else { warn('请在你的 shell 启动文件中加载 ~/.pi-agent-env'); return; }
    if (!existsSync(rc) || !statSync(rc).isFile()) { warn(`启动文件不存在，请手动配置 ${rc} 加载 ~/.pi-agent-env`); return; }
    if (!readFileSync(rc, 'utf8').includes('pi-agent-env')) {
      info(`在 ${basename(rc)} 里加 source ~/.pi-agent-env`);
      if (dry) info(`[dry-run] append source line to ${rc}`);
      else appendFileSync(rc, '\n# pi-config: MCP / provider tokens\n[ -f "$HOME/.pi-agent-env" ] && . "$HOME/.pi-agent-env"\n');
    }
  };

  const pull = () => {
    console.log(`\n${tag('cyan', '==> pull', `  仓库 ${root} -> 本机 ${piHome} (platform: ${platformKey})`)}\n`);
    run(`mkdir -p ${local} ${join(piHome, 'extensions')}`, () => {
      mkdirSync(local, { recursive: true });
      mkdirSync(join(piHome, 'extensions'), { recursive: true });
    });
    stepPackages();
    stepSettings();
    stepMcp();
    deployFile(composeSource(join(temp, 'AGENTS.md')), join(piHome, 'AGENTS.md'), '~/.pi/agent/AGENTS.md');
    deployFile(join(root, 'config/pi/i-have-adhd-always'), join(piHome, '.i-have-adhd-always'), '~/.pi/agent/.i-have-adhd-always');
    stepExtensions();
    stepEnv();
    console.log('');
    if (dry) ok('dry-run 结束，未落盘');
    else {
      ok('pull 完成（新会话或 /reload 生效）');
      if (executable('pi')) info('校验: pi list && pi mcp list');
    }
  };

  const push = () => {
    console.log(`\n${tag('cyan', '==> push', `  本机 ${piHome} -> 仓库 ${root} (platform: ${platformKey}, host: ${hostname().split('.')[0]})`)}\n`);
    if (!existsSync(join(piHome, 'settings.json'))) { fail('本机没有 settings.json'); throw new Error('The machine has no settings.json to export.'); }
    info('AGENTS.md（只导出 Pi 专属段）');
    try { console.log(extractAgents(join(piHome, 'AGENTS.md'), commonAgents, join(temp, 'AGENTS.md'))); } catch (error) {
      fail('AGENTS.md 未按共享层组合，拒绝把 common 写回 config/pi/AGENTS.md');
      throw new Error(`Refusing to export AGENTS.md: ${error.message}`);
    }
    info('settings.json（脱敏）');
    const repoSettings = join(root, 'config/pi/settings.json');
    const settingsTarget = dry ? join(temp, 'settings.json') : repoSettings;
    for (const line of sanitizeSettings(join(piHome, 'settings.json'), repoSettings, local, settingsTarget)) console.log(line);
    if (dry) showJsonDiff(repoSettings, settingsTarget, 'config/pi/settings.json');
    deployFile(join(temp, 'AGENTS.md'), piAgents, 'config/pi/AGENTS.md');
    if (existsSync(join(piHome, 'mcp.json'))) {
      info('mcp.json（去掉平台/本机/私有条目）');
      const repoMcp = join(root, 'config/pi/mcp.json');
      const mcpTarget = dry ? join(temp, 'mcp.json') : repoMcp;
      for (const line of exportMcp(repoMcp, join(piHome, 'mcp.json'), join(root, 'config/pi/platform', platformKey, 'mcp.json'),
        join(local, 'mcp.json'), join(root, 'config/pi/mcp.private.json'), mcpTarget)) console.log(line);
      if (dry) showJsonDiff(repoMcp, mcpTarget, 'config/pi/mcp.json');
    }
    for (const name of managedFiles(join(piHome, 'extensions'), '.ts')) {
      if (!statSync(join(piHome, 'extensions', name)).isFile()) continue;
      if (!existsSync(join(root, 'config/pi/extensions', name))) { warn(`${name}（未托管，跳过）`); continue; }
      if (name === 'herdr-agent-state.ts') { warn(`${name}（herdr 托管，不入库）`); continue; }
      deployFile(join(piHome, 'extensions', name), join(root, 'config/pi/extensions', name), `config/pi/extensions/${name}`);
    }
    for (const name of subdirectories(join(agentsHome, 'skills'))) {
      const dir = join(agentsHome, 'skills', name);
      if (lstatSync(dir).isSymbolicLink()) { warn(`${name}（软链，跳过）`); continue; }
      if (!existsSync(join(root, 'skills', name, 'SKILL.md'))) { warn(`${name}（未托管，跳过）`); continue; }
      deployDirectory(dir, join(root, 'skills', name), `skills/${name}`);
    }
    console.log('');
    if (dry) { info(`[dry-run] git -C ${root} status --short`); return; }
    spawnSync('git', ['-C', root, 'status', '--short'], { stdio: 'inherit' });
    info('确认无误后检查 Git 差异再提交');
  };

  const status = () => {
    const row = (name, mark, label) => console.log(`  ${color[name]}${mark}${color.none}  ${label}`);
    console.log(`\n${tag('cyan', '==> status', `  platform: ${platformKey}`)}`);
    console.log(`    repo: ${root}\n    pi:   ${piHome}\n    env:  ${join(home, '.pi-agent-env')}\n`);
    info('托管文件');
    const settings = join(piHome, 'settings.json');
    if (!existsSync(settings)) row('yellow', 'missing', 'settings.json');
    else {
      mergeSettings(join(root, 'config/pi/settings.json'), settings, local, join(temp, 's.json'));
      if (jsonSame(settings, join(temp, 's.json'))) row('dim', '=', 'settings.json');
      else row('red', 'differs', 'settings.json（pull 会更新）');
    }
    const mcp = join(piHome, 'mcp.json');
    if (!existsSync(mcp)) row('yellow', 'missing', 'mcp.json');
    else {
      mergeMcp(join(root, 'config/pi/mcp.json'), join(root, 'config/pi/platform', platformKey, 'mcp.json'), join(local, 'mcp.json'),
        mcp, join(temp, 'm.json'));
      if (jsonSame(mcp, join(temp, 'm.json'))) row('dim', '=', 'mcp.json');
      else row('red', 'differs', 'mcp.json（pull 会更新）');
    }
    const agents = join(piHome, 'AGENTS.md');
    if (!existsSync(agents)) row('yellow', 'missing', 'AGENTS.md');
    else if (sameFileBytes(composeSource(join(temp, 'AGENTS.md')), agents)) row('dim', '=', 'AGENTS.md');
    else row('red', 'differs', 'AGENTS.md（pull 会更新）');
    if (!existsSync(join(home, '.pi-agent-env'))) row('yellow', 'missing', '~/.pi-agent-env');
    else row('dim', 'local', '~/.pi-agent-env（保留本机内容）');
    for (const name of managedFiles(join(root, 'config/pi/extensions'), '.ts')) {
      if (extensionSkipped(name)) continue;
      const deployed = join(piHome, 'extensions', name);
      if (!existsSync(deployed)) row('yellow', 'missing', `extensions/${name}`);
      else if (!sameFileBytes(join(root, 'config/pi/extensions', name), deployed)) row('red', 'differs', `extensions/${name}`);
    }
    for (const name of subdirectories(join(root, 'skills'))) {
      const deployed = join(agentsHome, 'skills', name);
      if (!existsSync(deployed)) row('yellow', 'missing', `skills/${name}`);
      else if (!sameTree(join(root, 'skills', name), deployed)) row('red', 'differs', `skills/${name}`);
    }
    console.log('');
    info('包');
    const stripped = path => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').map(line => line.split('#', 1)[0].trim()).filter(Boolean) : []);
    const label = item => (typeof item === 'string' ? item : item?.source ?? '');
    const repoPackages = (loadJson(join(root, 'config/pi/settings.json'), {}) ?? {}).packages ?? [];
    const machinePackages = (jsonOrNull(settings) ?? {}).packages ?? [];
    const extra = new Set(stripped(join(local, 'packages.txt'))), skip = new Set(stripped(join(local, 'packages.skip.txt')));
    const repoNames = new Set(repoPackages.map(label)), machineNames = new Set(machinePackages.map(label));
    for (const item of repoPackages) {
      const name = label(item);
      const mark = skip.has(name) ? 'skip' : machineNames.has(name) ? 'installed' : 'MISSING';
      console.log(`  ${mark.padEnd(9)} ${name}${skip.has(name) ? '  [machine skip]' : ''}`);
    }
    for (const item of machinePackages) {
      const name = label(item);
      if (!repoNames.has(name) && !extra.has(name)) console.log(`  ${'local?'.padEnd(9)} ${name}  (不在仓库, 不在 local/packages.txt)`);
    }
    for (const name of [...extra].sort()) console.log(`  ${'local'.padEnd(9)} ${name}  [config/pi/local/packages.txt]`);
    console.log('');
    info('MCP');
    const servers = (jsonOrNull(mcp) ?? {}).mcpServers ?? {};
    if (!Object.keys(servers).length) console.log('  (无)');
    for (const [name, entry] of Object.entries(servers)) {
      const state = entry.enabled ?? true ? 'on ' : 'off';
      console.log(`  ${state} ${name.padEnd(22)} ${entry.enabled === false ? 'platform/local' : 'shared'}`);
    }
    console.log('');
    info('git');
    spawnSync('git', ['-C', root, 'status', '--short'], { stdio: 'inherit' });
    console.log('');
  };

  try {
    if (!dry && command !== 'status') lock = acquireSyncLock(local, isAlive, onLock);
    ({ pull, push, status })[command]();
  } finally {
    rmSync(temp, { recursive: true, force: true });
    if (lock) {
      onUnlock?.(lock);
      rmSync(lock, { recursive: true, force: true });
    }
  }
}
