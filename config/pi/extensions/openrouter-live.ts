// @ts-nocheck

const PROVIDER_ID = 'openrouter';
const DEFAULT_CATALOG_BASE = 'https://pi.dev';
const CATALOG_TIMEOUT_MS = 15000;
const USER_MODELS_TIMEOUT_MS = 15000;
const SYNTH_MODES = new Set(['donor', 'off']);

const DISABLED = process.env.OPENROUTER_LIVE_DISABLE === '1';
const SYNTH_MODE = (process.env.OPENROUTER_LIVE_SYNTH ?? 'donor').toLowerCase();
const REQUIRE_TOOLS = process.env.OPENROUTER_LIVE_REQUIRE_TOOLS !== '0';
const CATALOG_BASE = (process.env.OPENROUTER_LIVE_CATALOG_BASE_URL ?? DEFAULT_CATALOG_BASE).replace(/\/+$/, '');
const REASONING_PARAMS = ['reasoning', 'reasoning_effort', 'include_reasoning'];
const DEBUG = process.env.OPENROUTER_LIVE_DEBUG === '1';
const debug = (...args) => {
  if (DEBUG) console.warn('[openrouter-live]', ...args);
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isChat = (model) => (model?.type ?? 'chat') === 'chat';
const typeKey = (model) => `${model?.type ?? 'chat'}\u0000${model?.id}`;
const positiveInt = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isFinite(value) && value >= 0;
const optionalObject = (value) => value === undefined || isObject(value);
const optionalStrings = (value) => value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
const CHAT_APIS = new Set(['openai-completions', 'anthropic-messages']);
const PRICE_FIELDS = ['prompt', 'completion', 'input_cache_read', 'input_cache_write'];

function hasModelIdentity(model) {
  return (
    isObject(model) && model.provider === PROVIDER_ID && typeof model.id === 'string' && model.id.length > 0 && !/[\s\u0000]/.test(model.id)
  );
}

function usableCatalogModel(model) {
  if (!hasModelIdentity(model) || typeof model.baseUrl !== 'string' || !URL.canParse(model.baseUrl)) return false;
  const url = new URL(model.baseUrl);
  if (
    url.origin !== 'https://openrouter.ai' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['/api', '/api/v1'].includes(url.pathname)
  )
    return false;
  if (model.type === 'image') return model.api === 'openrouter-images';
  if (model.type === 'classifier') return model.api === 'typesafe-system-one';
  if (!isChat(model)) return false;
  if (
    !CHAT_APIS.has(model.api) ||
    typeof model.name !== 'string' ||
    typeof model.reasoning !== 'boolean' ||
    !Array.isArray(model.input) ||
    !model.input.includes('text') ||
    !model.input.every((item) => item === 'text' || item === 'image') ||
    !positiveInt(model.contextWindow) ||
    !positiveInt(model.maxTokens) ||
    !isObject(model.cost) ||
    !['input', 'output', 'cacheRead', 'cacheWrite'].every((field) => nonnegative(model.cost[field])) ||
    ![model.compat, model.thinkingLevelMap, model.inputLimits, model.promptCache].every(optionalObject)
  )
    return false;
  return true;
}

function mergeCatalog(builtin, remote) {
  const merged = new Map(builtin.filter(hasModelIdentity).map((model) => [typeKey(model), model]));
  const valid = remote.filter(usableCatalogModel);
  if (remote.length > 0 && valid.length === 0) throw new Error('Invalid Pi model catalog entries');
  for (const model of valid) merged.set(typeKey(model), model);
  return [...merged.values()];
}

function price(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) return undefined;
  return nonnegative(Number(value) * 1_000_000) ? String(value) : undefined;
}

function validatedPricing(raw) {
  if (!isObject(raw) || price(raw.prompt) === undefined || price(raw.completion) === undefined) return undefined;
  const rates = (entry) => Object.fromEntries(PRICE_FIELDS.map((key) => [key, price(entry[key])]));
  const overrides = Array.isArray(raw.overrides)
    ? raw.overrides
        .filter(
          (tier) =>
            isObject(tier) &&
            Number.isSafeInteger(tier.min_prompt_tokens) &&
            tier.min_prompt_tokens >= 0 &&
            tier.utc_start === undefined &&
            tier.utc_end === undefined &&
            tier.utc_days === undefined,
        )
        .map((tier) => ({ min_prompt_tokens: tier.min_prompt_tokens, ...rates(tier) }))
    : [];
  return { ...rates(raw), overrides };
}

function applyLive(model, entry, requireTools, openRouterCost) {
  const inputs = entry.architecture?.input_modalities;
  const outputs = entry.architecture?.output_modalities;
  const params = entry.supported_parameters;
  if (!optionalObject(entry.architecture) || !optionalStrings(inputs) || !optionalStrings(outputs) || !optionalStrings(params)) return null;
  if ((inputs !== undefined && !inputs.includes('text')) || (outputs !== undefined && !outputs.includes('text'))) return null;
  if (requireTools && params !== undefined && !params.includes('tools') && !params.includes('tool_choice')) return null;
  const input = inputs === undefined ? model.input : model.input.filter((item) => inputs.includes(item));
  const reasoning = model.reasoning && (params === undefined || params.some((name) => REASONING_PARAMS.includes(name)));
  const contextWindow = [entry.top_provider?.context_length, entry.context_length, model.contextWindow].find(positiveInt);
  const maxTokens = Math.min(contextWindow, [entry.top_provider?.max_completion_tokens, model.maxTokens].find(positiveInt));
  const pricing = validatedPricing(entry.pricing);
  return {
    ...model,
    input,
    reasoning,
    contextWindow,
    maxTokens,
    inputLimits: input.includes('image') ? model.inputLimits : undefined,
    thinkingLevelMap: reasoning ? model.thinkingLevelMap : undefined,
    cost: pricing ? openRouterCost(pricing) : model.cost,
  };
}

function compose(catalog, builtinKeys, allowed, openRouterCost) {
  const models = [],
    provenance = new Map(),
    matchedIds = new Set(),
    skipped = new Map();
  for (const model of catalog) {
    const key = typeKey(model);
    const bundled = builtinKeys.has(key);
    if (!isChat(model)) {
      models.push(model);
      provenance.set(key, bundled ? 'bundled' : 'pi.dev (exact ID)');
      continue;
    }
    matchedIds.add(model.id);
    if (!bundled && model.id.includes(':')) {
      if (allowed?.has(model.id)) skipped.set(model.id, 'routing variant');
      continue;
    }
    const entry = allowed?.get(model.id);
    if (allowed && !entry) continue;
    const live = entry ? applyLive(model, entry, !bundled && REQUIRE_TOOLS, openRouterCost) : model;
    if (!live) {
      skipped.set(model.id, 'unsupported chat modalities or tools');
      continue;
    }
    models.push(live);
    provenance.set(key, `${bundled ? 'bundled' : 'pi.dev (exact ID)'}${entry ? ' + live metadata' : ''}`);
  }
  for (const id of allowed?.keys() ?? []) {
    if (matchedIds.has(id)) continue;
    skipped.set(id, id.includes(':') ? 'routing variant' : 'no exact compatible Pi catalog entry');
  }
  return {
    models: [...models.filter(isChat), ...models.filter((model) => !isChat(model))],
    provenance,
    skipped,
    allowed: allowed?.size ?? null,
  };
}

async function fetchJson(url, init, signal, timeoutMs) {
  const response = await fetch(url, {
    ...init,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  return response;
}

async function fetchUserModels(baseUrl, key, signal) {
  const response = await fetchJson(
    `${baseUrl.replace(/\/+$/, '')}/models/user`,
    { headers: { accept: 'application/json', authorization: `Bearer ${key}` } },
    signal,
    USER_MODELS_TIMEOUT_MS,
  );
  if (response.status === 401 || response.status === 403 || response.status === 404) return null;
  if (!response.ok) throw new Error(`OpenRouter model list request failed: ${response.status}`);
  const body = await response.json();
  if (typeof body !== 'object' || body === null || !Array.isArray(body.data)) {
    throw new Error('Invalid OpenRouter model list response');
  }
  const allowed = new Map();
  for (const entry of body.data) {
    if (isObject(entry) && typeof entry.id === 'string' && entry.id.length > 0 && !/[\s\u0000]/.test(entry.id))
      allowed.set(entry.id, entry);
  }
  if (body.data.length > 0 && allowed.size === 0) throw new Error('Invalid OpenRouter model list entries');
  return allowed;
}

async function loadCatalog(signal, builtin, builtinGeneratedAt) {
  let remote = [];
  let lastModified;
  try {
    const url = new URL(`/api/models/providers/${PROVIDER_ID}`, `${CATALOG_BASE}/`);
    url.searchParams.set('types', 'chat,image,classifier');
    const response = await fetchJson(url, { headers: { accept: 'application/json' } }, signal, CATALOG_TIMEOUT_MS);
    if (response.ok) {
      const parsed = Date.parse(response.headers.get('last-modified') ?? '');
      lastModified = Number.isNaN(parsed) ? undefined : parsed;
      const newer = builtinGeneratedAt === undefined || (lastModified !== undefined && lastModified > builtinGeneratedAt);
      if (newer) {
        const body = await response.json();
        const entries = Array.isArray(body) ? body : isObject(body) ? (body.models ?? body) : null;
        if (!Array.isArray(entries) && !isObject(entries)) throw new Error('Invalid Pi model catalog response');
        remote = Array.isArray(entries) ? entries : Object.values(entries);
      }
    } else if (response.status !== 404 && response.status !== 501) {
      throw new Error(`catalog request failed: ${response.status}`);
    }
  } catch (error) {
    if (signal?.aborted) return undefined;
    console.warn(`[openrouter-live] pi.dev catalog unavailable (${error?.message ?? error}); keeping the previous list`);
    return undefined;
  }
  return { models: mergeCatalog(builtin, remote), lastModified, usedRemote: remote.length > 0 };
}

export default async function (pi) {
  if (DISABLED) {
    console.warn('[openrouter-live] disabled via OPENROUTER_LIVE_DISABLE=1');
    return;
  }
  if (!SYNTH_MODES.has(SYNTH_MODE)) console.warn('[openrouter-live] unknown OPENROUTER_LIVE_SYNTH; using exact catalog entries only');

  let ai, openRouterCost;
  try {
    [ai, { openRouterCost }] = await Promise.all([
      import('@earendil-works/pi-ai/providers/all'),
      import('@earendil-works/pi-ai/providers/openrouter-api'),
    ]);
  } catch {
    console.warn('[openrouter-live] Pi provider APIs unavailable; keeping the built-in OpenRouter provider');
    return;
  }
  const base = (ai.builtinProviders?.() ?? []).find((provider) => provider.id === PROVIDER_ID);
  if (!base || typeof base.getModels !== 'function' || !base.auth || typeof openRouterCost !== 'function') {
    console.warn('[openrouter-live] built-in OpenRouter provider not reachable; leaving it in place');
    return;
  }
  const builtin = mergeCatalog(
    [
      ...(ai.getBuiltinModels?.(PROVIDER_ID) ?? []),
      ...(ai.getBuiltinImageModels?.(PROVIDER_ID) ?? []),
      ...(ai.getBuiltinClassifierModels?.(PROVIDER_ID) ?? []),
    ],
    [],
  );
  const builtinKeys = new Set(builtin.map(typeKey));
  const builtinByKey = new Map(builtin.map((model) => [typeKey(model), model]));
  const builtinGeneratedAt = ai.getBuiltinModelDataGeneratedAt?.();
  let state = { ...compose(builtin, builtinKeys, undefined, openRouterCost), source: 'bundled' };

  async function refreshModels(context) {
    if (context.signal?.aborted) return;
    if (!context.allowNetwork) {
      if (Array.isArray(context.stored?.models)) {
        const legacy = new Set((Array.isArray(context.stored.synthesized) ? context.stored.synthesized : []).map((entry) => entry?.id));
        const restored = context.stored.models.flatMap((model) => {
          if (!hasModelIdentity(model) || (isChat(model) && legacy.has(model.id))) return [];
          if (usableCatalogModel(model)) return [model];
          const bundled = builtinByKey.get(typeKey(model));
          return bundled ? [bundled] : [];
        });
        const snapshot = compose(mergeCatalog(restored, []), builtinKeys, undefined, openRouterCost);
        await context.publish({
          update: () => {
            state = { ...snapshot, source: 'restored' };
          },
        });
      }
      return;
    }
    const credential = context.credential;
    const key = credential?.type === 'oauth' ? credential.access : credential?.type === 'api_key' ? credential.key : undefined;
    if (!key) return;
    const catalog = await loadCatalog(context.signal, builtin, builtinGeneratedAt);
    if (!catalog || context.signal?.aborted) return;
    const allowed = await fetchUserModels(context.baseUrl ?? base.baseUrl, key, context.signal);
    if (context.signal?.aborted) return;
    const snapshot = compose(catalog.models, builtinKeys, allowed, openRouterCost);
    const source = catalog.usedRemote ? 'bundled+pi.dev' : 'bundled';
    debug(`refresh: source=${source} key-usable=${snapshot.allowed ?? 'unavailable'} skipped=${snapshot.skipped.size}`);
    await context.publish({
      persist: { models: snapshot.models, checkedAt: Date.now(), catalogLastModified: catalog.lastModified },
      update: () => {
        state = { ...snapshot, source };
      },
    });
  }

  try {
    pi.registerProvider({ ...base, getModels: () => state.models.filter(isChat), getAllModels: () => state.models, refreshModels });
  } catch {
    console.warn('[openrouter-live] provider registration failed; keeping the built-in provider');
    return;
  }

  pi.registerCommand('openrouter-sync', {
    description: 'Refresh the OpenRouter model list now and report catalog coverage',
    handler: async (_args, ctx) => {
      let errors;
      try {
        errors = (await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true }))?.errors;
      } catch {
        ctx.ui?.notify?.('OpenRouter refresh failed', 'error');
        return;
      }
      const lines = [
        `source ${state.source} · ${state.models.filter(isChat).length} chat · ${state.models.filter((m) => m.type === 'image').length} image · ${state.models.filter((m) => m.type === 'classifier').length} classifier`,
        `key-usable ${state.allowed ?? 'unavailable'} · skipped ${state.skipped.size}`,
      ];
      for (const [id, reason] of [...state.skipped].slice(0, 10)) lines.push(`  ${id}: ${reason}`);
      if (errors?.size) lines.push('  refresh failed; keeping the previous list');
      ctx.ui?.notify?.(lines.join('\n'), errors?.size ? 'error' : 'info');
    },
  });

  pi.registerCommand('openrouter-explain', {
    description: 'Show the exact source of an OpenRouter model entry or why it was skipped',
    handler: async (args, ctx) => {
      const id = (args ?? '').trim();
      if (!id) return ctx.ui?.notify?.('Usage: /openrouter-explain <model-id>', 'error');
      const models = state.models.filter((model) => model.id === id);
      if (models.length === 0) return ctx.ui?.notify?.(`${id}: ${state.skipped.get(id) ?? 'not in the current OpenRouter list'}`, 'error');
      const lines = models.map(
        (model) =>
          `${model.id} (${model.type ?? 'chat'}) · source: ${state.provenance.get(typeKey(model)) ?? state.source} · API: ${model.api}`,
      );
      ctx.ui?.notify?.(lines.join('\n'), 'info');
    },
  });
}
