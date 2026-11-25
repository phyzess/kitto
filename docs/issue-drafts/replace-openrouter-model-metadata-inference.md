# Replace inferred OpenRouter model compatibility with an explicit contract

Status: filed as [#44](https://github.com/phyzess/kitto/issues/44).

## Context and goal

Pi's built-in OpenRouter flow can filter known chat model IDs by `/models/user` but historically cannot add an unknown ID. `config/pi/extensions/openrouter-live.ts` registers a native provider override and synthesizes key-usable IDs using progressively shortened same-family catalog names. The nearest name does not prove the new model shares thinking levels, input limits, prompt cache handling, or other compatibility fields. The wrapper also mirrors parts of Pi behavior that can drift when Pi upgrades.

## Scope and constraints

Prefer an upstream/runtime-supported live discovery contract; until it is available, make validated metadata or a narrowly maintained explicit mapping the condition for adding a model. Preserve the native refresh lifecycle: stored snapshot with network disallowed first, then a network refresh with a resolved credential when permitted, with no new background process. Preserve bundled image/classifier paths, the last usable snapshot when no catalog is available, and credential filtering. Keep `OPENROUTER_LIVE_DISABLE=1`, `OPENROUTER_LIVE_SYNTH=off`, `OPENROUTER_LIVE_REQUIRE_TOOLS=0`, and `OPENROUTER_LIVE_CATALOG_BASE_URL` behavior unless separately approved. Do not send real keys or depend on the live service for CI.

## Acceptance and verification

- With fixture catalog and `/models/user` data, an available new ID whose nearest name has incompatible capabilities is not registered with guessed metadata. A validated new ID is registered with live pricing/limits, allowed input intersected with supported modalities, and the correct compatibility contract.
- Regression fixtures cover duplicate type/ID precedence, denied IDs, missing live data vs. an authoritative empty allowlist, network failure after a successful refresh, and offline restore. Verify unknown families and unsupported media/routing variants remain conservative, including `:free`/`:batch`.
- Verify the selected Pi version's built-in refresh hooks and non-chat provider behavior against a deterministic fake responder. Keep the override or a clearly documented off-ramp until a supported upstream path passes these cases.
