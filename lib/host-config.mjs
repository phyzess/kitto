import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const begin = '<!-- kitto:begin -->', end = '<!-- kitto:end -->';
const optionalText = async path => {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

// One canonical form for shared-layer files: no BOM, LF line endings.
export function normalizeInstructions(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

// Shared rules first, then the host addendum. Keep this byte-identical to
// compose_agents() in lib/pi_config.py, which the Pi adapter uses.
export function composeInstructions(...sections) {
  const parts = sections
    .map(section => (typeof section === 'string' ? normalizeInstructions(section).trim() : ''))
    .filter(Boolean);
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

export function hostSkillRoots(state) {
  return state.agents.map(name => ({
    name,
    source: join(state.source, 'config', name, 'skills'),
    target: join(state[name + 'Home'], 'skills'),
  }));
}

export async function instructionPlan(state) {
  const plans = [];
  const common = await optionalText(join(state.source, 'config/instructions/common.md'));
  if (common?.includes(begin) || common?.includes(end)) throw new Error('Reserved Kitto markers in shared instructions.');
  for (const name of state.agents.filter(name => name !== 'pi')) {
    const addendum = await optionalText(join(state.source, 'config', name, 'AGENTS.md'));
    const home = state[name + 'Home'];
    const target = join(home, 'AGENTS.md');
    if (common === null && addendum === null && !state.instructions?.[name]) continue;
    if (addendum?.includes(begin) || addendum?.includes(end)) throw new Error(`Reserved Kitto markers in ${name} instructions.`);
    const stat = await lstat(target).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && !stat.isFile()) throw new Error(`Instruction target is not a regular file: ${target}`);
    const before = (await optionalText(target)) || '';
    const start = before.indexOf(begin), finish = before.indexOf(end);
    const previous = state.instructions?.[name];
    const body = composeInstructions(common, addendum);
    const block = body ? `${begin}\n${body}${end}\n` : '';
    let after;
    if (start < 0 && finish < 0) {
      after = block ? before + (before && !before.endsWith('\n') ? '\n' : '') + block : before;
    } else {
      if (start < 0 || finish < start || before.indexOf(begin, start + begin.length) !== -1 ||
          before.indexOf(end, finish + end.length) !== -1) throw new Error(`Invalid Kitto block in ${target}. Preserved.`);
      const stop = finish + end.length + (before[finish + end.length] === '\n' ? 1 : 0);
      const current = before.slice(start, stop);
      if (current !== previous && current !== block) throw new Error(`Local changes inside the Kitto block in ${target}. Preserved.`);
      after = before.slice(0, start) + block + before.slice(stop);
    }
    if (name === 'codex' && block && existsSync(join(home, 'AGENTS.override.md'))) {
      console.log('Codex AGENTS.override.md takes precedence over the synced AGENTS.md.');
    }
    plans.push({ name, target, before, after, block, mode: stat?.mode });
  }
  return plans;
}

export async function applyInstructions(state, plans) {
  state.instructions ||= {};
  for (const { name, target, before, after, block, mode } of plans) {
    if (after !== before) {
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, after, { flag: 'wx', mode: mode ?? 0o600 });
        if (((await optionalText(target)) || '') !== before) throw new Error(`Instructions changed during sync: ${target}`);
        await rename(temporary, target);
      } finally { await rm(temporary, { force: true }); }
    }
    if (block) state.instructions[name] = block;
    else delete state.instructions[name];
  }
}
