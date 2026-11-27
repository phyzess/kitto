import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { collectGoMetadata } from '../lib/go-metadata.ts';
import { adviseRoute } from '../lib/model-routing.ts';
import { setRoutingBoundary } from '../lib/routing-policy.ts';
import type { Json, State } from '../types/kitto.d.ts';

const now = Date.parse('2026-11-25T12:00:00Z');
const stamp = new Date(now).toISOString(),
  reset = new Date(now + 3600_000).toISOString();
const flash = {
  provider: 'opencode-go',
  upstream: 'opencode-go',
  model: 'deepseek-v4.1-flash',
  canonicalModel: 'deepseek/deepseek-v4.1-flash-1017',
  account: 'go-test',
  accountType: 'personal',
  billing: 'go-included',
  accountVerified: true,
  available: true,
  reasoningEfforts: ['low'],
};
const sol = {
  ...flash,
  provider: 'openai-codex',
  upstream: 'openai-codex',
  model: 'gpt-6.2-sol',
  canonicalModel: 'openai/gpt-6.2-sol',
  account: 'codex-test',
  billing: 'subscription',
};
const doc = {
  object: 'list',
  data: [
    {
      id: flash.model,
      canonical_id: flash.canonicalModel,
      type: 'chat',
      go: { training: false, monthly_usage: { go: 100 } },
      cost: { text: { input: { price: 0.15 }, output: { price: 0.6 } } },
      description: 'never copied from origin',
    },
  ],
};
const meter = () => ({
  usage: Object.fromEntries(['rolling', 'weekly', 'monthly'].map((name) => [name, { percent: 10, status: 'ok', resetsAt: reset }])),
});
const response = (value: unknown) => Response.json(value);
function stubFetch(handler: (url: string, init: Json) => Response): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => handler(url, init);
}
function fixture() {
  const request: Json = {
    host: { kind: 'dsh', installation: 'full-local', profile: 'web', surface: 'subagent', observedAt: stamp, routes: [flash, sol] },
    task: {
      role: 'verify',
      effects: 'read',
      data: 'public',
      effort: ['low'],
      tokens: { input: 1000, output: 1000 },
      authorized: [flash, sol].map((route) => ({ ...route, data: 'public' })),
    },
    go: { account: flash.account, plan: 'go', extraUsage: 'off' },
    goRead: { ...flash, allow: true, credentialBindingConfirmed: true, credentialKind: 'personal' },
  };
  const state: State = { schema: 1, source: 'test', routingInstallKind: 'local', ready: true, agents: ['dsh'], dshProfile: 'web' };
  setRoutingBoundary(state, 'personal');
  return { request, state, clock: () => now, optedIn: true };
}
type Args = ReturnType<typeof fixture>;

test('dedicated metadata collector checks opt-in, device, task, and same account before reading key', async () => {
  const mutations: Array<(args: Args) => void> = [
    (args) => {
      args.optedIn = false;
    },
    (args) => {
      Object.assign(args, { state: null });
    },
    (args) => {
      args.request.goRead.allow = false;
    },
    (args) => {
      args.request.goRead.credentialBindingConfirmed = false;
    },
    (args) => {
      args.request.goRead.account = 'other';
    },
    (args) => {
      args.request.task.authorized.shift();
    },
    (args) => {
      args.request.go.extraUsage = 'on';
    },
    (args) => {
      args.request.host.profile = 'desktop';
    },
    (args) => {
      args.request.go.plan = 'go-teams';
      args.request.goRead.credentialKind = 'service-account';
    },
    (args) => {
      setRoutingBoundary(args.state, 'company');
    },
  ];
  for (const mutate of mutations) {
    const args = fixture();
    mutate(args);
    let reads = 0,
      calls = 0;
    const result = await collectGoMetadata({
      ...args,
      readKey: () => {
        reads++;
      },
      fetcher: stubFetch(() => {
        calls++;
        return response(null);
      }),
    });
    assert.equal(result.status, 'stop');
    assert.equal(reads, 0);
    assert.equal(calls, 0);
  }
});

test('CLI verifies native default or explicitly selected DSH home before key and fetch', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'kitto-go-home-'));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const { state, request } = fixture();
  request.host.observedAt = new Date().toISOString();
  const statePath = join(home, 'state.json'),
    input = join(home, 'request.json');
  writeFileSync(input, JSON.stringify(request));
  const preload = `
    process.env = new Proxy(process.env, { get(target, key) {
      if (key === 'KITTO_GO_METADATA_KEY') { console.error('fixture-key-read'); return 'synthetic-key'; }
      return Reflect.get(target, key);
    } });
    globalThis.fetch = () => { console.error('fixture-fetch'); return new Response(null, { status: 403 }); };
  `;
  const cli = fileURLToPath(new URL('../bin/kitto.ts', import.meta.url));
  const defaultHome = join(home, '.dsh'),
    customHome = join(home, 'custom');
  const aliasHome = join(home, 'custom-alias');
  mkdirSync(customHome);
  symlinkSync(customHome, aliasHome);
  const homes: Array<[string | undefined, string | undefined, boolean]> = [
    [defaultHome, undefined, true],
    [defaultHome, '  ', true],
    [customHome, customHome, true],
    [customHome, undefined, false],
    [defaultHome, customHome, false],
    [undefined, undefined, false],
    ['relative-path', undefined, false],
    [defaultHome, 'relative-path', false],
    [customHome, aliasHome, true],
    [aliasHome, customHome, true],
  ];
  for (const [dshHome, explicit, expected] of homes) {
    writeFileSync(statePath, JSON.stringify({ ...state, dshHome }));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, KITTO_HOME: home, DSH_PROFILE: 'web' };
    delete env.DSH_HOME;
    if (explicit !== undefined) env.DSH_HOME = explicit;
    const run = (operation: string) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          `data:text/javascript,${encodeURIComponent(preload)}`,
          cli,
          'route',
          operation,
          '--input',
          input,
          ...(operation === 'go-metadata' ? ['--allow-network'] : []),
        ],
        { env, encoding: 'utf8', timeout: 5000 },
      );
    const result = run('go-metadata');
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).reason, expected ? 'metadata-http-error' : 'session-configuration-mismatch');
    assert.equal(result.stderr.includes('fixture-key-read'), expected);
    assert.equal(result.stderr.includes('fixture-fetch'), expected);
  }
});

test('metadata GET requests are fixed and the auth header is only on usage', async () => {
  const args = fixture(),
    calls: Array<[string, Json]> = [];
  const result = await collectGoMetadata({
    ...args,
    readKey: () => 'synthetic-key',
    fetcher: stubFetch((url, options) => {
      calls.push([url, options]);
      return response(calls.length === 1 ? doc : meter());
    }),
  });
  assert.equal(result.status, 'collected');
  assert.deepEqual(
    calls.map(([url]) => url),
    ['https://opencode.ai/inference/go/v1/models', 'https://opencode.ai/inference/go/v1/usage'],
  );
  assert.ok(
    calls.every(([, opts]) => opts.method === 'GET' && opts.redirect === 'error' && opts.credentials === 'omit' && opts.body === undefined),
  );
  assert.deepEqual(calls[0][1].headers, { Accept: 'application/json' });
  assert.equal(calls[1][1].headers.Authorization, 'Bearer synthetic-key');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-key|never copied/);
  args.request.go.metadata = result;
  assert.equal(adviseRoute({ ...args, now }).route.provider, flash.provider);
});

test('redirects, transport failures, bad or oversized content and body deadline give sanitized failures', async () => {
  const cases: Array<[() => Response, string]> = [
    [() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/' } }), 'metadata-redirect'],
    [() => new Response('secret', { status: 403 }), 'metadata-http-error'],
    [
      () => {
        throw new Error('secret');
      },
      'metadata-transport-error',
    ],
    [() => new Response('x'.repeat(600_000), { headers: { 'content-type': 'application/json' } }), 'metadata-too-large'],
    [() => new Response('{broken', { headers: { 'content-type': 'application/json' } }), 'metadata-invalid'],
    [
      () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { headers: { 'content-type': 'application/json' } }),
      'metadata-timeout',
    ],
    [() => response({ ...doc, data: [doc.data[0], doc.data[0]] }), 'metadata-catalog-unverified'],
  ];
  for (const [reply, expected] of cases) {
    let requests = 0;
    const result = await collectGoMetadata({
      ...fixture(),
      timeoutMs: 40,
      readKey: () => 'synthetic-key',
      fetcher: stubFetch(() => {
        requests++;
        return reply();
      }),
    });
    assert.equal(result.reason, expected);
    assert.equal(requests, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret|elsewhere|synthetic-key/);
  }
});

test('failed or mismatched meter evidence disables Go without overriding non-Go choices', async () => {
  const args = fixture();
  let calls = 0;
  const denied = await collectGoMetadata({
    ...args,
    readKey: () => 'synthetic-key',
    fetcher: stubFetch(() => {
      if (++calls === 1) return response(doc);
      const missing = meter();
      delete missing.usage.weekly;
      return response(missing);
    }),
  });
  assert.equal(denied.reason, 'metadata-meter-unverified');
  for (const metadata of [denied, { status: 'collected', account: 'other', plan: 'go' }, null]) {
    args.request.go.metadata = metadata;
    assert.equal(adviseRoute({ ...args, now }).route.provider, sol.provider);
  }
  calls = 0;
  const exhausted = await collectGoMetadata({
    ...args,
    readKey: () => 'synthetic-key',
    fetcher: stubFetch(() => {
      if (++calls === 1) return response(doc);
      const full = meter();
      full.usage.rolling.status = 'rate-limited';
      full.usage.rolling.percent = 100;
      return response(full);
    }),
  });
  args.request.go.metadata = exhausted;
  assert.equal(adviseRoute({ ...args, now }).go.status, 'exhausted');
  assert.equal(adviseRoute({ ...args, now }).route.provider, sol.provider);
});
