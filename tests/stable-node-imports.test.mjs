import test from 'node:test';
import assert from 'node:assert/strict';
import { sortNodeImports } from '../scripts/stable-node-imports.mjs';

test('node builtin import runs are sorted and everything else is untouched', () => {
  const code = [
    '#!/usr/bin/env node',
    'import { a } from "../lib/a.mjs";',
    'import { readFile } from "node:fs/promises";',
    'import { existsSync } from "node:fs";',
    'import { b } from "../lib/b.mjs";',
    'import { join } from "node:path";',
    'import x from "@clack/prompts";',
    'const y = 1;',
  ].join('\n');
  assert.equal(sortNodeImports(code), [
    '#!/usr/bin/env node',
    'import { a } from "../lib/a.mjs";',
    'import { existsSync } from "node:fs";',
    'import { readFile } from "node:fs/promises";',
    'import { b } from "../lib/b.mjs";',
    'import { join } from "node:path";',
    'import x from "@clack/prompts";',
    'const y = 1;',
  ].join('\n'));
});

test('sorting is idempotent and independent of the input order', () => {
  const lines = ['import a from "node:os";', 'import b from "node:fs";', 'import c from "node:path";'];
  const forward = sortNodeImports(lines.join('\n'));
  assert.equal(sortNodeImports([...lines].reverse().join('\n')), forward);
  assert.equal(sortNodeImports(forward), forward);
});
