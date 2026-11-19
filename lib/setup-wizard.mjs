import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
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
  const terminal = Boolean(input.isTTY && output.isTTY);
  const rl = createInterface({ input, output, terminal });
  const lines = rl[Symbol.asyncIterator]();
  let interrupted = false;
  rl.on('SIGINT', () => {
    interrupted = true;
    rl.close();
  });
  const print = line => output.write(line + '\n');

  async function ask(prompt) {
    if (interrupted) return undefined;
    if (terminal) {
      rl.setPrompt(prompt + ' ');
      rl.prompt();
    } else {
      output.write(prompt + ' ');
    }
    const reply = await lines.next();
    return interrupted || reply.done ? undefined : reply.value.trim();
  }

  async function choose(prompt, parse) {
    while (true) {
      const answer = await ask(prompt);
      if (answer === undefined) return undefined;
      const choice = parse(answer);
      if (choice !== undefined) return choice;
      print('输入无效，请重试。');
    }
  }

  async function yesNo(prompt, defaultValue) {
    return choose(prompt + (defaultValue ? ' [Y/n]' : ' [y/N]'), answer => {
      if (!answer) return defaultValue;
      if (/^(y|yes|是)$/i.test(answer)) return true;
      if (/^(n|no|否)$/i.test(answer)) return false;
    });
  }

  try {
    const { available, pnpmAvailable, serviceActive, canConfigureService } = environment;
    const serviceAvailable = serviceActive && canConfigureService;
    const defaults = agents.filter(agent => available.includes(agent) || (agent === 'dsh' && serviceAvailable));
    print('Kitto 环境安装向导');
    print('为选中的宿主配置当前账号的共享规则与 skills。按 Ctrl+C 可取消。');
    for (const [index, agent] of agents.entries()) {
      print(`  ${index + 1}. ${names[agent]}（${available.includes(agent) ? '已安装 CLI' : '未检测到 CLI'}）`);
    }
    if (serviceActive) {
      print('检测到正在运行的系统服务 dsh.service。' +
        (canConfigureService ? '可以配置服务账号。' : '需要 root 权限才能配置服务账号。'));
    }

    let selected;
    let unit;
    let installAgents;
    while (true) {
      selected = await choose(
        `选择宿主，可用逗号分隔编号或名称${defaults.length ? ` [${defaults.join(',')}]` : ''}，输入 0 取消。`,
        answer => {
          if (answer === '0') return [];
          if (!answer && defaults.length) return defaults;
          const items = answer.toLowerCase().split(/[,，\s]+/).filter(Boolean);
          const chosen = items.map(item => /^[1-3]$/.test(item) ? agents[Number(item) - 1] : item);
          if (chosen.length && chosen.every(item => agents.includes(item))) return [...new Set(chosen)];
        },
      );
      if (!selected?.length) return undefined;

      unit = undefined;
      if (selected.includes('dsh') && serviceAvailable) {
        const useService = await yesNo('配置 dsh.service 使用的 DSH 账号？', true);
        if (useService === undefined) return undefined;
        if (useService) unit = serviceUnit;
      }

      const missing = selected.filter(agent => !available.includes(agent) && !(agent === 'dsh' && unit));
      installAgents = false;
      if (missing.length) {
        installAgents = await yesNo(`补装 ${missing.map(agent => names[agent]).join('、')}？`, true);
        if (installAgents === undefined) return undefined;
        if (!installAgents) continue;
      }
      break;
    }

    print('配置来源');
    print('完整配置包含仓库的 AGENTS.md、skills 和所选宿主的 Kitto 集成。选择 Pi 时还会同步 Pi 包、扩展和 MCP 设置。');
    print('  1. 使用默认 Kitto 配置，优先复用已有安装');
    print('  2. 指定配置仓库路径或 Git URL');
    print('  3. 仅配置共享规则与 skills');
    let source;
    let serviceInstallAgents;
    let servicePnpmAvailable;
    while (true) {
      const sourceChoice = await choose('选择配置来源 [1]，输入 0 取消。', answer => {
        if (!answer) return '1';
        if (['0', '1', '2', '3'].includes(answer)) return answer;
      });
      if (sourceChoice === undefined || sourceChoice === '0') return;

      const needsPnpm = sourceChoice !== '3' && selected.includes('dsh') && !unit && pnpmAvailable === false;
      if (needsPnpm) {
        const installPnpm = await yesNo('本机 DSH 的完整配置需要 pnpm。允许补装 pnpm？', true);
        if (installPnpm === undefined) return;
        if (!installPnpm) {
          print('可选择仅配置共享规则与 skills。');
          continue;
        }
        installAgents = true;
      }

      if (unit && sourceChoice !== '3') {
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
        const path = await choose('输入配置仓库路径或 Git URL。', answer => answer || undefined);
        if (path === undefined) return;
        source = expandHome(path);
      } else if (sourceChoice === '3') {
        source = false;
      }
      break;
    }

    const deps = source === false ? false : await yesNo('安装配置中声明的辅助工具和依赖？', false);
    if (deps === undefined) return undefined;
    const workspace = await ask('工作区父目录（可选）。例如未来项目会放在 ~/workspaces/workspace-1 下，就填 ~/workspaces。留空使用全局配置。');
    if (workspace === undefined) return undefined;

    let dshProfile = 'web';
    if (selected.includes('dsh')) {
      dshProfile = await choose('DSH 配置档名称 [web]。', answer => {
        if (!answer) return 'web';
        if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(answer) && answer !== 'desktop') return answer;
      });
      if (dshProfile === undefined) return undefined;
    }

    const plan = {
      agents: selected, source, installAgents, deps, workspace: workspace ? expandHome(workspace) : undefined,
      unit, dshProfile,
    };
    if (serviceInstallAgents) plan.serviceInstallAgents = true;
    print('安装计划');
    print(`  宿主  ${selected.map(agent => names[agent]).join('、')}`);
    print(`  配置来源  ${source === false ? '仅配置共享规则与 skills' : source ?? '默认 Kitto 配置'}`);
    print('  共享范围  全局' + (plan.workspace ? `，以及工作区 ${plan.workspace}` : ''));
    if (selected.includes('dsh')) print(`  DSH  ${unit ?? '当前账号'}，配置档 ${dshProfile}`);
    print(`  补装缺少的宿主和必需工具  ${installAgents ? '是' : '否'}`);
    if (serviceInstallAgents) print(`  为 ${unit} 的账号补装 pnpm  是`);
    if (source !== false) print(`  安装配置声明的辅助依赖  ${deps ? '是' : '否'}`);

    let action = await choose('下一步 [1]。1 预览，2 安装，0 取消。', answer => {
      if (!answer) return '1';
      if (['0', '1', '2'].includes(answer)) return answer;
    });
    if (action === '1') {
      await execute({ ...plan, dryRun: true });
      action = await choose('预览完成 [0]。2 按此计划安装，0 退出。', answer => {
        if (!answer || answer === '0') return '0';
        if (answer === '2') return answer;
      });
      if (action !== '2') {
        print('已退出，未执行安装。');
        return true;
      }
    }
    if (action !== '2') return;
    rl.close();
    await execute({ ...plan, dryRun: false });
    return true;
  } finally {
    rl.close();
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
