import { watch } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { resolveScopes, scopeHome } from '../../lib/scopes.mjs';
import { importFromRunningDsh } from './native.mjs';

export const name = 'phyzess-kitto-scopes';
export const inject = ['skills', 'workingDirectory', 'systemPrompt', 'profileContext'];

async function optionalFile(path, signal) {
  try {
    const info = await stat(path);
    // Match DSH's native ceiling for a single instruction file.
    if (info.isFile() && info.size <= 1_048_576) return (await readFile(path, { encoding: 'utf8', signal })).trim();
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  }
}

function covers(parent, child) {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

function registerScopes(ctx, FileSystemSkillProvider, discoverBaselineInstructionFiles, nativeConfigByPreset) {
  ctx.skills.registerProvider(control => {
    const providers = new Map();
    const watcher = watch(scopeHome(), { persistent: false, signal: control.signal }, (_event, file) => {
      if (file === null || file === 'scopes.json') control.invalidate();
    });
    watcher.on('error', error => ctx.logger.warn(`Kitto scope registry watcher: ${error.message}`));
    return {
      name,
      async list({ cwd, signal }) {
        if (!cwd) return [];
        const directory = await realpath(cwd);
        const scopes = await resolveScopes(directory);
        const candidates = [];
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
              // Native project skills already have priority (ranks 100 and 200).
              rank: covers(root, directory) ? 225 : 525,
              locator: { skills, candidate },
            });
          }
        }
        return { candidates, complete };
      },
      async get({ locator }, { cwd, signal }) {
        if (!cwd || !(await resolveScopes(cwd)).some(scope => scope.skills === locator.skills)) return;
        const skill = await providers.get(locator.skills)?.get(locator.candidate, { cwd, signal });
        if (skill) return { ...skill, source: 'custom' };
      },
    };
  });

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    if (!context.agent) return assembly;
    const { signal } = context;
    const cwd = await ctx.workingDirectory.ensure(context.agent, signal);
    const scopes = await resolveScopes(cwd);
    if (!scopes.length) return assembly;
    const preset = ctx.get('agentPresets')?.composedPreset(context.agent.ctx);
    const nativeConfig = nativeConfigByPreset.get(preset) ?? nativeConfigByPreset.get(undefined);
    const nativePaths = new Set(ctx.get('fs') && nativeConfig?.maxBytes > 0
      ? (await discoverBaselineInstructionFiles({ ...nativeConfig, cwd: await realpath(cwd), signal }))
        .map(file => file.absolutePath)
      : []);
    const sections = [];
    for (const { instructions } of scopes) {
      // The built-in loader already supplies files in its baseline chain.
      if (!instructions || nativePaths.has(instructions)) continue;
      const text = await optionalFile(instructions, signal);
      if (text) sections.push(`# Project instructions from ${instructions}\n\n${text}`);
    }
    if (sections.length) assembly.contexts.push({ name, text: sections.join('\n\n'), interpolate: false });
    return assembly;
  });
}

function* activeRows(rows) {
  for (const row of rows) {
    if (row.disabled) continue;
    yield row;
    if (row.group && Array.isArray(row.config)) yield* activeRows(row.config);
  }
}

function nativeInstructionConfig(rows) {
  return Array.from(activeRows(rows)).find(row => row.id === 'agent-instructions')?.config;
}

export async function apply(ctx) {
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
