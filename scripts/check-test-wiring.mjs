#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const { default: config } = await import(new URL('vite.config.mjs', root));
const patterns = config.test?.include ?? [];
const escape = text => text.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
const toRegExp = glob => new RegExp(`^${glob.split('**/').map(part => escape(part).replace(/\*/gu, '[^/]*')).join('(?:.*/)?')}$`, 'u');
const matchers = patterns.map(toRegExp);
const files = readdirSync(fileURLToPath(new URL('tests/', root))).filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`);
const missing = files.filter(file => !matchers.some(matcher => matcher.test(file)));
if (missing.length) {
  console.error(`Test files not run by "npm test":\n${missing.map(file => `  ${file}`).join('\n')}`);
  process.exit(1);
}
console.log(`All ${files.length} test files are covered by "npm test".`);
