import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { resolveScopes } from '../../lib/scopes.ts';

async function ifPresent(callback) {
  try {
    return await callback();
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
}

function contains(parent, path) {
  const suffix = relative(parent, path);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

export default function kittoScopes(pi) {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const options = separator === -1 ? args : args.slice(0, separator);
  if (!options.includes('--no-skills') && !options.includes('-ns')) {
    pi.on('resources_discover', async ({ cwd }) => {
      const scopes = await resolveScopes(cwd);
      const skillPaths = [];
      for (const { skills } of scopes.toReversed()) {
        if (skills && (await ifPresent(() => stat(skills)))?.isDirectory()) skillPaths.push(skills);
      }
      return { skillPaths };
    });
  }

  if (!options.includes('--no-context-files') && !options.includes('-nc')) {
    pi.on('before_agent_start', async ({ systemPromptOptions }, { cwd }) => {
      const files = systemPromptOptions?.contextFiles;
      if (!files) return;
      const scopes = await resolveScopes(cwd);
      if (!scopes.length) return;

      const seen = new Set(await Promise.all(files.map(async ({ path }) => await ifPresent(() => realpath(path)) ?? path)));
      const directories = await Promise.all(files.map(async ({ path }) => {
        const directory = dirname(path);
        return await ifPresent(() => realpath(directory)) ?? directory;
      }));
      const canonicalCwd = await realpath(cwd);
      for (const { root, instructions } of scopes) {
        if (!instructions) continue;
        const canonical = await ifPresent(() => realpath(instructions));
        if (!canonical || seen.has(canonical) || !(await ifPresent(() => stat(instructions)))?.isFile()) continue;
        const content = await ifPresent(() => readFile(instructions, 'utf8'));
        if (content === undefined) continue;
        const index = directories.findIndex(directory => contains(root, directory));
        const position = index >= 0 ? index : contains(root, canonicalCwd) ? files.length : 0;
        files.splice(position, 0, { path: instructions, content: content.replace(/^\uFEFF/, '') });
        directories.splice(position, 0, root);
        seen.add(canonical);
      }
    });
  }
}
