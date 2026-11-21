---
name: codegraph
description: Use CodeGraph, when available and indexed, for code structure, call graphs, and impact analysis.
---

# codegraph

Use CodeGraph for structural questions when the current agent exposes its MCP tools and the repository is indexed. A binary on PATH alone does not make those tools available.

If the MCP tools are unavailable, the repository is unindexed, or a query fails, continue with native code search, source reads, and the language server when available. Do not install or configure CodeGraph as a side effect of an ordinary task. The CodeGraph-specific workflow below applies only when its tools are available.

## Host notes

- **DSH** prefixes MCP tool names with `mcp__codegraph__` (for example `mcp__codegraph__codegraph_explore`). Its MCP server has no default project, so pass the absolute repository path as `projectPath` on every call.
- **Pi/Codex** may expose the same tools without the prefix.
- Every queried repository needs its own `.codegraph/` index. Kitto's `setup`, `sync --apply`, and `status` report missing indexes; `setup` and `sync --apply` also run `codegraph init` automatically when the CLI is available. You can always run `codegraph init` in a repository yourself.
- If the host exposes only a subset of the tools, use what is listed in the current session.

## When to Use This Skill

**Use codegraph FIRST (before grep/rg/find/read) whenever you need to:**

- Find which functions/methods call a specific symbol (callers)
- Find what functions/methods a symbol calls (callees)
- Understand the impact of changing a function/class (impact analysis)
- Explore a code area with symbols, source, and call paths in one shot
- Look up a symbol's source code with its caller/callee trail
- Search for symbols across the entire codebase
- Navigate unfamiliar code — codegraph gives structural answers that grep cannot

## When NOT to Use

- Reading a known file path (use `read`)
- File system operations (use `bash`, `ls`, `find`)
- Editing or writing files (use `edit`, `write`)
- Running build/test commands (use `bash`)

## Available Tools

### Primary
- `codegraph_explore` — Explore an area: relevant symbols' source + call paths in one shot. Best for "how does X work?"
- `codegraph_node` — One symbol's source + caller/callee trail, or read a file with line numbers + dependents

### Secondary
- `codegraph_search` — Search for symbols by name
- `codegraph_callers` — List all callers of a symbol
- `codegraph_callees` — List all callees of a symbol
- `codegraph_impact` — Analyze what code is affected by changing a symbol
- `codegraph_files` — Indexed file tree with language and symbol counts
- `codegraph_status` — Index health, file/node/edge counts, and staleness

`codegraph affected` exists only as a CLI command (it is not exposed as an MCP tool in CodeGraph 1.6.x). Use `codegraph affected <files>` in the shell when you need affected test files.

## Workflow Pattern

1. **Exploring unknown code:** use `codegraph_explore` with a natural-language query describing what you're looking for
2. **Tracing call chains:** use `codegraph_node` on a symbol to see callers and callees
3. **Before refactoring:** use `codegraph_impact` to understand blast radius
4. **After making changes:** use `codegraph_impact` and `codegraph_callers` to find affected code; use `codegraph affected <files>` in the shell for affected test files
5. **Finding implementations:** use `codegraph_search` to locate symbols by name

## Anti-patterns
- Do NOT grep for function names to find callers — use `codegraph_callers`
- Do NOT manually trace imports to understand dependencies — use `codegraph_node`
- Do NOT guess which tests to run after changes — use `codegraph affected` (CLI) when available
