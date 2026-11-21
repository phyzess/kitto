import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkSelectedHosts, installMissingHosts, maintain, setup } from './kitto.mjs';
import { query } from './dependencies.mjs';
import { isDesktopProfile } from './dsh-profile.mjs';
import { configureServiceEnvironment } from './scope-service.mjs';

export async function runEnvironmentSetup(plan) {
  const { unit, deps, installAgents, dryRun, dshProfile } = plan;
  const desktopDsh = isDesktopProfile(dshProfile);
  const source = plan.source && existsSync(plan.source) ? resolve(plan.source) : plan.source;
  if (source === false && desktopDsh && plan.agents.includes('dsh')) {
    throw new Error('The DSH desktop profile requires a configuration source: the "shared rules and skills only" ' +
      'mode would deploy no global rules. Choose a source or use --dsh-profile web.');
  }
  const workspace = plan.workspace && resolve(plan.workspace);
  const agents = plan.agents.filter(name => name !== 'dsh' || !unit);
  const serviceOptions = { unit, source, deps, workspace, global: true, installAgents: plan.serviceInstallAgents ?? false, dshProfile };
  if (unit) await configureServiceEnvironment({ ...serviceOptions, dryRun: true });
  if (agents.length) {
    const options = { agents, 'dry-run': dryRun };
    if (agents.includes('dsh')) options['dsh-profile'] = dshProfile;
    if (source === false) {
      checkSelectedHosts(agents, installAgents);
      if (!dryRun && installAgents) installMissingHosts(agents);
    } else {
      await setup({ ...options, source, 'install-agents': installAgents, keepExistingSkills: true });
    }
    // The DSH adapter imports modules from its native CLI, which may still be pending in a preview.
    const pendingDsh = !desktopDsh && dryRun && installAgents && agents.includes('dsh') && query('dsh', ['--version']) === null;
    const scopedAgents = agents.filter(name => !(pendingDsh && name === 'dsh'))
      // The app-managed Desktop profile has no Kitto scope adapter in v1.
      .filter(name => !(name === 'dsh' && desktopDsh));
    if (desktopDsh && agents.includes('dsh')) {
      console.log('DSH Desktop：由 App 管理，跳过 scoped 适配器；本次只处理全局规则和 skills。');
    }
    if (pendingDsh) console.log('DSH scope registration will run after its CLI is installed.');
    if (scopedAgents.length) {
      const scope = { ...options, agents: scopedAgents };
      if (!scopedAgents.includes('dsh')) delete scope['dsh-profile'];
      await setup({ ...scope, global: true });
      if (workspace) await setup({ ...scope, 'workspace-parent': workspace });
    }
  }
  if (unit && !dryRun) await configureServiceEnvironment({ ...serviceOptions, dryRun: false });
  if (agents.length && deps && source !== false) {
    if (dryRun) console.log('安装时将检查配置仓库声明的辅助工具和依赖。');
    else await maintain(['deps', '--apply']);
  }
  if (dryRun) return;
  console.log('环境配置已完成。以后在项目目录开启新会话即可。');
  if (workspace) console.log('未来新建的工作区也会生效：' + workspace + '/<工作区>/AGENTS.md');
  if (agents.includes('codex')) console.log('首次使用 Codex 时，在 /hooks 中确认信任 Kitto 的 SessionStart hook。');
  if (desktopDsh && plan.agents.includes('dsh')) {
    console.log('完全退出并重新打开 DeepSeek Harness Desktop，以加载部署的全局 AGENTS.md 和 skills。');
  } else if (plan.agents.includes('dsh')) {
    console.log('已运行的 DSH 需要重启对应服务或 profile 以加载配置。');
  }
}
