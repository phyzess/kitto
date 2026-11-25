import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { registerArchiveReview } from './dsh-archive-review.mjs';
import { registerRouteEvidence } from './dsh-route-evidence.mjs';
import { registerDshRouting } from './dsh-routing.mjs';

export const name = 'phyzess-kitto';
export const inject = ['skills'];

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
  if (config?.routeEvidence === true) registerRouteEvidence(ctx);
  if (config?.routeDispatch === true) registerDshRouting(ctx);
}
