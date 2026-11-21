import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { registerArchiveReview } from './dsh-archive-review.mjs';

export const name = 'phyzess-kitto';
export const inject = ['skills'];

// Only one catalog entry at startup; the body is loaded on demand.
export function apply(ctx, config) {
  const path = fileURLToPath(new URL('./skills/kitto/SKILL.md', import.meta.url));
  const candidate = {
    name: 'kitto', description: 'Inspect, synchronize and update personal agent configuration with Kitto.',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled', provider: 'phyzess-kitto', rank: 600, locator: path, path,
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('./skills/kitto/', import.meta.url)) },
  };
  ctx.skills.registerProvider(() => ({
    name: 'phyzess-kitto',
    list: async () => [candidate],
    get: async () => ({ ...candidate, content: (await readFile(path, 'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '') }),
  }));
  registerArchiveReview(ctx, config?.archiveReview);
}
