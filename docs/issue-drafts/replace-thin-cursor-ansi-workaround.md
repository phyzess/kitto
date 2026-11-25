# Use a supported Pi cursor mode instead of editing rendered ANSI output

Status: filed as [#45](https://github.com/phyzess/kitto/issues/45).

## Context and goal

`config/pi/extensions/thin-cursor.ts` makes a bar-shaped hardware cursor visible by stripping one inverse-video sequence from each rendered editor line. It looks after `CURSOR_MARKER` when present, otherwise from column zero. Without a marker it can strip unrelated inverse styling; otherwise it depends on Pi's renderer continuing to encode the cursor with the same sequences.

## Scope and constraints

Prefer a supported upstream editor/cursor mode or a precise, testable cursor representation instead of broad ANSI searching. Preserve plain glyphs and display width, unrelated inverse styling, and the trailing reset. As long as the current extension exists, enable the hardware cursor with Pi `showHardwareCursor: true` or `PI_HARDWARE_CURSOR=1`; with neither, its current renderer can leave no visible cursor. Remove or rename the `.ts` extension to fall back to Pi defaults.

## Acceptance and verification

- A deterministic renderer fixture with inverse styling and no marker retains that styling. A fixture with a cursor marker, unrelated styling, and a wide glyph preserves both displayed width and non-cursor attributes.
- Verify manually in a terminal configured for a bar cursor, with hardware cursor enabled and disabled, that the user has a visible cursor (explicit fallback or opt-in). Test the supported Pi versions; no model login or network is required.
