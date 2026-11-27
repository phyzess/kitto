import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, lstat, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyInstructions, hostSkillRoots, instructionPlan } from './host-config.ts';
import { dependencyPlan, installDependencies } from './dependencies.ts';
import { sameLocation } from './paths.ts';
import { reportCodeGraphIndexes } from './codegraph.ts';
import { planCodexMcp, sourceServers as codexMcpSource } from './codex-mcp.ts';
import { printMcpParity } from './parity.ts';
import { desktopProfileNotice, isDesktopProfile, probeDesktopProfile, reportDesktopProbe, validateDshProfile } from './dsh-profile.ts';
import { versionReport } from './versions.ts';
import type { ToolNodePlan } from './tool-node.ts';
import { applyLauncherRemoval, applyToolNode, describeToolNode, launcherPath, planLauncherRemoval, planToolNode } from './tool-node.ts';

import { hosts, pnpmVersion } from './host-pins.ts';
import { hostsCommand } from './hosts.ts';
import { kittoHome, packageRoot } from './kitto-home.ts';
import { meetsBaseline } from './version-order.ts';
import { setRoutingBoundary } from './routing-policy.ts';
import { get, list, recordedHash, replaceScope } from './ownership.ts';
import { CURRENT_SCHEMA, MANAGED_PACKAGES_FILE, downgradeState, rollbackState } from './state-schema.ts';
import { loadKittoState, saveKittoState, stateFile } from './state-io.ts';
import { atomicJson, present, readJson, replaceDirectory, treeHash } from './fs-atomic.ts';
import { allowStaleLockBreak, locked } from './locks.ts';
import { available, git, run } from './process.ts';
import { adapterFor, connectNative, planConnect, planDeploy } from './hosts/index.ts';
import { availableHost, checkSelectedHosts, hostCliVersions, installMissingHosts } from './hosts/cli.ts';
import type { HostAction } from './hosts/action.ts';
import type { HostName, RuntimeRecord, SourceRevision, State } from '../types/kitto.d.ts';
import type { InstructionPlan } from './host-config.ts';
import type { McpOperation } from './codex-mcp.ts';

export interface KittoOptions {
  'dry-run'?: boolean;
  'install-agents'?: boolean;
  recover?: boolean;
  'require-baseline'?: boolean;
  global?: boolean;
  'include-private'?: boolean;
  'no-include-private'?: boolean;
  agents?: HostName[];
  source?: string;
  ref?: string;
  'dsh-profile'?: string;
  workspace?: string;
  'workspace-parent'?: string;
  'dsh-service'?: string;
  'routing-boundary'?: string;
  'routing-routes'?: string;
  serviceSetup?: boolean;
  keepExistingSkills?: boolean;
}

type SkillAction = 'copy' | 'remove' | 'keep' | 'same' | 'linked';

interface SkillPlanItem {
  name: string;
  source?: string;
  target: string;
  hash?: string;
  action: SkillAction;
}

interface SkillGroup {
  name: string;
  source: string;
  target: string;
  plans?: SkillPlanItem[];
}

interface ConfigurationPlan {
  groups: SkillGroup[];
  instructions: InstructionPlan[];
  mcp: McpOperation[] | undefined;
  toolNode: ToolNodePlan;
}

interface BootstrapMarker {
  url?: string;
  ref?: string | null;
}

interface RuntimeCheckpoint {
  version: string;
  dshProfile: string;
  hash: string;
}

export { hosts, pnpmVersion, kittoHome, packageRoot, meetsBaseline };
export { allowStaleLockBreak, checkSelectedHosts, installMissingHosts, replaceDirectory, treeHash };
const defaultSource = 'https://github.com/phyzess/kitto.git';
const isGitUrl = (value: unknown): value is string => typeof value === 'string' && /^(https:\/\/|ssh:\/\/|git@)/.test(value);
const redactUrl = (value: unknown) => String(value).replace(/\/\/[^/@\s]+@/g, '//***@');
const json = readJson;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function parseOptions(args: string[]): KittoOptions {
  const options: Record<string, any> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--dry-run', '--install-agents', '--recover', '--require-baseline', '--global', '--include-private', '--no-include-private'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--agents', '--source', '--ref', '--dsh-profile', '--workspace', '--workspace-parent', '--dsh-service',
      '--routing-boundary', '--routing-routes'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('-')) {
      const name = arg.slice(2);
      if (name.startsWith('routing-') && Object.hasOwn(options, name)) throw new Error(`Specify ${arg} at most once.`);
      options[name] = args[++i];
    }
    else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  if (options.agents) {
    options.agents = [...new Set(options.agents.split(','))];
    if (options.agents.some((name: HostName) => !hosts[name])) throw new Error('Agents must be pi,codex,dsh.');
  }
  if (options['include-private'] && options['no-include-private']) throw new Error('Choose either --include-private or --no-include-private.');
  if (options.recover && Object.keys(options).some(key => !['recover', 'dry-run'].includes(key))) throw new Error('--recover only accepts --dry-run; it uses the saved installation.');
  return options as KittoOptions;
}

async function validateSource({ source, agents }: Pick<State, 'source' | 'agents'>): Promise<void> {
  if (git(source, ['rev-parse', '--show-toplevel']) !== await realpath(source)) throw new Error('Source must be the root of a Git checkout.');
  if (agents.includes('codex')) {
    try {
      await codexMcpSource(source);
    } catch (error) {
      throw new Error(`Codex MCP sync requires a readable Pi MCP source: ${(error as Error).message}`);
    }
  }
  if (!agents.includes('pi')) return;
  const settings = await json(join(source, 'config/pi/settings.json'));
  if (!Array.isArray(settings.packages)) throw new Error('Source lacks config/pi/settings.json packages.');
  await json(join(source, 'config/pi/mcp.json'));
  await readFile(join(source, 'config/pi/AGENTS.md'));
}

async function replaceRuntime(home: string, next: string): Promise<void> {
  const runtime = join(home, 'runtime'), replacing = join(home, 'runtime.replacing');
  if (!await present(runtime) && await present(replacing)) await rename(replacing, runtime);
  await rm(replacing, { recursive: true, force: true });
  if (await present(runtime)) await rename(runtime, replacing);
  try { await rename(next, runtime); } catch (error) {
    if (await present(replacing)) await rename(replacing, runtime);
    throw error;
  }
  await rm(replacing, { recursive: true, force: true });
}

async function assertBuiltPackage(): Promise<void> {
  for (const name of ['bin', 'lib', 'integration']) {
    const entries = await readdir(join(packageRoot, name), { recursive: true });
    if (entries.some(entry => entry.endsWith('.ts'))) {
      throw new Error(`Cannot install a runtime from TypeScript sources at ${packageRoot}. Run \`npm ci --ignore-scripts && npm run build\`, then run \`node dist/bin/kitto.mjs\` (or ./setup.sh from the checkout).`);
    }
  }
}

async function installRuntime(home: string, old: Partial<State>, agentsHome: string): Promise<string> {
  const next = join(home, 'runtime.next');
  const runtime = join(home, 'runtime');
  const previous = join(home, 'runtime.previous');
  if (sameLocation(packageRoot, runtime)) return runtime;
  await assertBuiltPackage();
  await rm(next, { recursive: true, force: true });
  await mkdir(next);
  for (const name of ['package.json', 'bin', 'lib', 'integration', 'CHANGELOG.md']) {
    await cp(join(packageRoot, name), join(next, name), { recursive: true });
  }
  const skillPath = join(next, 'integration/skills/kitto/SKILL.md');
  const entries: Record<string, string> = { KITTO_RUNNER: 'maintain.mjs', KITTO_CLI: 'kitto.mjs' };
  const launcher = shellQuote(launcherPath(agentsHome));
  const template = await readFile(skillPath, 'utf8');
  await writeFile(skillPath, template.replace(/KITTO_NODE|KITTO_RUNNER|KITTO_CLI/g, (key: string) => key === 'KITTO_NODE' ? launcher : shellQuote(join(runtime, 'bin', entries[key]))));
  const hash = await treeHash(next);
  if (await present(runtime) && await treeHash(runtime) === hash) {
    await rm(next, { recursive: true });
    return runtime;
  }
  const currentIsVerified = await present(runtime) && (old.runtimeHash
    ? await treeHash(runtime) === old.runtimeHash
    : (await json(join(runtime, 'package.json'))).version === old.version);
  if (old.ready && !old.detached && currentIsVerified) {
    const staging = join(home, 'checkpoint.next');
    await rm(staging, { recursive: true, force: true });
    await cp(runtime, staging, { recursive: true });
    await rm(previous, { recursive: true, force: true });
    await rename(staging, previous);
    await atomicJson(join(home, 'runtime.previous.json'), {
      version: (await json(join(previous, 'package.json'))).version, dshProfile: old.dshProfile || 'web', hash: await treeHash(previous),
    });
  }
  await replaceRuntime(home, next);
  return runtime;
}

async function existingSkillAction(target: string, source: string, nextHash: string, previous: string | null | undefined, keepUnowned: boolean): Promise<SkillAction> {
  const stat = await lstat(target);
  if (stat.isSymbolicLink()) {
    if (sameLocation(resolve(dirname(target), await readlink(target)), source)) return 'linked';
    if (keepUnowned) return 'keep';
    throw new Error(`Skill conflict: ${target} links elsewhere. Preserved.`);
  }
  if (keepUnowned && !stat.isDirectory()) return 'keep';
  const current = await treeHash(target).catch((error: NodeJS.ErrnoException): null => {
    if (keepUnowned && error.code === 'KITTO_UNSUPPORTED_SKILL_ENTRY') return null;
    throw error;
  });
  if (current === nextHash) return 'same';
  if (current === previous) return 'copy';
  if (keepUnowned) return 'keep';
  throw new Error(`Skill conflict: ${target} differs from the source and last deployment. Preserved.`);
}

async function skillPlan(root: string, destination: string, state: State, group: string): Promise<SkillPlanItem[]> {
  const plans: SkillPlanItem[] = [];
  const keepExisting = state.keepExistingSkills === true;
  const owned = list(state, 'skill', group, 'owned').map(entry => entry.name);
  const kept = list(state, 'skill', group, 'kept').map(entry => entry.name);
  const entries = await present(root) ? await readdir(root, { withFileTypes: true }) : [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !existsSync(join(root, entry.name, 'SKILL.md'))) continue;
    const source = join(root, entry.name), target = join(destination, entry.name);
    const nextHash = await treeHash(source);
    let action: SkillAction = 'copy';
    if (await present(target)) {
      const keepUnowned = keepExisting && get(state, 'skill', group, entry.name)?.status !== 'owned';
      action = keepUnowned && kept.includes(entry.name) ? 'keep'
        : await existingSkillAction(target, source, nextHash, recordedHash(state, 'skill', group, entry.name), keepUnowned);
    }
    plans.push({ name: entry.name, source, target, hash: nextHash, action });
  }
  for (const name of owned) {
    if (plans.some(plan => plan.name === name)) continue;
    const target = join(destination, name);
    if (await present(target)) {
      if ((await lstat(target)).isSymbolicLink() || await treeHash(target) !== recordedHash(state, 'skill', group, name)) throw new Error(`Removed skill has local changes: ${target}. Preserved.`);
      plans.push({ name, target, action: 'remove' });
    }
  }
  for (const name of kept) {
    if (plans.some(plan => plan.name === name)) continue;
    const target = join(destination, name);
    if (await present(target)) plans.push({ name, target, action: 'keep' });
  }
  return plans;
}

async function configurationPlan(state: State): Promise<ConfigurationPlan> {
  const groups: SkillGroup[] = [{ name: 'shared', source: join(state.source, 'skills'), target: join(state.agentsHome, 'skills') },
    ...hostSkillRoots(state)];
  for (const group of groups) {
    group.plans = await skillPlan(group.source, group.target, state, group.name);
    for (const plan of group.plans) console.log(`skill ${plan.action}: ${plan.name} (${group.name})`);
  }
  const instructions = await instructionPlan(state);
  for (const plan of instructions) console.log(`instructions ${plan.before === plan.after ? 'same' : 'sync'}: ${plan.target}`);
  const mcp = state.agents.includes('codex') ? await planCodexMcp(state) : undefined;
  const toolNode = await planToolNode(state);
  describeToolNode(toolNode);
  return { groups, instructions, mcp, toolNode };
}

async function deploy(state: State, apply: boolean, plan: ConfigurationPlan | undefined = undefined): Promise<void> {
  const { groups, instructions, toolNode } = plan ?? await configurationPlan(state);
  const deployment = apply ? sourceRevision(state.source) : undefined;
  const { sync, postSkills } = planDeploy(state);
  for (const action of sync) await (apply ? action.apply() : action.preview());
  if (!apply) {
    const connectable = state.ready ? [] : planConnect(state).filter(action => action.kind !== 'note').map(action => action.host);
    if (connectable.length) console.log(`Connect native Kitto integrations: ${connectable.join(', ')}`);
    return;
  }
  await applyInstructions(state, instructions);
  await applyToolNode(state, toolNode);
  for (const { name, plans } of groups) {
    const owned: Record<string, string> = {};
    const kept: string[] = [];
    for (const plan of plans) {
      if (plan.action === 'copy') await replaceDirectory(plan.source, plan.target);
      else if (plan.action === 'remove') {
        const trash = `${plan.target}.kitto-remove-${process.pid}`;
        await rename(plan.target, trash);
        await rm(trash, { recursive: true, force: true });
      }
      if (plan.action === 'keep') kept.push(plan.name);
      else if (plan.action !== 'remove') owned[plan.name] = plan.hash!;
    }
    replaceScope(state, 'skill', name, { owned, kept });
  }
  await saveKittoState(kittoHome(), state);
  for (const action of postSkills) await action.apply();
  if (!state.ready) {
    await connectNative(state);
    state.runtimeHash = await treeHash(join(kittoHome(), 'runtime'));
  }
  state.deployed = deployment;
  state.ready = true;
  await saveKittoState(kittoHome(), state);
  await dropImportedPiFile(state);
}

async function dropImportedPiFile(state: State): Promise<void> {
  if (!state.migration?.pi?.imported) return;
  await rm(join(state.source, 'config/pi/local', MANAGED_PACKAGES_FILE), { force: true });
}

async function recover(state: State, apply: boolean): Promise<void> {
  if (state.detached || state.removing) throw new Error('Kitto integrations are being removed or already detached. Use setup to reconnect them.');
  const home = kittoHome(), previous = join(home, 'runtime.previous');
  if (!await present(join(home, 'runtime.previous.json'))) throw new Error('No verified runtime checkpoint. Rerun setup with a known working package version.');
  const checkpoint: RuntimeCheckpoint = await json(join(home, 'runtime.previous.json'));
  if (state.agents.includes('dsh') && (state.dshProfile || 'web') !== (checkpoint.dshProfile || 'web')) {
    throw new Error('The runtime checkpoint was verified with a different DSH profile.');
  }
  if (await treeHash(previous) !== checkpoint.hash) throw new Error('The runtime checkpoint was modified. Preserved; use a known working package version instead.');
  console.log(`Restore Kitto code ${state.pendingRuntime?.version || state.version} -> ${checkpoint.version}; reconnect ${state.agents.join(', ')}. Personal configuration and skills stay as deployed.`);
  if (!apply) return;
  state.ready = false;
  await saveKittoState(home, state);
  if (!await present(join(home, 'runtime')) || await treeHash(join(home, 'runtime')) !== checkpoint.hash) {
    const next = join(home, 'runtime.next');
    await rm(next, { recursive: true, force: true });
    await cp(previous, next, { recursive: true });
    await replaceRuntime(home, next);
  }
  state.version = checkpoint.version;
  delete state.pendingRuntime;
  await saveKittoState(home, state);
  await connectNative(state);
  state.runtimeHash = checkpoint.hash;
  state.ready = true;
  await saveKittoState(home, state);
}

async function remove(state: State, apply: boolean): Promise<void> {
  console.log(`Detach Kitto from ${state.agents.join(', ')}. Keep configuration, shared skills, agent CLIs and Kitto files for recovery/reinstallation.`);
  const remaining = state.agents.filter(name => !(state.removedAgents || []).includes(name));
  const detachments: Array<{ name: HostName; actions: HostAction[] }> = [];
  const launcher = await planLauncherRemoval(state);
  if (launcher.action !== 'absent') console.log(`launcher ${launcher.action}: ${launcher.target}`);
  for (const name of remaining) {
    const actions = await adapterFor(state, name).planDetach(state);
    for (const action of actions) await action.preview({ announce: !apply });
    detachments.push({ name, actions });
  }
  if (!apply) return;
  const home = kittoHome();
  state.ready = false; state.removing = true;
  await saveKittoState(home, state);
  for (const { name, actions } of detachments) {
    for (const action of actions) await action.apply();
    state.removedAgents = [...(state.removedAgents || []), name];
    await saveKittoState(home, state);
  }
  await applyLauncherRemoval(state, launcher);
  state.removing = false; state.detached = true;
  await saveKittoState(home, state);
}

async function refreshRuntime(state: State, apply: boolean): Promise<RuntimeRecord | undefined> {
  const home = kittoHome(), runtime = join(home, 'runtime');
  const fromInstalledRuntime = sameLocation(packageRoot, runtime);
  const current = state.version;
  if (!apply) {
    if (fromInstalledRuntime) console.log(`Runtime: ${current} (this entry runs from the installed copy; run update with the intended Kitto package to replace it).`);
    else {
      const next = (await json(join(packageRoot, 'package.json'))).version;
      console.log(next === current
        ? `Runtime: ${current} (re-synced from the executing package only if its files differ).`
        : `Runtime: ${current} -> ${next} (the previous verified version stays recoverable).`);
    }
    return undefined;
  }
  if (fromInstalledRuntime) {
    console.log(`Runtime: ${current} (the installed maintenance runner cannot replace itself; run update with the intended Kitto package to refresh the code copy).`);
    return undefined;
  }
  const installed = await installRuntime(home, state, state.agentsHome);
  const pending = { version: (await json(join(installed, 'package.json'))).version, hash: await treeHash(installed) };
  state.pendingRuntime = pending;
  await saveKittoState(home, state);
  console.log(pending.version === current
    ? `Runtime: ${pending.version} (re-synced; verified after deployment)`
    : `Runtime: ${current} -> ${pending.version} (verified after deployment; recover keeps ${current} until then)`);
  return pending;
}

async function finalizeRuntime(state: State, pending: RuntimeRecord | undefined): Promise<void> {
  if (!pending) return;
  state.version = pending.version;
  state.runtimeHash = pending.hash;
  delete state.pendingRuntime;
  await saveKittoState(kittoHome(), state);
}

function upstreamOf(state: State, branch: string): string {
  try {
    return git(state.source, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    throw new Error(`Branch ${branch} has no upstream. Set one with 'git branch --set-upstream-to=<remote>/${branch} ${branch}' or 'git push -u <remote> ${branch}', then retry.`);
  }
}

function restoreHint(state: State): string {
  const steps: string[] = [];
  if (state.sourceUrl) steps.push(`git clone ${shellQuote(redactUrl(state.sourceUrl))} ${shellQuote(state.source)}`);
  if (state.sourceRef) steps.push(`git -C ${shellQuote(state.source)} checkout ${shellQuote(state.sourceRef)}`);
  return steps.length ? `Recreate the checkout in place (${steps.join(' && ')})` : `Recreate the checkout in place at ${state.source}`;
}

function restoreError(state: State, detail: string): Error {
  return new Error(`${detail} ${restoreHint(state)} and rerun kitto setup; or use a new KITTO_HOME for a fresh installation.`);
}

async function checkRestoreRef(state: State): Promise<void> {
  const ref = state.sourceRef;
  if (!ref) return;
  let heads: string, tags: string;
  try {
    heads = run('git', ['ls-remote', '--heads', state.sourceUrl, `refs/heads/${ref}`], { capture: true, timeout: 30_000 });
    tags = run('git', ['ls-remote', '--tags', state.sourceUrl, `refs/tags/${ref}`], { capture: true, timeout: 30_000 });
  } catch (error) {
    throw restoreError(state, `Cannot inspect ${redactUrl(state.sourceUrl)}: ${(error as Error).message}.`);
  }
  if (heads && tags) throw restoreError(state, `The recorded ref ${ref} exists as both a branch and a tag on ${redactUrl(state.sourceUrl)}.`);
  if (tags) throw restoreError(state, `The checkout was pinned to tag ${ref} and Kitto does not guess pinned snapshots.`);
  if (!heads) throw restoreError(state, `Branch ${ref} no longer exists on ${redactUrl(state.sourceUrl)}.`);
}

async function syncSourceLocation(state: State, apply: boolean): Promise<void> {
  if (!state.sourceUrl) return;
  let origin: string;
  try { origin = git(state.source, ['config', '--local', '--get', 'remote.origin.url']); } catch { return; }
  if (!origin || origin === state.sourceUrl) return;
  if (!isGitUrl(origin)) {
    console.log(`Configuration origin is not a Git URL; keeping ${redactUrl(state.sourceUrl)} for recovery.`);
    return;
  }
  console.log(`Configuration source URL changed: ${redactUrl(state.sourceUrl)} -> ${redactUrl(origin)}.`);
  if (!apply) return;
  state.sourceUrl = origin;
  const markerPath = bootstrapMarker(state.source);
  if (await present(markerPath)) {
    const marker: BootstrapMarker = await json(markerPath).catch(() => ({}));
    await atomicJson(markerPath, { ...marker, url: origin });
  }
  await saveKittoState(kittoHome(), state);
}

async function backfillSource(state: State): Promise<void> {
  if (!await present(state.source)) return;
  const markerPath = bootstrapMarker(state.source);
  if (!await present(markerPath)) return;
  const marker = await json(markerPath).catch((): undefined => undefined);
  if (!marker) return;
  let changed = false;
  if (marker.url && !state.sourceUrl) { state.sourceUrl = marker.url; changed = true; }
  if (state.sourceRef === undefined) { state.sourceRef = marker.ref ?? null; changed = true; }
  if (!changed) return;
  console.log(`Recovered the configuration source from the bootstrap marker: ${redactUrl(state.sourceUrl)}${state.sourceRef ? ` (${state.sourceRef})` : ''}.`);
}

async function updateSource(state: State, apply: boolean): Promise<boolean> {
  if (!await present(state.source)) {
    if (!state.sourceUrl) throw restoreError(state, 'The Kitto configuration checkout is missing and no source URL was recorded.');
    if (state.deployed?.detached) throw restoreError(state, `The configuration checkout was pinned to a detached revision${state.sourceRef ? ` (${state.sourceRef})` : ''} and is missing. Kitto does not guess pinned snapshots.`);
    if (state.sourceRef === undefined) throw restoreError(state, 'The configuration checkout is missing and state.json does not record its branch or tag.');
    if (!isGitUrl(state.sourceUrl)) throw restoreError(state, 'The recorded source URL is not an HTTPS/SSH Git URL.');
    await checkRestoreRef(state);
    console.log(`Restore configuration checkout from ${redactUrl(state.sourceUrl)}${state.sourceRef ? ` (${state.sourceRef})` : ' (remote default branch)'}: ${state.source}`);
    if (!apply) return false;
    await cloneSource(kittoHome(), state.source, state.sourceUrl, state.sourceRef ?? undefined);
  }
  if (sourceRevision(state.source).detached) {
    throw new Error('Configuration is pinned to a detached revision. Run kitto setup --ref TAG to switch a Kitto-created checkout to another snapshot.');
  }
  if (git(state.source, ['status', '--porcelain'])) throw new Error('Source has local changes. Commit or resolve them before update; nothing was stashed or reset.');
  const branch = git(state.source, ['symbolic-ref', '--short', 'HEAD']);
  const upstream = upstreamOf(state, branch);
  const remote = git(state.source, ['config', `branch.${branch}.remote`]);
  const ref = git(state.source, ['config', `branch.${branch}.merge`]);
  if (remote === '.') throw new Error('A remote-tracking branch is required for update.');
  const before = sourceRevision(state.source).commit;
  if (!apply) {
    const head = run('git', ['-C', state.source, 'ls-remote', remote, ref], { capture: true, timeout: 30_000 }).split('\n')[0]?.split(/\s+/)[0];
    console.log(`Configuration ${branch}: local ${before.slice(0, 7)}; remote ${head ? head.slice(0, 7) : '(no matching ref)'} (not fetched).`);
    return false;
  }
  git(state.source, ['fetch', remote]);
  const isAncestor = (earlier: string, later: string) => spawnSync('git', ['-C', state.source, 'merge-base', '--is-ancestor', earlier, later],
    { stdio: 'ignore', timeout: 30_000 }).status === 0;
  if (!isAncestor(before, upstream) && !isAncestor(upstream, before)) {
    throw new Error(`The remote branch ${upstream} and the local branch ${branch} have diverged (neither is an ancestor of the other). Kitto only fast-forwards; reconcile manually (for example git pull --rebase) and retry. Nothing was changed.`);
  }
  git(state.source, ['pull', '--ff-only']);
  const after = sourceRevision(state.source).commit;
  console.log(after === before
    ? `Configuration ${branch} is already at ${after.slice(0, 7)}.`
    : `Configuration ${branch} fast-forwarded ${before.slice(0, 7)} -> ${after.slice(0, 7)}.`);
  await validateSource(state);
  return true;
}

export async function update(args: string[] = []): Promise<void> {
  if (args.includes('--check') && args.includes('--apply')) throw new Error('Choose either --check or --apply for update.');
  if (args.includes('--include-private') && args.includes('--no-include-private')) throw new Error('Choose either --include-private or --no-include-private for update.');
  const unknown = args.filter((flag: string) => !['--check', '--apply', '--include-private', '--no-include-private'].includes(flag));
  if (unknown.length) throw new Error(`Unknown update option: ${unknown[0]}. Read the Kitto skill.`);
  const apply = args.includes('--apply');
  const includePrivate = args.includes('--include-private') ? true
    : args.includes('--no-include-private') ? false : undefined;
  const home = kittoHome();
  const state = await loadKittoState(home, { dryRun: true }).catch((error: NodeJS.ErrnoException): null => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!state) throw new Error(`Kitto is not set up in ${home}. Run kitto setup first.`);
  if (state.detached || state.removing) throw new Error('Kitto is detached or removal is incomplete. Use setup to reconnect, or finish remove.');
  console.log(`Kitto ${state.version} update${apply ? '' : ' preview (no writes)'}.`);
  hostCliVersions(state);
  const work = async () => {
    if (apply) await loadKittoState(home);
    if (includePrivate !== undefined) state.includePrivate = includePrivate;
    await backfillSource(state);
    const updated = await updateSource(state, apply);
    if (!updated) {
      if (await present(state.source)) {
        await syncSourceLocation(state, false);
        const plan = await configurationPlan(state);
        await deploy(state, false, plan);
      }
      await refreshRuntime(state, false);
      console.log('Preview only: restore the checkout if missing, fetch and fast-forward the source branch, refresh the Kitto runtime copy, then deploy configuration, skills and MCP. No writes.');
      return;
    }
    await syncSourceLocation(state, true);
    const plan = await configurationPlan(state);
    const pending = await refreshRuntime(state, true);
    try {
      await deploy(state, true, plan);
    } catch (error) {
      if (pending) console.error(`kitto: runtime ${pending.version} stays unverified because the deployment did not finish. `
        + 'Rerun `kitto update --apply` to finish, or `kitto setup --recover` to return to the previous runtime.');
      throw error;
    }
    await finalizeRuntime(state, pending);
    console.log(`Kitto update complete: runtime ${state.version}, configuration ${sourceRevision(state.source).commit.slice(0, 7)}. Restart native hosts to load new plugin code.`);
  };
  if (apply) await locked(home, work); else await work();
}

function sourceRevision(source: string): SourceRevision {
  const status = git(source, ['status', '--porcelain', '--branch']).split('\n');
  return {
    commit: git(source, ['rev-parse', 'HEAD']),
    dirty: status.length > 1,
    detached: status[0] === '## HEAD (no branch)',
  };
}

const bootstrapMarker = (source: string) => join(source, '.git', 'kitto-bootstrap.json');

async function cloneSource(home: string, source: string, url: string, ref?: string): Promise<void> {
  const staging = await mkdtemp(join(home, 'config.clone-'));
  try {
    run('git', ['clone', ...(ref ? ['--branch', ref] : []), '--', url, staging]);
    await atomicJson(bootstrapMarker(staging), { url, ref: ref ?? null });
    if (await present(source)) throw new Error(`Configuration destination already exists: ${source}`);
    await rename(staging, source);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function setup(options: KittoOptions = {}): Promise<void> {
  const boundary = options['routing-boundary'], routingRoutes = options['routing-routes'];
  if (routingRoutes !== undefined && boundary === undefined) throw new Error('--routing-routes requires --routing-boundary custom.');
  if (options.global || Object.hasOwn(options, 'workspace') || Object.hasOwn(options, 'workspace-parent')) {
    if (boundary !== undefined) throw new Error('Routing boundary requires full local Kitto setup, not scoped setup.');
    if (options['include-private'] || options['no-include-private']) {
      throw new Error('--include-private and --no-include-private apply to global setup/update; scoped setup does not sync MCP servers.');
    }
    const { setupScope } = await import('./scope-setup.ts');
    return setupScope(options);
  }
  if (options['dsh-service']) throw new Error('--dsh-service requires --workspace PATH.');
  const home = kittoHome(), statePath = join(home, 'state.json');
  if (options.recover) {
    const dryRun = options['dry-run'] === true;
    const work = async () => recover(await loadKittoState(home, { dryRun }), !dryRun);
    return options['dry-run'] ? work() : locked(home, work);
  }
  const readState = () => readFile(statePath, 'utf8').catch((error: NodeJS.ErrnoException): null => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const baseline = await readState();
  const old: Partial<State> = baseline ? await loadKittoState(home, { dryRun: true }) : {};
  const agents = options.agents ? [...new Set([...(old.agents || []), ...options.agents])]
    : old.agents || (Object.keys(hosts) as HostName[]).filter(availableHost);
  if (!agents.length) throw new Error('No agent detected. Select --agents pi,codex,dsh; add --install-agents to install missing CLIs.');
  const dshProfile = validateDshProfile(options['dsh-profile'] ?? old.dshProfile ?? 'web');
  if (options['dsh-profile'] && !agents.includes('dsh')) throw new Error('--dsh-profile requires DSH.');
  const installPnpm = agents.includes('dsh') && !isDesktopProfile(dshProfile) && !available('pnpm');
  if (installPnpm && !options['install-agents']) throw new Error('DSH native plugin operations require pnpm on PATH. Add --install-agents to install the missing prerequisite.');
  if (installPnpm) console.log(`Install missing DSH prerequisite: pnpm@${pnpmVersion}`);
  if (!available('git')) throw new Error('git is required.');
  if (old.agents?.includes('dsh') && !old.detached && dshProfile !== (old.dshProfile || 'web')) {
    throw new Error('Detach the existing Kitto integration before selecting a different DSH profile.');
  }
  const requested = options.source || old.source || defaultSource;
  const local = existsSync(requested);
  const source = local ? await realpath(requested) : join(await realpath(home).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return home;
    throw error;
  }), 'config');
  if (old.source && source !== old.source) {
    const sameSource = basename(source) === basename(old.source) && sameLocation(dirname(source), dirname(old.source));
    if (!sameSource) throw new Error('This installation already has a source. Keep it or use a separate KITTO_HOME; source switching is not implicit.');
  }
  if (!local && !isGitUrl(requested)) throw new Error('Source must be an existing checkout or HTTPS/SSH Git URL.');
  let switchTag = false, ownedSource = false;
  const markerPath = bootstrapMarker(source);
  if (options.ref && await present(markerPath)) {
    const marker: BootstrapMarker = await json(markerPath);
    const origin = git(source, ['config', '--local', '--get', 'remote.origin.url']);
    ownedSource = (local || requested === marker.url) && origin === marker.url;
    switchTag = ownedSource && (marker.ref !== options.ref || (Boolean(old.source)
        && git(source, ['rev-parse', '--abbrev-ref', 'HEAD']) !== options.ref));
    if (switchTag) {
      if (!local && await realpath(source) !== source) throw new Error('Kitto checkout is a symlink. Preserved.');
      git(source, ['check-ref-format', `refs/tags/${options.ref}`]);
      if (sourceRevision(source).dirty) throw new Error('Source has local changes. Commit or resolve them before switching tags.');
    }
  }
  let resume = false;
  if (!local && await present(source)) {
    if (await present(bootstrapMarker(source)) && await realpath(source) === source) {
      const marker = await json(bootstrapMarker(source));
      resume = marker.url === requested && (switchTag || marker.ref === (options.ref ?? null))
        && git(source, ['config', '--local', '--get', 'remote.origin.url']) === requested;
    }
    if (!resume) throw new Error(`Unregistered checkout already exists at ${source}. Inspect it and rerun with --source ${shellQuote(source)}.`);
    console.log(`Resume setup from Kitto checkout: ${source}`);
  }
  if (local && options.ref && !ownedSource) throw new Error('Switch tags only in a Kitto-created checkout. For your own checkout, use Git.');
  const marker: BootstrapMarker | undefined = await present(markerPath) ? await json(markerPath).catch((): undefined => undefined) : undefined;
  const sourceUrl = local ? marker?.url : requested;
  const sourceRef: string | null = options.ref ?? marker?.ref ?? old.sourceRef ?? null;
  console.log(`Global setup: ${agents.join(', ')}; source: ${requested}; Kitto home: ${home}`);
  const checkedAgents = agents.filter(name => !(name === 'dsh' && isDesktopProfile(dshProfile)));
  checkSelectedHosts(checkedAgents, options['install-agents'], { requireBaseline: options['require-baseline'] === true });
  const includePrivate = options['include-private'] === true ? true
    : options['no-include-private'] === true ? false : old.includePrivate === true;
  const state: State = { ...old, schema: CURRENT_SCHEMA as 2, ready: false, detached: false, removing: false, removedAgents: [], source, agents, dshProfile,
    includePrivate, sourceUrl: sourceUrl || old.sourceUrl, sourceRef, pendingRuntime: undefined,
    agentsHome: old.agentsHome || resolve((agents.includes('pi') && process.env.PI_AGENTS_DIR)
      || (agents.includes('dsh') && process.env.DSH_AGENTS_HOME) || join(homedir(), '.agents')),
    piHome: old.piHome || resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent')),
    codexHome: old.codexHome || resolve(process.env.CODEX_HOME || join(homedir(), '.codex')),
    dshHome: old.dshHome || resolve(process.env.DSH_HOME || join(homedir(), '.dsh')),
    version: (await json(join(packageRoot, 'package.json'))).version,
  };
  if (options.serviceSetup === true) {
    if (boundary !== undefined) throw new Error('Do not copy a local routing boundary to a service account.');
    state.routingInstallKind = 'service';
  } else if (boundary !== undefined) {
    if (old.routingInstallKind === 'service' && boundary !== 'skip') throw new Error('Routing is not supported for a Kitto service account.');
    state.routingInstallKind = old.routingInstallKind === 'service' ? 'service' : 'local';
    setRoutingBoundary(state, boundary, routingRoutes);
    console.log(`Local model routing boundary: ${state.routingBoundary.mode}`);
  }
  if (options.keepExistingSkills === true) state.keepExistingSkills = true;
  if (agents.includes('codex') && !sameLocation(state.agentsHome, resolve(homedir(), '.agents'))) {
    throw new Error('Codex discovers shared skills in ~/.agents. Use that common root for PI_AGENTS_DIR / DSH_AGENTS_HOME when selecting Codex.');
  }
  if (agents.includes('dsh') && process.env.DSH_AGENTS_HOME && !sameLocation(process.env.DSH_AGENTS_HOME, state.agentsHome)) {
    throw new Error('DSH_AGENTS_HOME and the shared skill root differ. Use the same root so native DSH sessions can discover your skills.');
  }
  if (agents.includes('dsh')) {
    if (isDesktopProfile(dshProfile)) {
      console.log(`DSH profile: ${dshProfile} (global-only; managed by the Desktop app)`);
      reportDesktopProbe(probeDesktopProfile({ dshHome: state.dshHome }));
      console.log(desktopProfileNotice);
    } else {
      const builtIn = ['web', 'headless', 'sdk', 'sdk-minimal', 'acp'];
      if (!builtIn.includes(dshProfile) && !await present(join(state.dshHome, 'profiles', dshProfile, 'package.json'))) {
        throw new Error(`Initialize the native DSH profile ${dshProfile} before setup.`);
      }
      console.log(`DSH profile: ${dshProfile}`);
    }
  }
  if (options['dry-run']) {
    if (switchTag) console.log(`Would switch the Kitto checkout to tag ${options.ref} and deploy it.`);
    else if (local || resume) {
      await validateSource(state);
      await deploy(state, false);
    }
    console.log(isDesktopProfile(dshProfile)
      ? 'Preview only: clone if needed, persist Kitto runtime, deploy global rules and skills; the app-managed DSH desktop bundle and scopes stay untouched. No writes.'
      : 'Preview only: clone if needed, persist Kitto runtime, deploy selected configuration and skills, register native integrations. No writes.');
    return;
  }
  await locked(home, async () => {
    if (await readState() !== baseline) throw new Error('Kitto installation changed during setup. Run the same command again.');
    if (baseline) await loadKittoState(home);
    if (installPnpm) {
      run('npm', ['install', '--global', `pnpm@${pnpmVersion}`]);
      if (!available('pnpm')) throw new Error('pnpm was installed but cannot run. Check PATH and allow pnpm native-binary install scripts, then rerun setup.');
    }
    installMissingHosts(checkedAgents);
    if (!local && !resume) await cloneSource(home, source, requested, options.ref);
    if (switchTag) {
      if (sourceRevision(source).dirty) throw new Error('Source has local changes. Commit or resolve them before switching tags.');
      git(source, ['fetch', '--no-tags', 'origin', `refs/tags/${options.ref}`]);
      const commit = git(source, ['rev-parse', 'FETCH_HEAD^{commit}']);
      git(source, ['checkout', '--no-overwrite-ignore', '--detach', commit]);
      await atomicJson(bootstrapMarker(source), { ...(await json(bootstrapMarker(source)).catch(() => ({}))), ref: options.ref });
    }
    await validateSource(state);
    const plan = await configurationPlan(state);
    await installRuntime(home, old, state.agentsHome);
    await saveKittoState(home, state);
    await deploy(state, true, plan);
  });
  console.log(isDesktopProfile(dshProfile)
    ? 'Kitto setup complete. Fully quit and reopen DeepSeek Harness Desktop to load the deployed global rules and skills; ask the Kitto skill to maintain configuration.'
    : 'Kitto setup complete. Start your agent with its native command; ask the Kitto skill to maintain configuration.');
}

async function stateRollback(home: string, apply: boolean): Promise<void> {
  const path = stateFile(home);
  const text = await readFile(path, 'utf8');
  const current = JSON.parse(text);
  if ((current.schema ?? 1) === 1) {
    console.log('Kitto state is already schema 1; nothing to roll back.');
    return;
  }
  const target = downgradeState(current);
  const packages = Object.values(current.owned?.['pi-package']?.pi ?? {}).map((entry: any) => entry.spec);
  const packagesFile = packages.length && current.source ? join(current.source, 'config/pi/local', MANAGED_PACKAGES_FILE) : undefined;
  console.log(`Roll back ${path} from schema ${current.schema} to schema ${target.schema} so an older Kitto can read it.`);
  if (packagesFile) console.log(`Restore the Pi managed package list: ${packagesFile}`);
  if (!apply) {
    console.log('Preview only: nothing written. Rerun with --apply, then install the older Kitto package.');
    return;
  }
  await locked(home, async () => {
    if (packagesFile) await atomicJson(packagesFile, packages);
    await rollbackState(path);
  });
  console.log('State rolled back. Install the older Kitto package now.');
}

export async function maintain(args: string[]): Promise<void> {
  const [operation = 'status', ...flags] = args;
  if (operation === 'hosts') return hostsCommand(flags);
  const allowed: Record<string, string[]> = { status: [], versions: ['--online'], sync: ['--apply'], update: ['--check', '--apply'], export: ['--apply'], deps: ['--apply'], recover: ['--apply'], remove: ['--apply'], 'state-rollback': ['--apply'] };
  if (!allowed[operation] || flags.some((flag: string) => !allowed[operation].includes(flag))) throw new Error('Unsupported maintenance operation or flag. Read the Kitto skill.');
  if (operation === 'update') return update(flags);
  const home = kittoHome();
  const apply = flags.includes('--apply');
  if (operation === 'state-rollback') return stateRollback(home, apply);
  const state = await loadKittoState(home, { dryRun: true });
  const migrateThen = (work: () => Promise<void>) => async () => { await loadKittoState(home); return work(); };
  if (operation === 'recover' || operation === 'remove') {
    const work = () => operation === 'recover' ? recover(state, apply) : remove(state, apply);
    if (apply) await locked(home, migrateThen(work)); else await work();
    return;
  }
  if (operation === 'status' && (state.detached || state.removing || !await present(state.source))) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (state.detached || state.removing) throw new Error('Kitto is detached or removal is incomplete. Use setup to reconnect, or finish remove.');
  await validateSource(state);
  if (operation === 'status') {
    console.log(JSON.stringify({ ...state, checkout: sourceRevision(state.source), git: git(state.source, ['status', '--short', '--branch']) }, null, 2));
    await configurationPlan(state);
    for (const tool of await dependencyPlan(state)) console.log(`dependency ${tool.available ? 'available' : 'missing'}: ${tool.name} (${tool.reason})`);
    await reportCodeGraphIndexes(state);
    await printMcpParity(state);
    if (state.agents.includes('pi')) adapterFor(state, 'pi').status(state);
  } else if (operation === 'versions') {
    console.log(JSON.stringify(await versionReport(state, hosts, pnpmVersion, flags.includes('--online'), treeHash), null, 2));
  } else {
    const work = async () => {
      if (operation === 'deps') await installDependencies(state, apply);
      else if (operation === 'export') {
        if (!state.agents.includes('pi')) throw new Error('Pi export requires a Pi installation. Edit shared skills in the source checkout.');
        adapterFor(state, 'pi').exportConfig(state, apply);
      } else await deploy(state, apply);
    };
    if (apply) await locked(home, migrateThen(work)); else await work();
  }
}
