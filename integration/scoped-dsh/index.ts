import { watch } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { resolveScopes, scopeHome } from '../../lib/scopes.ts';
import { importFromRunningDsh } from './native.ts';
import type { Json } from '../../types/kitto.d.ts';

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
  ctx: Json,
  FileSystemSkillProvider: any,
  discoverBaselineInstructionFiles: any,
  nativeConfigByPreset: Map<unknown, Json | undefined>,
) {
  ctx.skills.registerProvider((control: Json) => {
    const providers = new Map<string, Json>();
    const watcher = watch(scopeHome(), { persistent: false, signal: control.signal }, (_event: string, file: string | null) => {
      if (file === null || file === 'scopes.json') control.invalidate();
    });
    watcher.on('error', (error: Error) => ctx.logger.warn(`Kitto scope registry watcher: ${error.message}`));
    return {
      name,
      async list({ cwd, signal }: { cwd?: string; signal?: AbortSignal }): Promise<Json[] | { candidates: Json[]; complete: boolean }> {
        if (!cwd) return [];
        const directory = await realpath(cwd);
        const scopes = await resolveScopes(directory);
        const candidates: Json[] = [];
        let complete = true;
        for (const { skills, root } of scopes.toReversed()) {
          if (!skills) continue;
          signal?.throwIfAborted();
          let provider = providers.get(skills);
          if (!provider) {
            provider = new FileSystemSkillProvider(ctx, control, {
              providerName: name,
              includeDefaultRoots: false,
              bundledSkillDir: skills,
            });
            providers.set(skills, provider);
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
      async get({ locator }: Json, { cwd, signal }: { cwd?: string; signal?: AbortSignal }) {
        if (!cwd || !(await resolveScopes(cwd)).some((scope: { skills: string }) => scope.skills === locator.skills)) return;
        const skill = await providers.get(locator.skills)?.get(locator.candidate, { cwd, signal });
        if (skill) return { ...skill, source: 'custom' };
      },
    };
  });

  ctx.on('system-prompt/assemble', async (_assembly: unknown, context: Json, next: () => Promise<Json>) => {
    const assembly = await next();
    if (!context.agent) return assembly;
    const { signal } = context;
    const cwd = await ctx.workingDirectory.ensure(context.agent, signal);
    const scopes = await resolveScopes(cwd);
    if (!scopes.length) return assembly;
    const preset = ctx.get('agentPresets')?.composedPreset(context.agent.ctx);
    const nativeConfig = nativeConfigByPreset.get(preset) ?? nativeConfigByPreset.get(undefined);
    const nativePaths = new Set(
      ctx.get('fs') && nativeConfig?.maxBytes > 0
        ? (await discoverBaselineInstructionFiles({ ...nativeConfig, cwd: await realpath(cwd), signal })).map(
            (file: Json) => file.absolutePath,
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

function* activeRows(rows: Json[]): Generator<Json, void, undefined> {
  for (const row of rows) {
    if (row.disabled) continue;
    yield row;
    if (row.group && Array.isArray(row.config)) yield* activeRows(row.config);
  }
}

function nativeInstructionConfig(rows: Json[]) {
  return Array.from(activeRows(rows)).find((row: Json) => row.id === 'agent-instructions')?.config;
}

export async function apply(ctx: Json): Promise<void> {
  const [{ FileSystemSkillProvider }, { discoverBaselineInstructionFiles }, { readProfilePatches, composeEntries }] = await Promise.all([
    importFromRunningDsh('@deepseek-ai/dsh-skill-filesystem'),
    importFromRunningDsh('@deepseek-ai/dsh-agent-instructions'),
    importFromRunningDsh('@deepseek-ai/dsh-app-boot'),
  ]);
  const rows = composeEntries([readProfilePatches('dsh', ctx.profileContext)]);
  const nativeConfigByPreset = new Map([[undefined, nativeInstructionConfig(rows)]]);
  for (const row of activeRows(rows)) {
    if (row.name !== '@deepseek-ai/dsh-agent-preset' || !Array.isArray(row.config?.plugins)) continue;
    nativeConfigByPreset.set(row.config.id, nativeInstructionConfig(row.config.plugins));
  }
  registerScopes(ctx, FileSystemSkillProvider, discoverBaselineInstructionFiles, nativeConfigByPreset);
}
