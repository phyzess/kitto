# Reject conflicting JEV stdin sources and resolve credentials through a supported interface

Status: filed as [#48](https://github.com/phyzess/kitto/issues/48). Input validation and credential discovery can be scheduled independently.

## Context and goal

`skills/jev-decide/scripts/jev.mjs` reads stdin through EOF for each `@-`. The old example advertised `--state @- --questions @-`, but the second read has no second payload. The credential fallback also reads DSH's `refs` block using text patterns instead of a supported credential interface, so valid representation changes can break the fallback. Direct environment values remain preferred; the default Go endpoint and operator-supplied `JEV_ENDPOINT` are separate from source parsing.

## Scope and constraints

Validate the source combination before consuming stdin. If a combined stdin payload is worthwhile, specify a format explicitly rather than implying two consecutive unframed values. Prefer a supported DSH credential query or structured bounded parsing if the interface is unavailable; never print credential values or use a real credential in tests. Do not change billing route defaults or send source text to a live endpoint during verification.

## Acceptance and verification

- Pipe synthetic input into `node skills/jev-decide/scripts/jev.mjs --state @- --questions @-`; it fails with exit 2 and a clear single-stdin diagnostic before resolving credentials or issuing an HTTP request.
- With a stub responder, verify each single-stdin mode works when the other argument is inline or `@file`, payload matches expectations, and precedence holds for environment variables vs. the isolated `DSH_HOME` fixture. Malformed or unsupported credential storage fails without echoing either input or secret values.
