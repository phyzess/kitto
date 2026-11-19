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
  const result = await wizard('1，3\n\n3\n\noperations\n2\n', {
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
  const allowed = await wizard('\n1\ny\n\n\n\n1\n0\n', environment);
  assert.match(allowed.text, /允许补装 pnpm/);
  assert.equal(allowed.plans[0].installAgents, true);
  assert.equal(allowed.plans[0].source, undefined);

  const declined = await wizard('\n1\nn\n3\n\n\n1\n0\n', environment);
  assert.equal(declined.plans[0].installAgents, false);
  assert.equal(declined.plans[0].source, false);
});

test('wizard asks for separate permission to install pnpm in the DSH service account', async () => {
  const environment = { available: ['pi'], serviceActive: true, canConfigureService: true, pnpmAvailable: true };
  const options = { probeServicePnpm: async unit => {
    assert.equal(unit, 'dsh.service');
    return false;
  } };
  const allowed = await wizard('pi,dsh\n\n1\ny\nn\n\n\n1\n0\n', environment, options);
  assert.match(allowed.text, /允许在服务账号中补装 pnpm/);
  assert.equal(allowed.plans[0].installAgents, false);
  assert.equal(allowed.plans[0].serviceInstallAgents, true);

  const declined = await wizard('pi,dsh\n\n1\nn\n3\n\n\n1\n0\n', environment, options);
  assert.equal(declined.plans[0].source, false);
  assert.equal(declined.plans[0].serviceInstallAgents, undefined);
});
