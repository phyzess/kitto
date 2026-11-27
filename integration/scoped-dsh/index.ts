import { watch } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { resolveScopes, scopeHome } from '../../lib/scopes.ts';
import { importFromRunningDsh } from './native.ts';
import type { DshPluginContext } from '../../types/kitto.d.ts';

type SkillCandidate = Record<string, unknown>;

interface SkillControl {
  signal: AbortSignal;
  invalidate(): void;
}

interface SkillLocator {
  skills: string;
  candidate: SkillCandidate;
}

interface ExternalSkillProvider {
  list(input: { cwd?: string; signal?: AbortSignal }): Promise<SkillCandidate[] | { candidates: SkillCandidate[]; complete: boolean }>;
  get(candidate: SkillCandidate, input: { cwd?: string; signal?: AbortSignal }): Promise<Record<string, unknown> | undefined>;
}

interface PatchRow {
  disabled?: unknown;
  group?: unknown;
  config?: unknown;
  id?: unknown;
  name?: unknown;
}

interface PromptAssembly {
  contexts: Array<{ name: string; text: string; interpolate: boolean }>;
}

interface PromptContext {
  agent?: { ctx?: unknown };
  signal?: AbortSignal;
}

export const name = 'phyzess-kitto-scopes';
export const inject = ['skills', 'workingDirectory', 'systemPrompt', 'profileContext'];

async function optionalFile(path: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.isFile() && info.size <= 1_048_576) return (await readFile(path, { encoding: 'utf8', signal })).trim();
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code as string)) throw error;
  }
}

function covers(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

function registerScopes(
  ctx: DshPluginContext,
  FileSystemSkillProvider: any,
  discoverBaselineInstructionFiles: any,
  nativeConfigByPreset: Map<unknown, Record<string, unknown> | undefined>,
) {
  ctx.skills.registerProvider((rawControl) => {
    const control = rawControl as SkillControl;
    const providers = new Map<string, ExternalSkillProvider>();
    const watcher = watch(scopeHome(), { persistent: false, signal: control.signal }, (_event: string, file: string | null) => {
      if (file === null || file === 'scopes.json') control.invalidate();
    });
    watcher.on('error', (error: Error) => ctx.logger.warn(`Kitto scope registry watcher: ${error.message}`));
    return {
      name,
      async list({
        cwd,
        signal,
      }: {
        cwd?: string;
        signal?: AbortSignal;
      }): Promise<SkillCandidate[] | { candidates: SkillCandidate[]; complete: boolean }> {
        if (!cwd) return [];
        const directory = await realpath(cwd);
        const scopes = await resolveScopes(directory);
        const candidates: SkillCandidate[] = [];
        let complete = true;
        for (const { skills, root } of scopes.toReversed()) {
          if (!skills) continue;
          signal?.throwIfAborted();
          let provider = providers.get(skills);
          if (!provider) {
            const created = new FileSystemSkillProvider(ctx, control, {
              providerName: name,
              includeDefaultRoots: false,
              bundledSkillDir: skills,
            }) as ExternalSkillProvider;
            providers.set(skills, created);
            provider = created;
          }
          const result = await provider.list({ cwd, signal });
          complete &&= Array.isArray(result) || result.complete;
          for (const candidate of Array.isArray(result) ? result : result.candidates) {
            candidates.push({
              ...candidate,
              source: 'custom',
              rank: covers(root, directory) ? 225 : 525,
              locator: { skills, candidate },
            });
          }
        }
        return { candidates, complete };
      },
      async get({ locator }: { locator: SkillLocator }, { cwd, signal }: { cwd?: string; signal?: AbortSignal }) {
        if (!cwd || !(await resolveScopes(cwd)).some((scope: { skills: string }) => scope.skills === locator.skills)) return;
        const skill = await providers.get(locator.skills)?.get(locator.candidate, { cwd, signal });
        if (skill) return { ...skill, source: 'custom' };
      },
    };
  });

  ctx.on('system-prompt/assemble', async (_assembly: unknown, context: PromptContext, next: () => Promise<PromptAssembly>) => {
    const assembly = await next();
    if (!context.agent) return assembly;
    const { signal } = context;
    const cwd = await ctx.workingDirectory.ensure(context.agent, signal);
    const scopes = await resolveScopes(cwd);
    if (!scopes.length) return assembly;
    const presets = ctx.get('agentPresets') as { composedPreset(agent: unknown): unknown } | undefined;
    const preset = presets?.composedPreset(context.agent.ctx);
    const nativeConfig = nativeConfigByPreset.get(preset) ?? nativeConfigByPreset.get(undefined);
    const nativePaths = new Set(
      ctx.get('fs') && Number(nativeConfig?.maxBytes) > 0
        ? (await discoverBaselineInstructionFiles({ ...nativeConfig, cwd: await realpath(cwd), signal })).map(
            (file: { absolutePath?: string }) => file.absolutePath,
          )
        : [],
    );
    const sections: string[] = [];
    for (const { instructions } of scopes) {
      if (!instructions || nativePaths.has(instructions)) continue;
      const text = await optionalFile(instructions, signal);
      if (text) sections.push(`# Project instructions from ${instructions}\n\n${text}`);
    }
    if (sections.length) assembly.contexts.push({ name, text: sections.join('\n\n'), interpolate: false });
    return assembly;
  });
}

function configOf(row: PatchRow): Record<string, unknown> | undefined {
  return typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config)
    ? (row.config as Record<string, unknown>)
    : undefined;
}

function* activeRows(rows: PatchRow[]): Generator<PatchRow, void, undefined> {
  for (const row of rows) {
    if (row.disabled) continue;
    yield row;
    if (row.group && Array.isArray(row.config)) yield* activeRows(row.config as PatchRow[]);
  }
}

function nativeInstructionConfig(rows: PatchRow[]): Record<string, unknown> | undefined {
  const row = Array.from(activeRows(rows)).find((candidate) => candidate.id === 'agent-instructions');
  return row && configOf(row);
}

export async function apply(ctx: DshPluginContext): Promise<void> {
  const [{ FileSystemSkillProvider }, { discoverBaselineInstructionFiles }, { readProfilePatches, composeEntries }] = await Promise.all([
    importFromRunningDsh('@deepseek-ai/dsh-skill-filesystem'),
    importFromRunningDsh('@deepseek-ai/dsh-agent-instructions'),
    importFromRunningDsh('@deepseek-ai/dsh-app-boot'),
  ]);
  const rows = composeEntries([readProfilePatches('dsh', ctx.profileContext)]);
  const nativeConfigByPreset = new Map<unknown, Record<string, unknown> | undefined>([[undefined, nativeInstructionConfig(rows)]]);
  for (const row of activeRows(rows)) {
    const config = configOf(row);
    if (row.name !== '@deepseek-ai/dsh-agent-preset' || !Array.isArray(config?.plugins)) continue;
    nativeConfigByPreset.set(config.id, nativeInstructionConfig(config.plugins as PatchRow[]));
  }
  registerScopes(ctx, FileSystemSkillProvider, discoverBaselineInstructionFiles, nativeConfigByPreset);
}
