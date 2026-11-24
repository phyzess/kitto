#!/usr/bin/env node
// Ask a System One decision model (JEV) a set of typed questions about a state.
// Read-only: one HTTPS POST, prints the structured answer. No dependencies.
//
//   node jev.mjs --state ./state.md --questions ./q.json
//   node jev.mjs --state "summary text" --questions '{"env":{"type":"noul","instructions":"..."}}'
//   node jev.mjs --state @- --questions @-        # from stdin (state first)
//
// Key: $OPENCODE_API_KEY or $OPENCODE_GO_API_KEY, else the refs block of
// $DSH_HOME/.credentials.yaml (DSH only). The default endpoint is the Go one,
// which bills System One against the OpenCode Go subscription; override with
// $JEV_ENDPOINT (the Console path is https://opencode.ai/inference/systemone/v1/systemone
// and bills pay-as-you-go credits).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE = `Usage: jev.mjs --state <text|@file> --questions <json|@file> [--model <id>]

  --state      the text the model judges (inline, @file, or @- for stdin)
  --questions  JSON object of {id: {type, instructions, criteria?}}; types: noul | choice | score
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
    if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
    else if (arg === '--state') opts.state = value();
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

// DSH seals nothing here: refs holds `<NAME>: <value>` under the `refs:` block.
async function keyFromDshStore() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  let text;
  try { text = await readFile(join(home, '.credentials.yaml'), 'utf8'); } catch { return undefined; }
  const refs = text.split(/^refs:\s*$/m)[1];
  if (!refs) return undefined;
  for (const name of ['OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY']) {
    const match = refs.match(new RegExp(`^\\s+${name}:\\s*["']?([^"'\\s]+)["']?\\s*$`, 'm'));
    if (match) return match[1];
  }
  return undefined;
}

async function resolveKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY;
  const stored = await keyFromDshStore();
  if (stored) return stored;
  fail(2, 'no OpenCode key: set OPENCODE_API_KEY / OPENCODE_GO_API_KEY or store one in $DSH_HOME/.credentials.yaml');
}

const opts = parseArgs(process.argv.slice(2));
const state = await source(opts.state);
const questionsText = await source(opts.questions);
let questions;
try { questions = JSON.parse(questionsText); }
catch { fail(2, '--questions must be valid JSON'); }
if (!questions || typeof questions !== 'object' || Array.isArray(questions)) fail(2, '--questions must be a JSON object keyed by question id');

// The /go/ path bills the Go subscription; the bare /inference/ path bills Console credits.
const endpoint = process.env.JEV_ENDPOINT || 'https://opencode.ai/inference/go/systemone/v1/systemone';
const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${await resolveKey()}`,
    'content-type': 'application/json',
    // The gateway rejects requests without a product user agent (Cloudflare 1010).
    'user-agent': 'jev-decide/0.1 (+deepseek-harness)',
  },
  body: JSON.stringify({ model: opts.model, state, questions }),
});

const body = await response.text();
if (!response.ok) {
  let hint = '';
  if (response.status === 402) hint = ' — Console credits are empty; use the Go endpoint ($JEV_ENDPOINT) or jev-1.13-free';
  if (response.status === 403 && body.includes('1010')) hint = ' — Cloudflare rejected the request; keep a product user agent';
  fail(3, `HTTP ${response.status}${hint}\n${body.slice(0, 400)}`);
}

console.log(body);
