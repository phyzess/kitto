import { readFile } from 'node:fs/promises';
import { kittoHome } from '../lib/kitto.mjs';
import { updateNotice } from '../lib/update-notice.mjs';
import { registerPiTaskRouting } from './pi-task-routing.mjs';

export default function kitto(pi) {
  registerPiTaskRouting(pi);
  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI || process.env.KITTO_UPDATE_CHECK === '0') return;
    void readFile(new URL('../package.json', import.meta.url), 'utf8')
      .then(text => updateNotice(kittoHome(), JSON.parse(text).version))
      .then(notice => { if (notice) ctx.ui.notify(notice, 'info'); })
      .catch(() => {});
  });
}
