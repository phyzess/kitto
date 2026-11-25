import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

const messages = {
  'review-pending': 'DSH persistently archives this bound session. Offer manual worktree review in the current conversation; this does not establish quiescence, release a claim, or authorize cleanup.',
  'not-archived': 'The bound session is not in the DSH archive set. No archive reminder is pending.',
  unavailable: 'No verified local binding or authoritative DSH archive state is available. Leave the worktree and its claim alone.',
};

export function registerArchiveReview(ctx, enabled) {
  if (enabled !== true) return;
  ctx.inject(['profileContext', 'tools', 'workspaceRegistry', 'sessionPersistence'], (host) => {
    const { name, installAnchor } = host.profileContext;
    if (name !== 'web' || typeof installAnchor !== 'string' || !isAbsolute(installAnchor)) return;
    const require = createRequire(installAnchor);
    let defineTool;
    try {
      if (require('./package.json').name !== '@deepseek-ai/dsh') return;
      ({ defineTool } = require('@deepseek-ai/dsh-tools'));
    } catch { return; }
    if (typeof defineTool !== 'function') return;
    host.tools.register(defineTool({
      name: 'kitto_worktree_archive_review',
      description: 'Verify a named Kitto claim against the local DSH archive set. Read-only; call only for an explicit manual handoff or archive review. Never use this as cleanup authorization.',
      parameters: {
        repo: { type: 'string', required: true, description: 'Absolute path to the scoped primary checkout.' },
        task: { type: 'string', required: true, description: 'The explicitly named Kitto task ID.' },
        session: { type: 'string', required: true, description: 'The native DSH session ID deliberately registered as the Kitto claim ID.' },
      },
      output: {
        schema: { type: 'string', enum: Object.keys(messages) },
        render: (_args, state) => [{ type: 'text', text: messages[state] }],
      },
      async execute(args, exec) {
        if (exec.signal.aborted) return 'unavailable';
        try {
          const prior = host.workspaceRegistry.archivedSessionIds;
          if (!Array.isArray(prior)) return 'unavailable';
          const headers = (await host.sessionPersistence.list())
            .filter(snapshot => snapshot.header?.id === args.session);
          if (headers.length !== 1 || exec.signal.aborted) return 'unavailable';
          const { matchesArchiveClaim } = await import('../lib/worktree-lifecycle.mjs');
          if (!await matchesArchiveClaim(args, headers[0].header)) return 'unavailable';
          const current = host.workspaceRegistry.archivedSessionIds;
          if (exec.signal.aborted || !Array.isArray(current)) return 'unavailable';
          return current.includes(args.session) ? 'review-pending' : 'not-archived';
        } catch { return 'unavailable'; }
      },
    }));
  });
}
