#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const MODELS = {
  'openai-codex/gpt-6.2-sol': { at: 272_000, base: [2, 0.1, 10], long: [4, 0.2, 15] },
  'openai-codex/gpt-6.2-astra': { at: 272_000, base: [2.4, 0.12, 12], long: [4.8, 0.24, 24] },
  'deepseek-official/deepseek-flash': { at: Infinity, base: [0.225, 0.0045, 0.9], long: [0.225, 0.0045, 0.9] },
  'xai/grok-4.7': { at: 200_000, base: [2, 0.5, 6], long: [4, 1, 12] },
};

const USAGE = `Usage: dsh-usage.mjs [--home DIR] [--project PREFIX] [--days N] [--limit N] [--json] [--price MODEL=a,b,c[,d,e,f][@THRESHOLD]]

  --home DIR      DSH home holding sessions/ (default $DSH_HOME or ~/.dsh)
  --project PATH  keep sessions whose working directory starts with PATH
  --days N        keep requests from the last N days (default: all history)
  --limit N       rows in the top-sessions table (default 10)
  --json          print the aggregate as JSON instead of tables
  --price ...     override or add a price in USD per 1M tokens:
                  fresh input, cached input, output [+ long-context trio] [@threshold].
                  Example: --price openai-codex/gpt-6.2-sol=2,0.1,10@272000`;

function fail(message) {
  console.error(`dsh-usage: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { limit: 10, prices: { ...MODELS } };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
    else if (arg === '--home') opts.home = next();
    else if (arg === '--project') opts.project = next();
    else if (arg === '--days') opts.days = Number(next());
    else if (arg === '--limit') opts.limit = Number(next());
    else if (arg === '--json') opts.json = true;
    else if (arg === '--price') opts.prices = { ...opts.prices, ...parsePrice(next()) };
    else fail(`unknown argument ${arg}\n\n${USAGE}`);
  }
  return opts;
}

function parsePrice(spec) {
  const at = spec.lastIndexOf('@');
  const threshold = at === -1 ? Infinity : Number(spec.slice(at + 1));
  const body = at === -1 ? spec : spec.slice(0, at);
  const eq = body.indexOf('=');
  if (eq === -1) fail(`--price expects MODEL=a,b,c[,d,e,f], got ${spec}`);
  const numbers = body.slice(eq + 1).split(',').map(Number);
  if (numbers.some(n => !Number.isFinite(n))) fail(`--price expects numbers, got ${spec}`);
  const base = numbers.slice(0, 3);
  const long = numbers.length >= 6 ? numbers.slice(3, 6) : base;
  if (base.length !== 3) fail(`--price needs at least 3 numbers, got ${spec}`);
  return { [body.slice(0, eq)]: { at: threshold, base, long } };
}

async function listSessionFiles(sessionsRoot) {
  const files = [];
  let projects;
  try { projects = await readdir(sessionsRoot, { withFileTypes: true }); }
  catch { return files; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(sessionsRoot, project.name);
    let sessions;
    try { sessions = await readdir(projectDir, { withFileTypes: true }); } catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const file = join(projectDir, session.name, 'session.v4.jsonl.zstd');
      files.push({ project: project.name, id: session.name, file });
    }
  }
  return files;
}

function readSession(file) {
  return new Promise((resolve) => {
    const session = { usage: [], meta: null, title: null, label: null };
    const child = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let spawnFailed = false;
    child.on('error', () => { spawnFailed = true; resolve(null); });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (line.length < 40 || line[0] !== '{') return;
      try {
        if (line.includes('"assistant/message"')) {
          const record = JSON.parse(line);
          const usage = record?.data?.usage;
          if (!usage) return;
          const source = record?.data?.message?.source || {};
          session.usage.push({
            time: record.time,
            provider: source.provider ?? 'unknown',
            model: source.model ?? 'unknown',
            input: usage.inputTokens || 0,
            cacheRead: usage.cacheReadTokens || 0,
            output: usage.outputTokens || 0,
          });
        } else if (line.startsWith('{"type":"session"')) {
          const record = JSON.parse(line);
          session.meta = {
            cwd: record.cwd, parent: record.parentSession,
            depth: record.delegationDepth ?? 0, created: record.createdAt,
          };
        } else if (line.includes('"session/title"')) {
          session.title = JSON.parse(line).data?.title;
        } else if (line.includes('"subagent/descriptor"')) {
          session.label = JSON.parse(line).data?.label;
        }
      } catch {  }
    });
    lines.on('close', () => resolve(spawnFailed ? null : session));
  });
}

const human = (n) => {
  if (!Number.isFinite(n)) return '-';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};
const usd = (n) => (Number.isFinite(n) ? `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}` : '-');
const percent = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '-');
const quantile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const pad = (text, width) => String(text).padEnd(width);
const lpad = (text, width) => String(text).padStart(width);

function costOf(prices, model, input, cacheRead, output) {
  const price = prices[model];
  if (!price) return null;
  const long = input + cacheRead >= price.at;
  const [i, c, o] = long ? price.long : price.base;
  return (input * i + cacheRead * c + output * o) / 1e6;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = opts.home || process.env.DSH_HOME || join(homedir(), '.dsh');
  const sessionsRoot = join(home, 'sessions');

  const files = await listSessionFiles(sessionsRoot);
  if (!files.length) {
    console.log(`dsh-usage: no DSH sessions under ${sessionsRoot}`);
    return;
  }

  const threshold = opts.days ? Date.now() - opts.days * 86_400_000 : 0;
  const scanned = await mapLimit(files, 4, item => readSession(item.file));
  if (scanned.every(session => session === null)) {
    fail('could not decompress sessions; install zstd (checked PATH for the `zstd` binary)');
  }

  const sessions = [];
  const models = new Map();
  const projects = new Map();
  const days = new Map();
  let totalInput = 0, totalCache = 0, totalOutput = 0, totalRequests = 0, totalCost = 0;
  const promptSizes = [];
  const allPromptSizes = [];
  let overThreshold = 0, tokensInOverThreshold = 0, tokensInAll = 0;

  scanned.forEach((session, index) => {
    if (!session || !session.usage.length) return;
    const cwd = session.meta?.cwd ?? '';
    if (opts.project && !cwd.startsWith(opts.project)) return;
    const usage = session.usage.filter(u => u.time >= threshold);
    if (!usage.length) return;

    const row = {
      id: files[index].id, cwd, model: new Set(), requests: 0,
      input: 0, cacheRead: 0, output: 0, cost: 0, promptSizes: [],
      parent: session.meta?.parent, depth: session.meta?.depth ?? 0,
      created: session.meta?.created ?? usage[0].time,
      title: session.title || session.label || '',
    };

    for (const item of usage) {
      row.requests += 1;
      row.input += item.input;
      row.cacheRead += item.cacheRead;
      row.output += item.output;
      const prompt = item.input + item.cacheRead;
      row.promptSizes.push(prompt);
      promptSizes.push(prompt);
      allPromptSizes.push(prompt);
      tokensInAll += prompt;
      if (prompt > 200_000) { overThreshold += 1; tokensInOverThreshold += prompt; }

      const key = `${item.provider}/${item.model}`;
      row.model.add(key);
      const cost = costOf(opts.prices, key, item.input, item.cacheRead, item.output);
      const modelRow = models.get(key) || { requests: 0, input: 0, cacheRead: 0, output: 0, cost: 0, sessions: new Set() };
      modelRow.requests += 1;
      modelRow.input += item.input;
      modelRow.cacheRead += item.cacheRead;
      modelRow.output += item.output;
      if (cost !== null) { modelRow.cost += cost; row.cost += cost; totalCost += cost; }
      modelRow.sessions.add(row.id);
      models.set(key, modelRow);

      const d = day(item.time);
      const dayRow = days.get(d) || { requests: 0, cacheRead: 0, output: 0, cost: 0, sessions: new Set() };
      dayRow.requests += 1;
      dayRow.cacheRead += item.cacheRead;
      dayRow.output += item.output;
      if (cost !== null) dayRow.cost += cost;
      dayRow.sessions.add(row.id);
      days.set(d, dayRow);
    }

    totalInput += row.input;
    totalCache += row.cacheRead;
    totalOutput += row.output;
    totalRequests += row.requests;
    sessions.push(row);
  });

  if (!sessions.length) {
    console.log(`dsh-usage: no usage records under ${sessionsRoot} match this filter`);
    return;
  }

  for (const row of sessions) {
    const key = row.cwd || '(unknown)';
    const projectRow = projects.get(key) || { sessions: 0, requests: 0, cacheRead: 0, input: 0, output: 0, cost: 0 };
    projectRow.sessions += 1;
    projectRow.requests += row.requests;
    projectRow.cacheRead += row.cacheRead;
    projectRow.input += row.input;
    projectRow.output += row.output;
    projectRow.cost += row.cost;
    projects.set(key, projectRow);
  }

  const rootSessions = sessions.filter(row => !row.parent);
  const childSessions = sessions.filter(row => row.parent);
  const childTokens = childSessions.reduce((a, r) => a + r.input + r.cacheRead, 0);
  const totalTokens = totalInput + totalCache;
  const summary = {
    home,
    window: { days: opts.days ?? null, from: sessions.flatMap(row => row.created).reduce((a, b) => Math.min(a, b), Infinity) },
    sessions: sessions.length,
    requests: totalRequests,
    inputTokens: totalInput,
    cacheReadTokens: totalCache,
    outputTokens: totalOutput,
    cacheHitRate: totalCache / (totalCache + totalInput),
    outputToInput: totalOutput ? (totalCache + totalInput) / totalOutput : null,
    estimatedUsd: totalCost,
    fanOut: { root: rootSessions.length, child: childSessions.length, ratio: childSessions.length / (rootSessions.length || 1), childTokenShare: childTokens / (totalTokens || 1) },
    prompts: {
      p50: quantile(allPromptSizes.sort((a, b) => a - b), 0.5),
      p90: quantile(allPromptSizes, 0.9),
      p99: quantile(allPromptSizes, 0.99),
      max: allPromptSizes.at(-1) ?? 0,
      over200k: overThreshold,
      over200kShare: overThreshold / totalRequests,
      tokensInOver200k: tokensInOverThreshold / (tokensInAll || 1),
    },
    models: [...models].map(([model, row]) => ({ model, ...row, sessions: row.sessions.size })).sort((a, b) => b.cacheRead - a.cacheRead),
    projects: [...projects].map(([cwd, row]) => ({ cwd, ...row })).sort((a, b) => b.cacheRead - a.cacheRead),
    days: [...days].map(([date, row]) => ({ date, ...row, sessions: row.sessions.size })).sort((a, b) => a.date.localeCompare(b.date)),
    topSessions: sessions
      .map(row => ({
        id: row.id, title: row.title, depth: row.depth, requests: row.requests,
        inputTokens: row.input, cacheReadTokens: row.cacheRead, outputTokens: row.output,
        avgPrompt: (row.input + row.cacheRead) / row.requests,
        usd: row.cost,
      }))
      .sort((a, b) => b.inputTokens + b.cacheReadTokens - (a.inputTokens + a.cacheReadTokens))
      .slice(0, opts.limit),
  };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const from = opts.days ? day(threshold) : day(summary.window.from);
  console.log(`DSH usage · ${home}`);
  console.log(` ${from} → ${day(Date.now())} · ${summary.sessions} sessions · ${summary.requests.toLocaleString('en-US')} requests`);
  console.log(` fresh input ${human(totalInput)} · cache read ${human(totalCache)} · output ${human(totalOutput)}`);
  console.log(` cache hit ${percent(totalCache, totalCache + totalInput)} · output:input 1:${totalOutput ? Math.round((totalCache + totalInput) / totalOutput) : '-'} · ${usd(totalCost)} at list price`);

  console.log('\nMODEL'.padEnd(36) + lpad('REQ', 8) + lpad('FRESH IN', 11) + lpad('CACHE READ', 12) + lpad('OUTPUT', 10) + lpad('USD', 9));
  for (const row of summary.models) {
    console.log(pad(row.model, 36) + lpad(row.requests.toLocaleString('en-US'), 8) + lpad(human(row.input), 11) + lpad(human(row.cacheRead), 12) + lpad(human(row.output), 10) + lpad(usd(row.cost), 9));
  }

  console.log('\nPROJECT'.padEnd(48) + lpad('SESS', 6) + lpad('REQ', 8) + lpad('CACHE READ', 12) + lpad('USD', 8));
  for (const row of summary.projects) {
    console.log(pad(row.cwd || '(unknown)', 48) + lpad(row.sessions, 6) + lpad(row.requests.toLocaleString('en-US'), 8) + lpad(human(row.cacheRead), 12) + lpad(usd(row.cost), 8));
  }

  console.log('\nDAY'.padEnd(14) + lpad('SESS', 6) + lpad('REQ', 8) + lpad('CACHE READ', 12) + lpad('USD', 8));
  for (const row of summary.days) {
    console.log(pad(row.date, 14) + lpad(row.sessions, 6) + lpad(row.requests.toLocaleString('en-US'), 8) + lpad(human(row.cacheRead), 12) + lpad(usd(row.cost), 8));
  }

  console.log(`\nprompt/request  p50 ${human(summary.prompts.p50)} · p90 ${human(summary.prompts.p90)} · p99 ${human(summary.prompts.p99)} · max ${human(summary.prompts.max)}`);
  console.log(`>200K prompts   ${summary.prompts.over200k.toLocaleString('en-US')} / ${summary.requests.toLocaleString('en-US')} (${percent(summary.prompts.over200k, summary.requests)}) carrying ${percent(tokensInOverThreshold, tokensInAll)} of input tokens`);
  console.log(`fan-out         ${summary.fanOut.root} root · ${summary.fanOut.child} subagent (${summary.fanOut.ratio.toFixed(1)}x) · subagents hold ${percent(childTokens, totalTokens)} of input`);

  console.log('\nTOP SESSIONS BY INPUT');
  for (const row of summary.topSessions) {
    const tokens = human(row.inputTokens + row.cacheReadTokens);
    const label = (row.title || row.id).slice(0, 52);
    console.log(` ${lpad(tokens, 8)}  req ${lpad(row.requests, 5)}  prompt~${lpad(human(row.avgPrompt), 7)}  depth ${row.depth}  ${label}`);
  }
}

await main();
