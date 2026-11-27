import { readFile } from 'node:fs/promises';
import { kittoHome } from '../lib/kitto-home.ts';
import { updateNotice } from '../lib/update-notice.ts';
import { registerPiTaskRouting } from './pi-task-routing.ts';
import type { Json } from '../types/kitto.d.ts';

export default function kitto(pi: Json): void {
  registerPiTaskRouting(pi);
  pi.on('session_start', (_event: unknown, ctx: Json) => {
    if (!ctx.hasUI || process.env.KITTO_UPDATE_CHECK === '0') return;
    void readFile(new URL('../package.json', import.meta.url), 'utf8')
      .then((text: string) => updateNotice(kittoHome(), JSON.parse(text).version))
      .then((notice: string | undefined) => {
        if (notice) ctx.ui.notify(notice, 'info');
      })
      .catch(() => {});
  });
}
