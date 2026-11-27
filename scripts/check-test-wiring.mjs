#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const { scripts } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const patterns = (scripts.test ?? '').split(/\s+/u).map(token => token.replace(/^["']|["']$/gu, '')).filter(token => token.startsWith('tests/'));
const toRegExp = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*')}$`, 'u');
const matchers = patterns.map(toRegExp);
const files = readdirSync(fileURLToPath(new URL('tests/', root))).filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`);
const missing = files.filter(file => !matchers.some(matcher => matcher.test(file)));
if (missing.length) {
  console.error(`Test files not run by "npm test":\n${missing.map(file => `  ${file}`).join('\n')}`);
  process.exit(1);
}
console.log(`All ${files.length} test files are covered by "npm test".`);
