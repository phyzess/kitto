import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runWizard } from '../lib/setup-wizard.mjs';

async function wizard(answers, environment, { terminal = false, probeServicePnpm } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = terminal;
  let text = '';
  const plans = [];
  output.setEncoding('utf8');
  output.on('data', chunk => { text += chunk; });
  const pending = runWizard({
    input, output, detect: async () => environment, execute: async plan => { plans.push(plan); }, probeServicePnpm,
  });
  input.end(answers);
  await pending;
  return { text, plans };
}

test('wizard defaults to detected hosts and previews the default source', async () => {
  const result = await wizard('\n\n\n\n\n', { available: ['pi', 'codex'], serviceActive: false });
  assert.match(result.text, /安装向导/);
  assert.match(result.text, /未来项目/);
  assert.match(result.text, /安装计划[\s\S]*默认 Kitto 配置/);
  assert.match(result.text, /未执行安装/);
  assert.deepEqual(result.plans, [{
    agents: ['pi', 'codex'], source: undefined, installAgents: false, deps: false,
    workspace: undefined, unit: undefined, dshProfile: 'web', dryRun: true,
  }]);
});

test('wizard offers active DSH service without requiring a local CLI or workspace', async () => {
  const result = await wizard('1，3\n\noperations\n3\n\n2\n', {
    available: ['pi'], serviceActive: true, canConfigureService: true,
  });
  assert.match(result.text, /正在运行的系统服务 dsh.service/);
  assert.deepEqual(result.plans, [{
    agents: ['pi', 'dsh'], source: false, installAgents: false, deps: false,
    workspace: undefined, unit: 'dsh.service', dshProfile: 'operations', dryRun: false,
  }]);
});

test('wizard retries agent selection after declining installation and records explicit paths', async () => {
  const result = await wizard('4\n2\nn\n1,2\ny\n2\n./my config\ny\n./my workspace\n1\n', {
    available: ['pi'], serviceActive: false,
  });
  assert.match(result.text, /输入无效/);
  assert.match(result.text, /补装 Codex/);
  assert.deepEqual(result.plans, [{
    agents: ['pi', 'codex'], source: './my config', installAgents: true, deps: true,
    workspace: './my workspace', unit: undefined, dshProfile: 'web', dryRun: true,
  }]);
});

test('wizard cancels cleanly on Ctrl+C, EOF, and an explicit cancel selection', async () => {
  const environment = { available: ['codex'], serviceActive: false };
  for (const [answers, terminal] of [['\x03', true], ['\n3\n', false], ['\n3\n\n0\n', false]]) {
    const result = await wizard(answers, environment, { terminal });
    assert.match(result.text, /已取消安装/);
    assert.deepEqual(result.plans, []);
  }
});

test('wizard can apply the same plan after preview in one invocation', async () => {
  const result = await wizard('\n3\n./projects\n1\n2\n', { available: ['codex'], serviceActive: false });
  assert.match(result.text, /安装计划[\s\S]*工作区 \.\/projects/);
  assert.match(result.text, /预览完成/);
  assert.equal(result.plans.length, 2);
  const [preview, applied] = result.plans;
  assert.equal(preview.dryRun, true);
  assert.deepEqual(applied, { ...preview, dryRun: false });
});

test('wizard requests pnpm installation for full local DSH setup', async () => {
  const environment = { available: ['dsh'], serviceActive: false, pnpmAvailable: false };
  const allowed = await wizard('\n\n1\ny\n\n\nskip\n1\n0\n', environment);
  assert.match(allowed.text, /允许补装 pnpm/);
  assert.equal(allowed.plans[0].installAgents, true);
  assert.equal(allowed.plans[0].source, undefined);

  const declined = await wizard('\n\n1\nn\n3\n\n\n1\n0\n', environment);
  assert.equal(declined.plans[0].installAgents, false);
  assert.equal(declined.plans[0].source, false);
});

test('wizard confirms personal, company, custom, or skipped routing only for full local DSH', async () => {
  const environment = { available: ['dsh'], serviceActive: false, pnpmAvailable: true };
  for (const mode of ['personal', 'company', 'custom', 'skip']) {
    const routes = mode === 'custom' ? 'company-claude/sonnet,corp-router/anthropic/claude-sonnet\n' : '';
    const result = await wizard(`\n\n1\n\n\n${mode}\n${routes}1\n2\n`, environment);
    assert.match(result.text, /确认本机模型路由边界/);
    assert.equal(result.plans.length, 2);
    assert.equal(result.plans[0].routingBoundary, mode);
    assert.equal(result.plans[1].routingRoutes, routes ? routes.trim() : undefined);
    assert.deepEqual(result.plans[1], { ...result.plans[0], dryRun: false });
  }
  const scoped = await wizard('\n\n3\n\n1\n0\n', environment);
  assert.doesNotMatch(scoped.text, /确认本机模型路由边界/);
  assert.equal(scoped.plans[0].routingBoundary, undefined);
});

test('wizard accepts the app-managed DSH desktop profile without asking for pnpm', async () => {
  const result = await wizard('\ndesktop\n1\n\n\n1\n0\n', {
    available: ['dsh'], serviceActive: false, pnpmAvailable: false,
  });
  assert.match(result.text, /DSH Desktop 由 App 管理/);
  assert.doesNotMatch(result.text, /允许补装 pnpm/);
  assert.match(result.text, /配置档 desktop（由 App 管理，仅全局规则\/skills）/);
  assert.deepEqual(result.plans, [{
    agents: ['dsh'], source: undefined, installAgents: false, deps: false,
    workspace: undefined, unit: undefined, dshProfile: 'desktop', dryRun: true,
  }]);
});

test('wizard asks for separate permission to install pnpm in the DSH service account', async () => {
  const environment = { available: ['pi'], serviceActive: true, canConfigureService: true, pnpmAvailable: true };
  const options = { probeServicePnpm: async unit => {
    assert.equal(unit, 'dsh.service');
    return false;
  } };
  const allowed = await wizard('pi,dsh\n\n\n1\ny\nn\n\n1\n0\n', environment, options);
  assert.match(allowed.text, /允许在服务账号中补装 pnpm/);
  assert.equal(allowed.plans[0].installAgents, false);
  assert.equal(allowed.plans[0].serviceInstallAgents, true);

  const declined = await wizard('pi,dsh\n\n\n1\nn\n3\n\n\n1\n0\n', environment, options);
  assert.equal(declined.plans[0].source, false);
  assert.equal(declined.plans[0].serviceInstallAgents, undefined);
});

test('terminal wizard accepts arrows, Space, blank optional text, and Enter to preview', { timeout: 6000 }, async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = enabled => { input.isRaw = enabled; };
  output.columns = 100;
  output.rows = 36;
  const down = '\x1b[B';
  const steps = [
    ['选择宿主', down + ' ' + '\r'],
    ['选择配置来源', down + down + '\r'],
    ['工作区父目录', '\r'],
    ['下一步', '\r'],
    ['预览完成', '\r'],
  ];
  output.on('data', chunk => {
    if (steps.length && chunk.toString().includes(steps[0][0])) {
      const [, keys] = steps.shift();
      setImmediate(() => input.write(keys));
    }
  });
  const plans = [];
  await runWizard({ input, output, detect: async () => ({ available: ['pi', 'codex'] }),
    execute: async plan => plans.push(plan) });
  assert.deepEqual(steps, []);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].agents, ['pi']);
  assert.equal(plans[0].source, false);
  assert.equal(plans[0].workspace, undefined);
  assert.equal(plans[0].dryRun, true);
  assert.equal(input.isRaw, false);
});

test('wizard accepts a DSH desktop profile without a local dsh CLI or install prompt', async () => {
  const result = await wizard('dsh\ndesktop\n1\n\n\n1\n0\n', {
    available: [], serviceActive: false, pnpmAvailable: false,
  });
  assert.match(result.text, /DSH Desktop 不要求本机 dsh CLI/);
  assert.match(result.text, /补装缺少的宿主和必需工具  否/);
  assert.doesNotMatch(result.text, /补装 DeepSeek/);
  assert.deepEqual(result.plans, [{
    agents: ['dsh'], source: undefined, installAgents: false, deps: false,
    workspace: undefined, unit: undefined, dshProfile: 'desktop', dryRun: true,
  }]);
});

test('wizard rejects shared-rules-only mode for the DSH desktop profile', async () => {
  const result = await wizard('\ndesktop\n3\n1\n\n\n1\n0\n', {
    available: ['dsh'], serviceActive: false, pnpmAvailable: false,
  });
  assert.match(result.text, /不能选择「仅配置共享规则与 skills」/);
  assert.doesNotMatch(result.text, /配置来源  仅配置共享规则与 skills/);
  assert.equal(result.plans[0].source, undefined);
  assert.equal(result.plans[0].dshProfile, 'desktop');
});
