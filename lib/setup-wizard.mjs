import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isDesktopProfile, normalizeDshProfile } from './dsh-profile.mjs';
import { setupPrompts } from './setup-prompts.mjs';
import { promisify } from 'node:util';

const agents = ['pi', 'codex', 'dsh'];
const names = { pi: 'Pi', codex: 'Codex', dsh: 'DeepSeek Harness (DSH)' };
const serviceUnit = 'dsh.service';
const exec = promisify(execFile);

async function detectEnvironment() {
  async function works(command, args) {
    try {
      await exec(command, args, { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
  const [detected, pnpmAvailable, serviceActive] = await Promise.all([
    Promise.all(agents.map(name => works(name, ['--version']))),
    works('pnpm', ['--version']),
    process.platform === 'linux' && works('/usr/bin/systemctl', ['--system', 'is-active', '--quiet', serviceUnit]),
  ]);
  return {
    available: agents.filter((_, index) => detected[index]),
    pnpmAvailable,
    serviceActive,
    canConfigureService: process.getuid?.() === 0 && process.geteuid?.() === 0,
  };
}

function expandHome(path) {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
}

async function configure({ input, output, environment, execute, probeServicePnpm }) {
  const { print, hosts, select, text, yesNo, close } = await setupPrompts(input, output);
  try {
    const { available, pnpmAvailable, serviceActive, canConfigureService } = environment;
    const serviceAvailable = serviceActive && canConfigureService;
    const defaults = agents.filter(agent => available.includes(agent) || (agent === 'dsh' && serviceAvailable));
    print('Kitto 环境安装向导');
    print('为选中的宿主配置当前账号的共享规则与 skills。按 Ctrl+C 可取消。');
    const hostOptions = agents.map(value => ({
      value, label: names[value],
      hint: value === 'dsh' && serviceAvailable ? serviceUnit : available.includes(value) ? '已安装 CLI' : '未检测到 CLI',
    }));
    if (serviceActive) {
      print('检测到正在运行的系统服务 dsh.service。' +
        (canConfigureService ? '可以配置服务账号。' : '需要 root 权限才能配置服务账号。'));
    }

    let selected;
    let unit;
    let installAgents;
    let dshProfile = 'web';
    let dshProfileAsked = false;
    while (true) {
      selected = await hosts(hostOptions, defaults);
      if (!selected?.length) return undefined;

      unit = undefined;
      if (selected.includes('dsh') && serviceAvailable) {
        const useService = await yesNo('配置 dsh.service 使用的 DSH 账号？', true);
        if (useService === undefined) return undefined;
        if (useService) unit = serviceUnit;
      }

      if (selected.includes('dsh') && !dshProfileAsked) {
        dshProfile = await text('DSH 配置档名称（desktop 由 Desktop 应用管理，仅部署全局规则/skills）', {
          initialValue: 'web',
          validate: value => {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) return '请输入有效的 DSH 配置档名称';
            if (unit && value.toLowerCase() === 'desktop') return '系统服务不能使用 desktop 配置档';
          },
        });
        if (dshProfile === undefined) return undefined;
        dshProfile = normalizeDshProfile(dshProfile);
        dshProfileAsked = true;
        if (isDesktopProfile(dshProfile)) {
          print('DSH Desktop 由 App 管理：Kitto 只部署全局 AGENTS.md 和 skills；不安装 bundle、不写 profile patch、不需要 pnpm。');
        }
      }

      const desktopDsh = selected.includes('dsh') && isDesktopProfile(dshProfile);
      const missing = selected.filter(agent => !available.includes(agent) &&
        !(agent === 'dsh' && (unit || desktopDsh)));
      if (desktopDsh && !available.includes('dsh')) {
        print('DSH Desktop 不要求本机 dsh CLI：Kitto 不会用 npm 补装它。');
      }
      installAgents = false;
      if (missing.length) {
        installAgents = await yesNo(`补装 ${missing.map(agent => names[agent]).join('、')}？`, true);
        if (installAgents === undefined) return undefined;
        if (!installAgents) continue;
      }
      break;
    }

    print('完整配置包含仓库的 AGENTS.md、skills 和所选宿主的 Kitto 集成。选择 Pi 时还会同步 Pi 包、扩展和 MCP 设置。');
    let source;
    let serviceInstallAgents;
    let servicePnpmAvailable;
    while (true) {
      const sourceChoice = await select('选择配置来源', [
        { value: '1', label: '默认 Kitto 配置', hint: '优先复用已有安装' },
        { value: '2', label: '指定配置仓库路径或 Git URL' },
        { value: '3', label: '仅配置共享规则与 skills' },
        { value: '0', label: '取消' },
      ], '1');
      if (sourceChoice === undefined || sourceChoice === '0') return;

      if (sourceChoice === '3' && isDesktopProfile(dshProfile) && selected.includes('dsh')) {
        print('DSH Desktop 需要配置来源才能部署全局规则与 skills，不能选择「仅配置共享规则与 skills」。请选择 1 或 2，或改用 web 配置档。');
        continue;
      }

      const needsPnpm = sourceChoice !== '3' && selected.includes('dsh') && !unit && !isDesktopProfile(dshProfile) && pnpmAvailable === false;
      if (needsPnpm) {
        const installPnpm = await yesNo('本机 DSH 的完整配置需要 pnpm。允许补装 pnpm？', true);
        if (installPnpm === undefined) return;
        if (!installPnpm) {
          print('可选择仅配置共享规则与 skills。');
          continue;
        }
        installAgents = true;
      }

      if (unit && sourceChoice !== '3' && !isDesktopProfile(dshProfile)) {
        servicePnpmAvailable ??= await probeServicePnpm(unit);
        if (servicePnpmAvailable === false) {
          const installPnpm = await yesNo(`服务 ${unit} 的完整配置需要 pnpm。允许在服务账号中补装 pnpm？`, true);
          if (installPnpm === undefined) return;
          if (!installPnpm) {
            print('可选择仅配置共享规则与 skills。');
            continue;
          }
          serviceInstallAgents = true;
        }
      }

      if (sourceChoice === '2') {
        const path = await text('配置仓库路径或 Git URL', { validate: value => value ? undefined : '请输入路径或 Git URL' });
        if (path === undefined) return;
        source = expandHome(path);
      } else if (sourceChoice === '3') {
        source = false;
      }
      break;
    }

    const deps = source === false ? false : await yesNo('安装配置中声明的辅助工具和依赖？', false);
    if (deps === undefined) return undefined;
    const workspace = await text('工作区父目录（可选）。例如未来项目会放在 ~/workspaces/workspace-1 下，就填 ~/workspaces。留空使用全局配置。');
    if (workspace === undefined) return undefined;

    const plan = {
      agents: selected, source, installAgents, deps, workspace: workspace ? expandHome(workspace) : undefined,
      unit, dshProfile,
    };
    if (serviceInstallAgents) plan.serviceInstallAgents = true;
    print('安装计划');
    print(`  宿主  ${selected.map(agent => names[agent]).join('、')}`);
    print(`  配置来源  ${source === false ? '仅配置共享规则与 skills' : source ?? '默认 Kitto 配置'}`);
    print('  共享范围  全局' + (plan.workspace ? `，以及工作区 ${plan.workspace}` : ''));
    if (selected.includes('dsh')) {
      print(`  DSH  ${unit ?? '当前账号'}，配置档 ${dshProfile}${isDesktopProfile(dshProfile) ? '（由 App 管理，仅全局规则/skills）' : ''}`);
    }
    print(`  补装缺少的宿主和必需工具  ${installAgents ? '是' : '否'}`);
    if (selected.includes('dsh') && isDesktopProfile(dshProfile)) {
      print('  DSH Desktop 不检查、也不补装本机 dsh CLI（由 App 管理）。');
    }
    if (serviceInstallAgents) print(`  为 ${unit} 的账号补装 pnpm  是`);
    if (source !== false) print(`  安装配置声明的辅助依赖  ${deps ? '是' : '否'}`);

    let action = await select('下一步', [
      { value: '1', label: '预览' }, { value: '2', label: '安装' }, { value: '0', label: '取消' },
    ], '1');
    if (action === '1') {
      await execute({ ...plan, dryRun: true });
      action = await select('预览完成', [
        { value: '0', label: '退出' }, { value: '2', label: '按此计划安装' },
      ], '0');
      if (action !== '2') {
        print('已退出，未执行安装。');
        return true;
      }
    }
    if (action !== '2') return;
    close();
    await execute({ ...plan, dryRun: false });
    return true;
  } finally {
    close();
  }
}

export async function runWizard({
  input = process.stdin, output = process.stdout, detect = detectEnvironment, execute,
  probeServicePnpm = async unit => {
    const { servicePnpmAvailable } = await import('./scope-service.mjs');
    return servicePnpmAvailable(unit);
  },
} = {}) {
  const runSetup = execute ?? (async plan => {
    const { runEnvironmentSetup } = await import('./environment-setup.mjs');
    await runEnvironmentSetup(plan);
  });
  const handled = await configure({ input, output, environment: await detect(), execute: runSetup, probeServicePnpm });
  if (!handled) output.write('已取消安装。\n');
}
