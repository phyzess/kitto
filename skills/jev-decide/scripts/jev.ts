#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const KEY_NAMES = ['OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY'];
const STORE_LIMIT = 1024 * 1024;
const USAGE = `Usage: jev.ts --state <text|@file|@-> --questions <json|@file|@-> [--model <id>]

  --state      the text the model judges
  --questions  JSON object of {id: {type, instructions, criteria?}}; types: noul | choice | score
               Only one of --state and --questions may use @- (stdin).
  --model      decision model id (default jev-1.14; gpt-6-luna-decision and
               gemini-decision-1 take the same request)

Exit codes: 0 answered, 2 bad usage or missing key, 3 HTTP failure.`;

function fail(code, message) {
  console.error(`jev: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { model: 'jev-1.14' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) fail(2, `${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--state') opts.state = value();
    else if (arg === '--questions') opts.questions = value();
    else if (arg === '--model') opts.model = value();
    else fail(2, `unknown argument ${arg}\n\n${USAGE}`);
  }
  if (!opts.state) fail(2, 'missing --state');
  if (!opts.questions) fail(2, 'missing --questions');
  return opts;
}

async function source(value) {
  if (value === '@-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (value.startsWith('@')) return readFile(value.slice(1), 'utf8');
  return value;
}

function moduleRoots(packageDir) {
  const roots = [join(packageDir, 'node_modules')];
  const parent = dirname(packageDir);
  const modules = basename(parent).startsWith('@') ? dirname(parent) : parent;
  if (basename(modules) === 'node_modules') roots.push(modules);
  return roots;
}

async function shippedEntry(name, anchor, roots) {
  const entry = await realpath(createRequire(anchor).resolve(name));
  for (const root of roots) {
    const packageDir = await realpath(join(root, name)).catch(() => undefined);
    if (!packageDir) continue;
    const path = relative(packageDir, entry);
    if (path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)) {
      return { entry, packageDir };
    }
  }
  throw new Error('Module is outside the DSH installation');
}

async function readStore(filename) {
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const file = await open(filename, flags);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > STORE_LIMIT ||
      (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid()))
    ) {
      throw new Error('Unsafe credential file');
    }
    const bytes = Buffer.alloc(STORE_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
      length += bytesRead;
    }
    throw new Error('Credential file exceeds size limit');
  } finally {
    await file.close();
  }
}

async function keyFromDshStore() {
  const root = process.env.DSH_INSTALL_DIR;
  if (!root || !isAbsolute(root)) return undefined;
  const installDir = await realpath(root);
  const manifest = join(installDir, 'package.json');
  if (JSON.parse(await readFile(manifest, 'utf8')).name !== '@deepseek-ai/dsh') return undefined;

  const roots = moduleRoots(installDir);
  const parser = await shippedEntry('@deepseek-ai/dsh-credentials-local', manifest, roots);
  const { parseCredentialsDocument } = await import(pathToFileURL(parser.entry));
  if (typeof parseCredentialsDocument !== 'function') return undefined;
  const yaml = await shippedEntry('yaml', parser.entry, [...moduleRoots(parser.packageDir), ...roots]);
  const { parseDocument, isMap, isScalar } = await import(pathToFileURL(yaml.entry));

  const filename = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml');
  const text = await readStore(filename);
  const { refs } = parseCredentialsDocument(text, filename);
  if (!(refs instanceof Map)) return undefined;
  const doc = parseDocument(text);
  const mapping = doc.get('refs', true);
  if (doc.errors.length || doc.warnings.length || doc.get('version') !== 1 || !isMap(mapping)) return undefined;
  let key;
  for (const name of KEY_NAMES) {
    const node = mapping.get(name, true);
    if (!refs.has(name) && node === undefined) continue;
    if (!isScalar(node) || typeof node.value !== 'string' || !node.value || node.value !== refs.get(name)) return undefined;
    key ??= node.value;
  }
  return key;
}

async function resolveKey() {
  for (const name of KEY_NAMES) {
    if (process.env[name]) return process.env[name];
  }
  const stored = await keyFromDshStore().catch(() => undefined);
  if (stored) return stored;
  fail(2, 'no usable OpenCode key: set OPENCODE_API_KEY or OPENCODE_GO_API_KEY explicitly, or check the DSH credential store');
}

const opts = parseArgs(process.argv.slice(2));
if (opts.state === '@-' && opts.questions === '@-') {
  fail(2, 'only one of --state and --questions may use @- (stdin)');
}
const state = await source(opts.state);
const questionsText = await source(opts.questions);
let questions;
try {
  questions = JSON.parse(questionsText);
} catch {
  fail(2, '--questions must be valid JSON');
}
if (!questions || typeof questions !== 'object' || Array.isArray(questions))
  fail(2, '--questions must be a JSON object keyed by question id');

const endpoint = process.env.JEV_ENDPOINT || 'https://opencode.ai/inference/go/systemone/v1/systemone';
const authorization = `Bearer ${await resolveKey()}`;
if (/[^\x20-\x7E]/.test(authorization)) fail(2, 'OpenCode key is not a usable authorization header');
const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    authorization,
    'content-type': 'application/json',
    'user-agent': 'jev-decide/0.1 (+deepseek-harness)',
  },
  body: JSON.stringify({ model: opts.model, state, questions }),
});

if (!response.ok) {
  let hint = '';
  if (response.status === 402) hint = ' — Console credits are empty; use the Go endpoint ($JEV_ENDPOINT) or jev-1.13-free';
  if (response.status === 403) hint = ' — Request forbidden; if Cloudflare blocked it, keep a product user agent';
  fail(3, `HTTP ${response.status}${hint}`);
}

console.log(await response.text());
