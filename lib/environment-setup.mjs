import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkSelectedHosts, installMissingHosts, maintain, setup } from './kitto.mjs';
import { query } from './dependencies.mjs';
import { configureServiceEnvironment } from './scope-service.mjs';

export async function runEnvironmentSetup(plan) {
  const { unit, deps, installAgents, dryRun, dshProfile } = plan;
  const source = plan.source && existsSync(plan.source) ? resolve(plan.source) : plan.source;
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
    const scopedAgents = agents.filter(name => !(dryRun && installAgents && name === 'dsh' && query('dsh', ['--version']) === null));
    if (scopedAgents.length !== agents.length) console.log('DSH scope registration will run after its CLI is installed.');
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
  if (plan.agents.includes('dsh')) console.log('已运行的 DSH 需要重启对应服务或 profile 以加载配置。');
}
