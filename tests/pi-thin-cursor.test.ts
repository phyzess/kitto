import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';
import { pathToFileURL } from 'node:url';
import { hosts } from '../lib/host-pins.ts';

const extension = new URL('../config/pi/extensions/thin-cursor.ts', import.meta.url);
const settings = new URL('../config/pi/settings.json', import.meta.url);
const pin = hosts.pi.version;
const nativeBin = process.env.KITTO_NATIVE_BIN;
const piPackage = process.env.PI_TEST_PACKAGE ?? (nativeBin && resolve(nativeBin, '../@earendil-works/pi-coding-agent'));
const skipNative = !piPackage;
const esc = '\x1b';

function sandbox(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'kitto-thin-cursor-'));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const agent = join(home, 'agent');
  mkdirSync(join(agent, 'extensions'), { recursive: true });
  const synced = join(agent, 'extensions/thin-cursor.ts');
  writeFileSync(synced, 'throw new Error("stale editor should be replaced");');
  copyFileSync(extension, synced);
  return { home, agent, synced };
}

test('the synced migration module needs no host imports and installs no editor hook', async (t: TestContext) => {
  const { synced } = sandbox(t);
  const { default: activate } = await import(pathToFileURL(synced).href);
  const pi = new Proxy(
    {},
    {
      get(_target, key) {
        assert.fail(`Unexpected Pi API access: ${String(key)}`);
      },
    },
  );
  assert.equal(activate(pi), undefined);
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).showHardwareCursor, true);
});

const runner = String.raw`
import assert from 'node:assert/strict';
import { CustomEditor, SettingsManager } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, ProcessTerminal, TuiMainScreen, renderFakeCursor, visibleWidth } from '@earendil-works/pi-tui';
import activate from './thin-cursor.ts';

const [mode, setting] = process.argv.slice(2);
const hardware = SettingsManager.inMemory({ showHardwareCursor: setting === 'on' }).getShowHardwareCursor();
const terminal = mode === 'pty' ? new ProcessTerminal() : {};
const tui = new TuiMainScreen(terminal, hardware);
const theme = { borderColor: text => text };
const baseline = new CustomEditor(tui, theme, {});
const callbacks = [];
let editor = baseline;
activate({ on(event, handler) { if (event === 'session_start') callbacks.push(handler); } });
for (const handler of callbacks) handler({}, { ui: { setEditorComponent(factory) { editor = factory(tui, theme, {}); } } });

const inverse = '\x1b[7m';
const inverseOff = '\x1b[27m';
const reset = '\x1b[0m';
const styled = inverse + 'SELECTED' + inverseOff + reset;
const focus = CURSOR_MARKER + renderFakeCursor('界') + inverse + 'STYLED' + inverseOff + reset;
const unfocused = renderFakeCursor('F') + reset;

if (mode === 'render') {
  const original = CustomEditor.prototype.render;
  try {
    // Supply styled native rows at the extension boundary; the TUI still
    // resolves the real cursor protocol, and the old subclass would strip SGR 7.
    CustomEditor.prototype.render = () => [styled, focus, unfocused];
    assert.deepEqual(editor.render(40), baseline.render(40));
    assert.deepEqual(tui.resolveFakeCursors(editor.render(40)), [
      styled,
      CURSOR_MARKER + (hardware ? '界' : inverse + '界' + inverseOff) + inverse + 'STYLED' + inverseOff + reset,
      inverse + 'F' + inverseOff + reset,
    ]);
    assert.equal(visibleWidth(tui.resolveFakeCursors(editor.render(40))[1]), 8);
  } finally {
    CustomEditor.prototype.render = original;
  }
} else {
  assert(process.stdin.isTTY && process.stdout.isTTY);
  const original = CustomEditor.prototype.render;
  CustomEditor.prototype.render = () => [styled, focus, unfocused];
  tui.addChild(editor);
  try {
    tui.start();
    terminal.write('BEGIN_FRAME');
    tui.renderNow();
    terminal.write('END_FRAME');
  } finally {
    tui.stop();
    CustomEditor.prototype.render = original;
  }
}
`;

function fixture(t: TestContext) {
  assert.ok(piPackage);
  const { home, agent, synced } = sandbox(t);
  const actual = realpathSync(piPackage);
  const modules = dirname(dirname(actual));
  for (const name of ['pi-coding-agent', 'pi-tui']) {
    const details = JSON.parse(readFileSync(join(modules, '@earendil-works', name, 'package.json'), 'utf8'));
    assert.equal(details.version, pin, `${name} must match the pinned Pi version`);
  }
  symlinkSync(modules, join(home, 'node_modules'), 'dir');
  const profile = dirname(synced);
  const helper = join(profile, 'probe.mjs');
  writeFileSync(helper, runner);
  const env = { HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', TERM: 'xterm-256color', PATH: process.env.PATH };
  return { home, helper, env };
}

const pty = String.raw`
import errno, fcntl, os, pty, struct, subprocess, sys, termios
master, slave = pty.openpty()
proc = None
try:
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    proc = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    slave = None
    while True:
        try:
            data = os.read(master, 8192)
        except OSError as err:
            if err.errno == errno.EIO:
                break
            raise
        if not data:
            break
        sys.stdout.buffer.write(data)
    sys.exit(proc.wait())
finally:
    if proc is not None and proc.poll() is None:
        proc.kill()
        proc.wait()
    if slave is not None:
        os.close(slave)
    os.close(master)
`;

for (const setting of ['on', 'off']) {
  test(`pinned Pi resolves ANSI and wide graphemes with hardware cursor ${setting}`, { skip: skipNative }, (t: TestContext) => {
    const { home, helper, env } = fixture(t);
    const result = spawnSync(process.execPath, [helper, 'render', setting], { cwd: home, env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });

  test(`pinned Pi in a PTY shows the hardware cursor only when ${setting}`, { skip: skipNative }, (t: TestContext) => {
    const { home, helper, env } = fixture(t);
    const result = spawnSync('python3', ['-c', pty, process.execPath, helper, 'pty', setting], {
      cwd: home,
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const frame = result.stdout.match(/BEGIN_FRAME([\s\S]+?)END_FRAME/)?.[1];
    assert(frame, 'expected a complete PTY frame');
    assert(frame.includes(`${esc}[7mSELECTED${esc}[27m${esc}[0m`));
    assert(frame.includes(`${esc}[7mSTYLED${esc}[27m${esc}[0m`));
    assert.equal(frame.includes(`${esc}[7m界${esc}[27m`), setting === 'off');
    const visibility = frame.match(/\x1b\[\?25[hl]/g)?.at(-1);
    assert.equal(visibility, `${esc}[?25${setting === 'on' ? 'h' : 'l'}`);
  });
}
