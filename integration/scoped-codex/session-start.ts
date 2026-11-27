import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { resolveScopes } from '../../lib/scopes.ts';
import type { Json } from '../../types/kitto.d.ts';

async function optional<T, F>(operation: () => Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await operation();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return fallback;
    throw error;
  }
}

async function skillCatalog(directory: string) {
  const entries = await optional(() => readdir(directory, { withFileTypes: true }), []);
  const skills: Json[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const path = join(directory, entry.name, 'SKILL.md');
    const file = await optional(() => readFile(path, 'utf8'), '');
    const metadata = file.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!metadata) continue;
    const name = metadata
      .match(/^name:[ \t]*(.*)$/m)?.[1]
      ?.trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    const field = metadata.match(/^description:[ \t]*([^\r\n]*)((?:\r?\n[ \t]+[^\r\n]*)*)/m);
    const description =
      field &&
      (/^[>|]/.test(field[1]) ? field[2] : field[1])
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/^(['"])(.*)\1$/, '$2');
    if (name) skills.push({ name, description, path });
  }
  return skills.sort((a, b) => a.path.localeCompare(b.path));
}

process.stdin.setEncoding('utf8');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { cwd } = JSON.parse(input);
if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Codex SessionStart requires an absolute cwd.');

const context: string[] = [];
const skills = new Map<string, Json>();
for (const scope of await resolveScopes(cwd)) {
  const instructions = await optional(() => readFile(scope.instructions, 'utf8'), '');
  if (instructions.trim()) context.push(`# Shared instructions from ${scope.instructions}\n\n${instructions.trim()}`);
  for (const skill of await skillCatalog(scope.skills)) skills.set(skill.name, skill);
}
if (skills.size) {
  const entries = [...skills.values()].map(({ name, description, path }) => `- ${name}${description ? ': ' + description : ''} (${path})`);
  context.push(
    [
      '# Kitto shared skills',
      'When a listed skill applies, read its SKILL.md and follow it. Resolve its relative resource paths from the directory containing that file.',
      ...entries,
    ].join('\n'),
  );
}
if (context.length) {
  context.unshift(
    'Apply the closest workspace’s shared instructions if scopes conflict. Follow repository instructions for any conflicting repository-specific guidance, including repository-local skills.',
  );
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.join('\n\n') },
    }),
  );
}
