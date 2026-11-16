import { spawnSync } from 'node:child_process';
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

export async function optionalJson(path, fallback = {}) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function executable(name) {
  const paths = name.includes('/') ? [resolve(name)] : (process.env.PATH || '').split(delimiter).map(dir => resolve(dir, name));
  return paths.find(path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
    catch { return false; }
  });
}

export function query(command, args, env = process.env) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 8000, env });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function npmSpec(source) {
  const spec = source.replace(/^npm:/, '');
  const split = spec.lastIndexOf('@');
  return split > 0 ? [spec.slice(0, split), spec.slice(split + 1)] : [spec, null];
}

export async function piServers(state) {
  const declared = await optionalJson(join(state.source, 'config/pi/mcp.json'));
  // Once installed, respect the actual selected command and local on/off switches.
  const live = await optionalJson(join(state.piHome, 'mcp.json'), declared);
  return Object.fromEntries(Object.entries(live.mcpServers || {}).filter(
    ([name, entry]) => !name.startsWith('_') && entry?.command && entry.enabled !== false,
  ));
}

const rules = [
  { executable: 'codegraph', skill: 'codegraph', piCommand: 'codegraph' },
  { executable: 'serena', piCommand: 'serena' },
  { executable: 'dap-mcp-server', piCommand: 'dap-mcp-server', list: 'mise-tools.txt', manager: 'mise' },
  { package: 'debugpy', piCommand: 'dap-mcp-server', list: 'pip.txt', manager: 'pip' },
  { executable: 'ast-grep', piNpx: 'ast-grep-mcp', list: 'brew.txt', manager: 'brew', platform: 'darwin' },
  { executable: 'ast-grep', package: '@ast-grep/cli', piNpx: 'ast-grep-mcp', list: 'npm.txt', manager: 'mise', platform: 'linux' },
];

export function npxPackage(entry) {
  if (entry.command !== 'npx') return [];
  const spec = entry.args?.find(value => !value.startsWith('-'));
  return spec ? npmSpec(spec) : [];
}

async function listTarget(state, rule) {
  if (!rule.list) return null;
  const path = join(state.source, 'lists', rule.list);
  if (!existsSync(path)) return undefined;
  const lines = (await readFile(path, 'utf8')).split('\n');
  for (const line of lines) {
    const [name, version] = line.split('#', 1)[0].trim().split(/\s+/);
    if (name === (rule.package || rule.executable)) return version ?? null;
  }
  return undefined;
}

export async function dependencyPlan(state) {
  const servers = state.agents.includes('pi') ? await piServers(state) : {};
  const plans = [];
  for (const rule of rules) {
    if (rule.platform && rule.platform !== process.platform) continue;
    const reasons = [];
    if (rule.skill && existsSync(join(state.source, 'skills', rule.skill, 'SKILL.md'))) reasons.push(`shared skill ${rule.skill}`);
    for (const [name, entry] of Object.entries(servers)) {
      if (rule.piCommand === entry.command || (rule.piNpx && rule.piNpx === npxPackage(entry)[0])) reasons.push(`Pi MCP ${name}`);
    }
    if (!reasons.length) continue;
    const target = await listTarget(state, rule);
    if (target === undefined) continue;
    const name = rule.package || rule.executable;
    if (rule.manager === 'mise' && !target) throw new Error(`Missing declared version for ${name} in lists/${rule.list}.`);
    let installed = null;
    const path = rule.executable ? executable(rule.executable) : undefined;
    if (rule.manager === 'mise') {
      const active = query('mise', ['current', `npm:${name}`]);
      if (active) installed = active.replace(/^v/, '');
    } else if (rule.manager === 'pip') {
      installed = query('python3', ['-m', 'pip', 'show', name])?.match(/^Version: (.+)$/m)?.[1] || null;
    }
    plans.push({ name, path, target, installed, manager: rule.manager,
      note: rule.skill ? 'Binary check only. Verify MCP tools in the active session.' : undefined,
      available: rule.manager === 'pip' ? Boolean(installed) : Boolean(path) && (!target || installed === target),
      reason: reasons.join(', ') });
  }
  return plans;
}

export async function installDependencies(state, apply) {
  const plans = await dependencyPlan(state);
  if (!plans.length) console.log('No declared dependencies for the enabled hosts and shared skills.');
  const blocked = [], manual = [], attempted = [];
  for (const tool of plans) {
    const { name, target, manager, reason } = tool;
    if (tool.available) { console.log(`Available: ${name} (${reason})`); continue; }
    if (!manager) {
      manual.push(name);
      console.log(`Missing: ${name} (${reason}); install separately if needed.`);
      continue;
    }
    const command = manager === 'pip' ? 'python3' : manager;
    const args = manager === 'mise' ? ['use', '-g', `npm:${name}@${target}`]
      : manager === 'pip' ? ['-m', 'pip', 'install', name] : ['install', name];
    if (!executable(command)) {
      blocked.push(`${name} (missing ${command})`);
      console.log(`Missing installer ${command}: ${name} (${reason})`);
      continue;
    }
    console.log(`${apply ? 'Run' : 'Would run'}: ${[command, ...args].join(' ')} (${reason})`);
    if (apply) {
      const result = spawnSync(command, args, { stdio: 'inherit', timeout: 600_000 });
      if (result.status !== 0) blocked.push(`${name} (${result.error?.message || `exit ${result.status}`})`);
      else attempted.push(name);
    }
  }
  if (!apply) return;
  const current = attempted.length ? await dependencyPlan(state) : plans;
  const ready = current.filter(tool => tool.available).map(tool => tool.name);
  for (const name of attempted) if (!ready.includes(name)) blocked.push(`${name} (still unavailable after install)`);
  console.log(`Ready: ${ready.join(', ') || 'none'}`);
  console.log(`Manual setup: ${manual.join(', ') || 'none'}`);
  console.log(`Unresolved managed dependencies: ${blocked.join(', ') || 'none'}`);
  if (blocked.length) throw new Error('Some managed dependencies are still unavailable.');
}
