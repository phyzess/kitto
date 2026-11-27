import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { registerArchiveReview } from './dsh-archive-review.ts';
import { registerRouteEvidence } from './dsh-route-evidence.ts';
import { registerDshRouting } from './dsh-routing.ts';
import { registerDshTaskRouting } from './dsh-task-routing.ts';

export const name = 'phyzess-kitto';
export const inject = ['skills'];

export function apply(ctx, config) {
  const path = fileURLToPath(new URL('./skills/kitto/SKILL.md', import.meta.url));
  const candidate = {
    name: 'kitto', description: 'Maintain personal agent configuration or locate the installed Kitto CLI for routing, missing commands, or version mismatches.',
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
  registerDshTaskRouting(ctx);
  if (config?.routeEvidence === true) registerRouteEvidence(ctx);
  if (config?.routeDispatch === true) registerDshRouting(ctx);
}
