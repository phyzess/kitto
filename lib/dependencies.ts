import { spawnSync } from 'node:child_process';
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import type { HostName, State } from '../types/kitto.d.ts';

export interface McpServerEntry {
  command?: string;
  args?: string[];
  enabled?: boolean;
  [key: string]: unknown;
}

type InstallManager = 'mise' | 'pip' | 'brew';

interface DependencyRule {
  agent?: string;
  platform?: string;
  skill?: string;
  piCommand?: string;
  piNpx?: string;
  executable?: string;
  install?: Record<string, string>;
  package?: string;
  target?: string | null;
  manager?: InstallManager;
}

export interface DependencyPlanItem {
  name: string | undefined;
  path: string | undefined;
  target: string | null;
  installed: string | null;
  manager: InstallManager | undefined;
  note: string | undefined;
  available: boolean;
  reason: string;
}

export async function optionalJson(path: string, fallback: any = {}): Promise<any> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

export function executable(name: string): string | undefined {
  const paths = name.includes('/') ? [resolve(name)] : (process.env.PATH || '').split(delimiter).map((dir) => resolve(dir, name));
  return paths.find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

export function query(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 8000, env });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function npmSpec(source: string): [string, string | null] {
  const spec = source.replace(/^npm:/, '');
  const split = spec.lastIndexOf('@');
  return split > 0 ? [spec.slice(0, split), spec.slice(split + 1)] : [spec, null];
}

export async function piServers(state: State): Promise<Record<string, McpServerEntry>> {
  const declared = await optionalJson(join(state.source, 'config/pi/mcp.json'));
  const live = await optionalJson(join(state.piHome, 'mcp.json'), declared);
  return Object.fromEntries(
    (Object.entries(live.mcpServers || {}) as Array<[string, McpServerEntry]>).filter(
      ([name, entry]) => !name.startsWith('_') && entry?.command && entry.enabled !== false,
    ),
  );
}

export function npxPackage(entry: McpServerEntry): Array<string | null> {
  if (entry.command !== 'npx') return [];
  const spec = entry.args?.find((value: string) => !value.startsWith('-'));
  return spec ? npmSpec(spec) : [];
}

async function dependencyRules(state: State): Promise<DependencyRule[]> {
  const entries = await optionalJson(join(state.source, 'config/dependencies.json'), null);
  if (entries === null) return [];
  if (!Array.isArray(entries)) throw new Error('config/dependencies.json must contain an array.');
  return entries.map((rule: DependencyRule, index: number) => {
    const invalid = () => new Error(`Invalid dependency declaration at config/dependencies.json entry ${index + 1}.`);
    const fields = ['agent', 'platform', 'skill', 'piCommand', 'piNpx', 'executable', 'install'];
    const name = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
    const npmName = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_][a-z0-9_.-]*$/;
    if (!rule || typeof rule !== 'object' || Object.keys(rule).some((key) => !fields.includes(key))) throw invalid();
    for (const key of fields.filter((key) => key !== 'install')) {
      if (
        key in rule &&
        (typeof rule[key as keyof DependencyRule] !== 'string' ||
          !(key === 'piNpx' ? npmName : name).test(rule[key as keyof DependencyRule] as string))
      )
        throw invalid();
    }
    if (!rule.agent && !rule.skill && !rule.piCommand && !rule.piNpx) throw invalid();
    if (rule.agent && !['pi', 'codex', 'dsh'].includes(rule.agent)) throw invalid();
    if (rule.platform && !['darwin', 'linux'].includes(rule.platform)) throw invalid();
    if (!('install' in rule)) {
      if (!rule.executable) throw invalid();
      return rule;
    }
    if (!rule.install || typeof rule.install !== 'object' || Object.keys(rule.install).length !== 1) throw invalid();
    const [[manager, spec]] = Object.entries(rule.install);
    if (!['mise', 'pip', 'brew'].includes(manager) || typeof spec !== 'string') throw invalid();
    const [pkg, target] = manager === 'mise' ? npmSpec(spec) : [spec, null];
    if (manager === 'mise') {
      if (!spec.startsWith('npm:') || !npmName.test(pkg) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(target || '')) throw invalid();
    } else if (!name.test(pkg)) throw invalid();
    if (manager !== 'pip' && !rule.executable) throw invalid();
    return { ...rule, package: pkg, target, manager: manager as InstallManager };
  });
}

export async function dependencyPlan(state: State): Promise<DependencyPlanItem[]> {
  const servers = state.agents.includes('pi') ? await piServers(state) : {};
  const plans = new Map<string, DependencyPlanItem>();
  for (const rule of await dependencyRules(state)) {
    if (rule.agent && !state.agents.includes(rule.agent as HostName)) continue;
    if (rule.platform && rule.platform !== process.platform) continue;
    const reasons: string[] = [];
    if (rule.skill && existsSync(join(state.source, 'skills', rule.skill, 'SKILL.md'))) reasons.push(`shared skill ${rule.skill}`);
    for (const [name, entry] of Object.entries(servers)) {
      if (rule.piCommand === entry.command || (rule.piNpx && rule.piNpx === npxPackage(entry)[0])) reasons.push(`Pi MCP ${name}`);
    }
    if (!reasons.length && rule.agent && !rule.skill && !rule.piCommand && !rule.piNpx) reasons.push(rule.agent);
    if (!reasons.length) continue;
    const target = rule.target ?? null;
    const name = rule.package || rule.executable;
    let installed: string | null = null;
    const path = rule.executable ? executable(rule.executable) : undefined;
    if (rule.manager === 'mise') {
      const active = query('mise', ['current', `npm:${name}`]);
      if (active) installed = active.replace(/^v/, '');
    } else if (rule.manager === 'pip') {
      installed = query('python3', ['-m', 'pip', 'show', name])?.match(/^Version: (.+)$/m)?.[1] || null;
    }
    const key = rule.executable ? `executable:${rule.executable}` : `package:${name}`;
    const previous = plans.get(key);
    if (previous?.manager && rule.manager && (previous.manager !== rule.manager || previous.name !== name || previous.target !== target)) {
      throw new Error(`Conflicting dependency declarations for ${rule.executable || name}.`);
    }
    const plan = {
      name,
      path,
      target,
      installed,
      manager: rule.manager,
      note: rule.skill ? 'Binary check only. Verify MCP tools in the active session.' : undefined,
      available: rule.manager === 'pip' ? Boolean(installed) : Boolean(path) && (!target || installed === target),
      reason: reasons.join(', '),
    };
    const selected = previous?.manager || !rule.manager ? previous || plan : plan;
    if (previous) {
      selected.reason = [...new Set([...previous.reason.split(', '), ...reasons])].join(', ');
      selected.note ||= previous.note || plan.note;
    }
    plans.set(key, selected);
  }
  return [...plans.values()];
}

export async function installDependencies(state: State, apply: boolean): Promise<void> {
  const plans = await dependencyPlan(state);
  if (!plans.length) console.log('No declared dependencies for the enabled hosts and shared skills.');
  const blocked: string[] = [],
    manual: string[] = [],
    attempted: string[] = [];
  for (const tool of plans) {
    const { name, target, manager, reason } = tool;
    if (tool.available) {
      console.log(`Available: ${name} (${reason})`);
      continue;
    }
    if (!manager) {
      manual.push(name);
      console.log(`Missing: ${name} (${reason}); install separately if needed.`);
      continue;
    }
    const command = manager === 'pip' ? 'python3' : manager;
    const args =
      manager === 'mise' ? ['use', '-g', `npm:${name}@${target}`] : manager === 'pip' ? ['-m', 'pip', 'install', name] : ['install', name];
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
  const ready = current.filter((tool) => tool.available).map((tool) => tool.name);
  for (const name of attempted) if (!ready.includes(name)) blocked.push(`${name} (still unavailable after install)`);
  console.log(`Ready: ${ready.join(', ') || 'none'}`);
  console.log(`Manual setup: ${manual.join(', ') || 'none'}`);
  console.log(`Unresolved managed dependencies: ${blocked.join(', ') || 'none'}`);
  if (blocked.length) throw new Error('Some managed dependencies are still unavailable.');
}
