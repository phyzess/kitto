
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";

const INVERSE = "\x1b[7m";

function stripCursorBlock(line: string): string {
  const marker = line.indexOf(CURSOR_MARKER);
  const at = line.indexOf(INVERSE, marker >= 0 ? marker : 0);
  if (at < 0) {
    return line;
  }
  return line.slice(0, at) + line.slice(at + INVERSE.length);
}

class ThinCursorEditor extends CustomEditor {
  render(width: number): string[] {
    return super.render(width).map(stripCursorBlock);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, kb) => new ThinCursorEditor(tui, theme, kb));
  });
}
