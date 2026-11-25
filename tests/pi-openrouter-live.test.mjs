import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const providerModule = '@earendil-works/pi-ai/providers/';
const fixtureKey = Symbol.for('kitto.openrouter.fixture');
const extension = new URL('../config/pi/extensions/openrouter-live.ts', import.meta.url);
const catalogBase = 'https://catalog.invalid';
const userBase = 'https://api.invalid/v1';
const known = 'fixture/model';
const newer = 'fixture/model-next';
const unknown = 'fixture/model-unknown';
const costs = { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 };
const date = 'Wed, 01 Jul 2026 00:00:00 GMT';
let sequence = 0;

const chat = (id, fields) => ({ type: 'chat', id, name: id, provider: 'openrouter', api: 'openai-completions',
  baseUrl: 'https://openrouter.ai/api/v1', input: ['text', 'image'], reasoning: true, thinkingLevelMap: { high: 'high' },
  inputLimits: { images: { maxCount: 1 } }, compat: { supportsDeveloperRole: false },
  cost: costs, contextWindow: 128_000, maxTokens: 16_000, ...fields });
const image = { id: known, type: 'image', api: 'openrouter-images', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' };
const classifier = { id: known, type: 'classifier', api: 'typesafe-system-one', provider: 'openrouter' };
const live = (id, fields) => ({ id, architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  supported_parameters: ['tools'], top_provider: { context_length: 100_000, max_completion_tokens: 10_000 },
  pricing: { prompt: '0.000002', completion: '0.000004' }, ...fields });
const json = (value, options) => Response.json(value, options);

async function fixture(t, options = {}) {
  const savedFetch = globalThis.fetch;
  const oldEnv = new Map();
  const env = { DISABLE: undefined, SYNTH: undefined, REQUIRE_TOOLS: undefined,
    CATALOG_BASE_URL: catalogBase, DEBUG: undefined, ...options };
  for (const [key, value] of Object.entries(env)) {
    const name = `OPENROUTER_LIVE_${key}`;
    oldEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const fixture = { remote: [chat(newer)], allowed: [live(known), live(newer), live(unknown)],
    calls: [], stored: undefined, publications: 0 };
  const base = { id: 'openrouter', baseUrl: userBase, auth: { apiKey: {} }, getModels: () => [chat(known)],
    api: { 'openai-completions': {}, 'anthropic-messages': {} }, stream: () => 'stream',
    generateImages: () => 'image', classify: () => 'classifier' };
  globalThis[fixtureKey] = { base, chat: [chat(known)], image: [image], classifier: [classifier] };
  const imports = {
    all: `const f = globalThis[Symbol.for('kitto.openrouter.fixture')];
      export const builtinProviders = () => [f.base];
      export const getBuiltinModels = () => f.chat;
      export const getBuiltinImageModels = () => f.image;
      export const getBuiltinClassifierModels = () => f.classifier;
      export const getBuiltinModelDataGeneratedAt = () => Date.UTC(2026, 0, 1);`,
    'openrouter-api': `export function openRouterCost(p) {
      const cost = (x, fallback = 0) => Number.parseFloat(x) >= 0 ? Number((Number.parseFloat(x)*1e6).toFixed(6)) : fallback;
      const fields = { input: 'prompt', output: 'completion', cacheRead: 'input_cache_read', cacheWrite: 'input_cache_write' };
      const convert = (row, rates) => Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, cost(row[field], rates?.[key])]));
      const base = convert(p);
      const tiers = (p.overrides ?? []).map(row => ({ inputTokensAbove: row.min_prompt_tokens, ...convert(row, base) }));
      return tiers.length ? { ...base, tiers } : base;
    }`,
  };
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (!specifier.startsWith(providerModule)) return next(specifier, context);
    const source = imports[specifier.slice(providerModule.length)];
    assert.ok(source, `unexpected Pi module ${specifier}`);
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`// fixture ${sequence}\n${source}`)}` };
  } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    fixture.calls.push([url.href, init?.headers?.authorization]);
    init?.signal?.throwIfAborted();
    if (url.href === `${catalogBase}/api/models/providers/openrouter?types=chat%2Cimage%2Cclassifier`) {
      return fixture.catalogResponse?.() ?? json(fixture.remote, { headers: { 'last-modified': date } });
    }
    assert.ok([`${userBase}/models/user`, 'https://regional.invalid/v1/models/user'].includes(url.href), `unexpected fetch ${url.href}`);
    return fixture.userResponse?.() ?? json({ data: fixture.allowed });
  };
  t.after(() => {
    hooks.deregister();
    globalThis.fetch = savedFetch;
    delete globalThis[fixtureKey];
    for (const [key, value] of oldEnv) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  fixture.commands = new Map();
  const { default: initialize } = await import(`${extension.href}?fixture=${++sequence}`);
  await initialize({ registerProvider: value => { fixture.provider = value; }, registerCommand: (name, value) => fixture.commands.set(name, value) });
  let generation = 0;
  fixture.refresh = async (overrides = {}) => {
    const issued = ++generation;
    const context = { stored: fixture.stored, allowNetwork: true, credential: { type: 'api_key', key: 'fake-key' },
      signal: new AbortController().signal, ...overrides };
    await fixture.provider.refreshModels({ ...context, publish: async ({ persist, update }) => {
      if (issued !== generation || context.signal.aborted) return false;
      fixture.publications++;
      if (persist !== undefined) fixture.stored = persist;
      update?.();
      return true;
    } });
  };
  fixture.supersede = () => { generation++; };
  fixture.chat = () => fixture.provider.getModels();
  return fixture;
}

const ids = (f) => f.chat().map(model => model.id);

test('only exact compatible IDs register with verified live metadata', async t => {
  const f = await fixture(t);
  f.remote.push(chat('fixture/incomplete', { api: undefined }), chat('fixture/wrong-provider', { provider: 'foreign' }),
    chat('fixture/media'), chat('fixture/batch:batch'), chat('fixture/free:free'));
  f.allowed.push(live('fixture/incomplete'), live('fixture/wrong-provider'), live('fixture/media', {
    architecture: { input_modalities: ['audio'], output_modalities: ['audio'] },
  }), live('fixture/batch:batch'), live('fixture/free:free'));
  await f.refresh({ allowNetwork: false });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(ids(f), [known]);
  await f.refresh();
  assert.deepEqual(ids(f), [known, newer]);
  const model = f.chat()[1];
  assert.deepEqual(model.input, ['text']);
  assert.equal(model.inputLimits, undefined);
  assert.equal(model.reasoning, false);
  assert.equal(model.thinkingLevelMap, undefined);
  assert.equal(model.contextWindow, 100_000);
  assert.equal(model.maxTokens, 10_000);
  assert.deepEqual(model.cost, { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(model.compat, { supportsDeveloperRole: false });
  assert.equal(f.calls.filter(([url]) => url.endsWith('/models/user')).length, 1);
  assert.deepEqual(f.provider.getAllModels().map(model => [model.type, model.id]), [['chat', known], ['chat', newer], ['image', known], ['classifier', known]]);
  for (const [method, result] of [['stream', 'stream'], ['generateImages', 'image'], ['classify', 'classifier']]) assert.equal(f.provider[method](), result);
  const reports = [];
  const ui = { notify: message => reports.push(message) };
  await f.commands.get('openrouter-explain').handler(unknown, { ui });
  assert.match(reports.pop(), /no exact|not in the current/);
  await f.commands.get('openrouter-sync').handler('', { ui, modelRegistry: { refresh(options) {
    assert.deepEqual(options, { providers: ['openrouter'], force: true });
    return { errors: new Map() };
  } } });
  assert.match(reports.pop(), /skipped/);
});

test('authoritative empty and legacy snapshots restore without fetching', async t => {
  const f = await fixture(t);
  f.allowed = [];
  await f.refresh();
  assert.deepEqual(ids(f), []);
  assert.equal(f.provider.getAllModels().length, 2);
  f.stored = { models: [] };
  const count = f.calls.length;
  await f.refresh({ allowNetwork: false, credential: undefined });
  assert.deepEqual(f.provider.getAllModels(), []);
  await f.refresh({ allowNetwork: false, stored: { models: [chat(known), chat(unknown)], synthesized: [{ id: unknown, donor: known }] } });
  assert.deepEqual(ids(f), [known]);
  assert.equal(f.calls.length, count);
});

test('catalog freshness, user fallback, failure and cancelled generations preserve snapshots', async t => {
  const f = await fixture(t);
  assert.deepEqual(ids(f), [known]);
  await f.refresh({ credential: undefined });
  assert.equal(f.calls.length, 0);
  await f.refresh({ credential: { type: 'oauth', access: 'fake-access' }, baseUrl: 'https://regional.invalid/v1/' });
  assert.equal(f.calls[0][1], undefined);
  assert.deepEqual(f.calls[1], ['https://regional.invalid/v1/models/user', 'Bearer fake-access']);
  assert.deepEqual(ids(f), [known, newer]);
  const last = f.stored;
  for (const status of [500, 502]) {
    f.userResponse = () => new Response('', { status });
    await assert.rejects(f.refresh());
    assert.equal(f.stored, last);
  }
  f.userResponse = () => json({ nonsense: [] });
  await assert.rejects(f.refresh(), /Invalid OpenRouter model list/);
  assert.equal(f.stored, last);
  f.userResponse = () => new Response('{');
  await assert.rejects(f.refresh());
  assert.equal(f.stored, last);
  f.catalogResponse = () => new Response('', { status: 500 });
  await f.refresh();
  assert.equal(f.stored, last);
  f.catalogResponse = () => json({ models: true }, { headers: { 'last-modified': date } });
  await f.refresh();
  assert.equal(f.stored, last);
  f.catalogResponse = () => json(f.remote, { headers: { 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' } });
  f.userResponse = () => new Response('', { status: 401 });
  await f.refresh();
  assert.deepEqual(ids(f), [known]);
  for (const code of [404, 501]) {
    f.catalogResponse = () => new Response('', { status: code });
    for (const userCode of [401, 403, 404]) {
      f.userResponse = () => new Response('', { status: userCode });
      await f.refresh();
      assert.deepEqual(ids(f), [known]);
    }
  }
  const kept = f.stored;
  f.catalogResponse = undefined;
  const abort = new AbortController();
  f.userResponse = () => { abort.abort(); return json({ data: [] }); };
  await f.refresh({ signal: abort.signal });
  assert.equal(f.stored, kept);
  f.userResponse = () => { f.supersede(); return json({ data: [] }); };
  await f.refresh();
  assert.equal(f.stored, kept);
});

test('tools restriction affects only additions and SYNTH off keeps exact catalog refresh', async t => {
  const f = await fixture(t, { REQUIRE_TOOLS: '0', SYNTH: 'off' });
  f.allowed = [live(known), live(newer, { supported_parameters: [] }), live(unknown)];
  await f.refresh();
  assert.deepEqual(ids(f), [known, newer]);
});

test('later exact entries win without replacing another model type; invalid prices and limits fall back', async t => {
  const f = await fixture(t);
  f.remote = [chat(known, { name: 'old' }), chat(known, { name: 'current' }), chat(known, { api: 'unsupported' }),
    chat(newer, { baseUrl: 'https://wrong.invalid/api/v1' }), chat('fixture/no-tools')];
  f.allowed = [live(known), live(known, { pricing: { prompt: 'bad', completion: '0.5' },
    top_provider: { context_length: -1, max_completion_tokens: 'large' }, context_length: 50_000,
    architecture: { input_modalities: ['text', 'image', 'audio'], output_modalities: ['text'] },
    supported_parameters: ['reasoning', 'tools'] }), live(newer), live('fixture/no-tools', { supported_parameters: [] })];
  await f.refresh();
  assert.deepEqual(ids(f), [known]);
  const [model] = f.chat();
  assert.equal(model.name, 'current');
  assert.deepEqual(model.input, ['text', 'image']);
  assert.equal(model.contextWindow, 50_000);
  assert.equal(model.maxTokens, 16_000);
  assert.deepEqual(model.cost, costs);
  assert.deepEqual(model.inputLimits, { images: { maxCount: 1 } });
  assert.deepEqual(model.thinkingLevelMap, { high: 'high' });
  assert.equal(f.provider.getAllModels().length, 3);
});

test('an all-invalid recent catalog does not replace a published snapshot', async t => {
  const f = await fixture(t);
  const invalid = chat(newer, { api: 'unsupported' });
  f.remote.push(invalid);
  await f.refresh();
  assert.deepEqual(ids(f), [known, newer]);
  const previous = f.stored;
  const publications = f.publications;
  f.remote = [invalid];
  await assert.rejects(f.refresh(), /Invalid Pi model catalog entries/);
  assert.equal(f.stored, previous);
  assert.equal(f.publications, publications);
  assert.deepEqual(ids(f), [known, newer]);
  f.remote = [];
  await f.refresh();
  assert.deepEqual(ids(f), [known]);
});

test('offline restore validates non-bundled entries without dropping valid typed entries', async t => {
  const f = await fixture(t);
  const extraImage = { ...image, id: newer, baseUrl: 'https://openrouter.ai/api/v1' };
  const models = [{ ...image, name: 'bundled image' }, chat(known), chat(newer), extraImage,
    chat('fixture/missing-api', { api: undefined }), chat('fixture/foreign-endpoint', { baseUrl: 'https://wrong.invalid/api/v1' }),
    chat('fixture/bad-compat', { compat: [] })];
  await f.refresh({ allowNetwork: false, credential: undefined, stored: { models } });
  assert.deepEqual(ids(f), [known, newer]);
  assert.deepEqual(f.provider.getAllModels().filter(model => model.type === 'image'), [models[0], extraImage]);
  assert.equal(f.publications, 1);
  assert.equal(f.stored, undefined);
  assert.deepEqual(f.calls, []);
});

test('only omitted, well-formed live capability declarations can back exact additions', async t => {
  const f = await fixture(t);
  const additions = [
    ['omitted', { architecture: undefined, supported_parameters: undefined }],
    ['bad-params', { supported_parameters: 'tools' }],
    ['mixed-params', { supported_parameters: ['tools', false] }],
    ['bad-architecture', { architecture: null }],
    ['bad-inputs', { architecture: { input_modalities: ['text', null] } }],
    ['bad-outputs', { architecture: { output_modalities: 'text' } }],
  ];
  f.remote = additions.map(([suffix]) => chat(`fixture/${suffix}`));
  f.allowed = [live(known), ...additions.map(([suffix, fields]) => live(`fixture/${suffix}`, fields))];
  await f.refresh();
  assert.deepEqual(ids(f), [known, 'fixture/omitted']);
});

test('disable leaves the native provider untouched', async t => {
  const f = await fixture(t, { DISABLE: '1' });
  assert.equal(f.provider, undefined);
  assert.equal(f.commands.size, 0);
  assert.deepEqual(f.calls, []);
});
