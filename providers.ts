import 'dotenv/config';

/**
 * Provider routing for the AI gateway.
 *
 * Self-contained on purpose: this service serves many apps, so it must not import from any
 * of them.
 *
 * - Default model is gpt-6-luna; failures walk a fallback chain (DeepSeek, then Groq).
 * - Provider keys, base URLs and every tunable are read at call time, never at import.
 * - One circuit breaker per provider: after AI_BREAKER_THRESHOLD provider-side failures in a
 *   row the provider is skipped for AI_BREAKER_COOLDOWN_MS.
 * - A client that goes away aborts the in-flight upstream request and stops the fallback
 *   walk, so nothing is billed for an answer nobody will read.
 * - A request that is itself wrong (4xx other than 401/403/408/409/429) is never retried
 *   elsewhere and never counts against a provider.
 *
 * Nothing in here logs prompts or answers — metadata only.
 */
export type Provider = 'openai' | 'deepseek' | 'groq' | 'mistral';

export type GatewayErrorKind =
  | 'bad_request'
  | 'timeout'
  | 'unavailable'
  | 'not_configured'
  | 'aborted';

export class GatewayError extends Error {
  kind: GatewayErrorKind;
  status?: number;
  constructor(kind: GatewayErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'GatewayError';
    this.kind = kind;
    this.status = status;
  }
}

interface ModelSpec {
  provider: Provider;
  model: string;
  inputPricePerM: number;
  outputPricePerM: number;
  effort?: 'none' | 'minimal' | 'low' | 'medium';
  disableThinking?: boolean;
}

const CATALOG: Record<string, ModelSpec> = {
  'gpt-6-luna': { provider: 'openai', model: 'gpt-6-luna', inputPricePerM: 0.1, outputPricePerM: 0.5, effort: 'none' },
  'gpt-5-nano': { provider: 'openai', model: 'gpt-5-nano', inputPricePerM: 0.05, outputPricePerM: 0.4, effort: 'minimal' },
  'gpt-6.1-sol': { provider: 'openai', model: 'gpt-6.1-sol', inputPricePerM: 2, outputPricePerM: 10 },
  'deepseek-flash': { provider: 'deepseek', model: 'deepseek-flash', inputPricePerM: 0.3, outputPricePerM: 1.2, disableThinking: true },
  'openai/gpt-oss-20b': { provider: 'groq', model: 'openai/gpt-oss-20b', inputPricePerM: 0.075, outputPricePerM: 0.3 },
  'openai/gpt-oss-120b': { provider: 'groq', model: 'openai/gpt-oss-120b', inputPricePerM: 0.15, outputPricePerM: 0.6 },
  'mistral-small-latest': { provider: 'mistral', model: 'mistral-small-latest', inputPricePerM: 0.15, outputPricePerM: 0.6 },
};

const FALLBACKS: Record<string, string[]> = {
  'gpt-6-luna': ['deepseek-flash', 'openai/gpt-oss-20b'],
  'gpt-5-nano': ['openai/gpt-oss-20b', 'deepseek-flash'],
  'deepseek-flash': ['gpt-6-luna', 'openai/gpt-oss-20b'],
  'mistral-small-latest': ['gpt-6-luna'],
  default: ['deepseek-flash'],
};

const KEY_ENV: Record<Provider, string> = {
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

const ALL_PROVIDERS = Object.keys(KEY_ENV) as Provider[];

/** Everything else a caller sends is dropped: this is an OpenAI-shaped chat gateway, nothing more. */
const ALLOWED_PARAMS = [
  'model',
  'messages',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'response_format',
  'stop',
  'seed',
  'presence_penalty',
  'frequency_penalty',
] as const;

export const MAX_OUTPUT_TOKENS = 8000;

/** True for the models this gateway has a price and a route for. */
export function isKnownModel(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOG, name);
}

export function defaultModel(): string {
  return process.env.AI_DEFAULT_MODEL || 'gpt-6-luna';
}

/** Kept for the legacy endpoints that import the constant. */
export const DEFAULT_MODEL = defaultModel();

function keyFor(provider: Provider): string | undefined {
  return process.env[KEY_ENV[provider]] || undefined;
}

function baseUrlFor(provider: Provider): string {
  switch (provider) {
    case 'openai': return process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    case 'deepseek': return 'https://api.deepseek.com';
    case 'groq': return 'https://api.groq.com/openai/v1';
    case 'mistral': return 'https://api.mistral.ai/v1';
  }
}

function requestTimeoutMs(): number {
  return Number(process.env.AI_REQUEST_TIMEOUT_MS) || 90_000;
}
function totalBudgetMs(): number {
  return Number(process.env.AI_TOTAL_BUDGET_MS) || 120_000;
}
function breakerThreshold(): number {
  return Number(process.env.AI_BREAKER_THRESHOLD) || 3;
}
function breakerCooldownMs(): number {
  return Number(process.env.AI_BREAKER_COOLDOWN_MS) || 60_000;
}

// ---------------------------------------------------------------- circuit breaker

interface BreakerState {
  failures: number;
  openUntil: number;
  lastError?: string;
  lastFailureAt?: number;
}

const breakers = new Map<Provider, BreakerState>();

function breakerFor(provider: Provider): BreakerState {
  let state = breakers.get(provider);
  if (!state) {
    state = { failures: 0, openUntil: 0 };
    breakers.set(provider, state);
  }
  return state;
}

function isOpen(provider: Provider, now: number): boolean {
  return breakerFor(provider).openUntil > now;
}

function recordSuccess(provider: Provider): void {
  const state = breakerFor(provider);
  state.failures = 0;
  state.openUntil = 0;
}

/** Only failures that say something about the provider count; a malformed request does not. */
function countsAgainstProvider(error: any): boolean {
  const status = error?.status;
  if (!status) return true;
  return status >= 500 || [401, 403, 408, 409, 429].includes(status);
}

function recordFailure(provider: Provider, error: any, now: number): void {
  const state = breakerFor(provider);
  state.lastError = String(error?.message || error).slice(0, 160);
  state.lastFailureAt = now;
  if (!countsAgainstProvider(error)) return;
  state.failures += 1;
  if (state.failures >= breakerThreshold()) {
    state.openUntil = now + breakerCooldownMs();
  }
}

/** Test helper: forget every provider's failure history. */
export function resetBreakers(): void {
  breakers.clear();
}

// ---------------------------------------------------------------- request building

function stripCodeFences(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return text;
  return trimmed.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

function resolveSpec(requested: string): ModelSpec {
  return CATALOG[requested] || {
    provider: 'openai',
    model: requested,
    inputPricePerM: 0.1,
    outputPricePerM: 0.5,
    effort: 'none',
  };
}

export function buildBody(spec: ModelSpec, params: any): any {
  const body: any = {};
  for (const key of ALLOWED_PARAMS) {
    if (params?.[key] !== undefined) body[key] = params[key];
  }
  body.model = spec.model;

  for (const key of ['max_tokens', 'max_completion_tokens']) {
    if (typeof body[key] === 'number' && body[key] > MAX_OUTPUT_TOKENS) body[key] = MAX_OUTPUT_TOKENS;
  }

  // OpenAI reasoning models reject max_tokens; they expect max_completion_tokens.
  if (spec.provider === 'openai' && body.max_tokens != null) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }

  const effort = process.env.AI_REASONING_EFFORT || spec.effort;
  if (spec.provider === 'openai' && effort) {
    body.reasoning_effort = effort;
  }

  // DeepSeek defaults to thinking mode, which can eat the whole output budget.
  if (spec.disableThinking) {
    body.thinking = { type: 'disabled' };
  }

  return body;
}

// ---------------------------------------------------------------- upstream call

export interface ChatMeta {
  provider: Provider;
  model: string;
  costUsd: number;
  fallback: boolean;
  ms: number;
}

export interface ChatResult {
  response: any;
  meta: ChatMeta;
}

export interface ChatOptions {
  /** Aborted when the caller goes away. */
  signal?: AbortSignal;
}

async function post(spec: ModelSpec, body: any, parent: AbortSignal | undefined): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs());
  const onParentAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    return await fetch(`${baseUrlFor(spec.provider)}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${keyFor(spec.provider)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error: any) {
    if (parent?.aborted) throw new GatewayError('aborted', 'Client disconnected');
    if (timedOut || error?.name === 'AbortError') {
      const timeout: any = new GatewayError('timeout', `${spec.provider} timed out after ${requestTimeoutMs()}ms`);
      timeout.status = undefined;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}

async function callProvider(spec: ModelSpec, params: any, signal: AbortSignal | undefined): Promise<any> {
  let body = buildBody(spec, params);
  let response = await post(spec, body, signal);

  // Some reasoning models reject sampling parameters: retry once on the same provider without them.
  if (response.status === 400 && (body.temperature !== undefined || body.top_p !== undefined)) {
    const detail = (await response.text()).slice(0, 300);
    if (/temperature|top_p|unsupported parameter/i.test(detail)) {
      body = { ...body };
      delete body.temperature;
      delete body.top_p;
      response = await post(spec, body, signal);
    } else {
      const error: any = new Error(`${spec.provider} HTTP 400: ${detail.slice(0, 200)}`);
      error.status = 400;
      throw error;
    }
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    const error: any = new Error(`${spec.provider} HTTP ${response.status}: ${detail}`);
    error.status = response.status;
    throw error;
  }

  const json: any = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content || String(content).trim() === '') {
    throw new Error(`Empty response from ${spec.provider}:${spec.model}`);
  }
  if (typeof content === 'string') {
    json.choices[0].message.content = stripCodeFences(content);
  }
  return json;
}

function costOf(spec: ModelSpec, usage: any): number {
  return ((usage?.prompt_tokens ?? 0) * spec.inputPricePerM + (usage?.completion_tokens ?? 0) * spec.outputPricePerM) / 1_000_000;
}

/**
 * Sends one chat request through the fallback chain.
 * Throws `GatewayError`: bad_request (do not retry), timeout, unavailable, not_configured,
 * or aborted (the caller left; write nothing).
 */
export async function chatRoute(params: any, options: ChatOptions = {}): Promise<ChatResult> {
  const { signal } = options;
  const startedAt = Date.now();
  const primary = String(params?.model || defaultModel());
  const chain = [primary, ...(FALLBACKS[primary] ?? FALLBACKS.default)]
    .map(resolveSpec)
    .filter((spec) => Boolean(keyFor(spec.provider)));

  if (chain.length === 0) {
    throw new GatewayError('not_configured', 'No AI provider is configured on the gateway');
  }

  // Skip open breakers; if every provider is open, try them all anyway.
  const healthy = chain.filter((spec) => !isOpen(spec.provider, startedAt));
  const candidates = healthy.length > 0 ? healthy : chain;
  let lastError: any;

  for (const spec of candidates) {
    if (signal?.aborted) throw new GatewayError('aborted', 'Client disconnected');
    try {
      const json = await callProvider(spec, params, signal);
      recordSuccess(spec.provider);

      const usage = json.usage ?? {};
      const promptTokens = usage.prompt_tokens ?? 0;
      const completionTokens = usage.completion_tokens ?? 0;
      json.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: usage.total_tokens ?? promptTokens + completionTokens,
      };

      return {
        response: json,
        meta: {
          provider: spec.provider,
          model: spec.model,
          costUsd: costOf(spec, json.usage),
          fallback: spec !== chain[0],
          ms: Date.now() - startedAt,
        },
      };
    } catch (error: any) {
      if (error instanceof GatewayError && error.kind === 'aborted') throw error;
      lastError = error;
      recordFailure(spec.provider, error, Date.now());

      if (!countsAgainstProvider(error)) {
        throw new GatewayError('bad_request', String(error?.message || 'The provider rejected the request'), error.status);
      }
      console.warn(`[AI] ${spec.provider}:${spec.model} failed (${error?.status || error?.kind || 'network'}); trying next provider`);

      if (Date.now() - startedAt > totalBudgetMs()) {
        console.warn('[AI] time budget spent; not trying further providers');
        break;
      }
    }
  }

  if (lastError instanceof GatewayError && lastError.kind === 'timeout') {
    throw new GatewayError('timeout', 'The AI providers did not answer in time');
  }
  throw new GatewayError('unavailable', 'All AI providers failed');
}

/** Drop-in for `new OpenAI(...)` (chat.completions.create only) used by the legacy endpoints. */
export function createRoutedClient(): any {
  return {
    chat: {
      completions: {
        create: async (params: any) => (await chatRoute(params)).response,
      },
    },
  };
}

export function getProviderStatus() {
  const now = Date.now();
  return {
    defaultModel: defaultModel(),
    reasoningEffort: process.env.AI_REASONING_EFFORT || 'none',
    providers: ALL_PROVIDERS.map((provider) => {
      const state = breakerFor(provider);
      return {
        provider,
        configured: Boolean(keyFor(provider)),
        circuit: state.openUntil > now ? 'open' : 'closed',
        consecutiveFailures: state.failures,
        lastError: state.lastError ?? null,
        lastFailureAt: state.lastFailureAt ? new Date(state.lastFailureAt).toISOString() : null,
      };
    }),
    fallbacks: FALLBACKS[defaultModel()] ?? FALLBACKS.default,
    limits: {
      requestTimeoutMs: requestTimeoutMs(),
      totalBudgetMs: totalBudgetMs(),
      breakerThreshold: breakerThreshold(),
      breakerCooldownMs: breakerCooldownMs(),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  };
}
