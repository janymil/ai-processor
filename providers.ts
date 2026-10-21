import 'dotenv/config';

/**
 * Provider routing for the standalone AI processor.
 *
 * Self-contained on purpose: this service is meant to be extracted and reused by other
 * apps, so it must not import from the Kaptia web app.
 *
 * Default model is gpt-6-luna. OpenAI calls are normalised (max_tokens ->
 * max_completion_tokens, reasoning_effort) and automatically retried on DeepSeek, then
 * Groq, so a single provider outage does not fail the request.
 */
export type Provider = 'openai' | 'deepseek' | 'groq' | 'mistral';

export const DEFAULT_MODEL = process.env.AI_DEFAULT_MODEL || 'gpt-6-luna';

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

const BASE_URLS: Record<Provider, string> = {
  openai: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
};

function getApiKey(provider: Provider): string | undefined {
  switch (provider) {
    case 'openai': return process.env.OPENAI_API_KEY;
    case 'deepseek': return process.env.DEEPSEEK_API_KEY;
    case 'groq': return process.env.GROQ_API_KEY;
    case 'mistral': return process.env.MISTRAL_API_KEY;
  }
}

const TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS) || 90_000;

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

function buildBody(spec: ModelSpec, params: any): any {
  const body: any = { ...params, model: spec.model };

  if (spec.provider === 'openai' && body.max_tokens != null) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }

  const effort = process.env.AI_REASONING_EFFORT || spec.effort;
  if (spec.provider === 'openai' && effort) {
    body.reasoning_effort = effort;
  } else {
    delete body.reasoning_effort;
  }

  if (spec.disableThinking) {
    body.thinking = { type: 'disabled' };
  }

  return body;
}

async function callProvider(spec: ModelSpec, params: any): Promise<any> {
  const apiKey = getApiKey(spec.provider);
  if (!apiKey) throw new Error(`No API key for provider "${spec.provider}"`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URLS[spec.provider]}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildBody(spec, params)),
      signal: controller.signal,
    });

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

    const usage = json?.usage ?? {};
    const cost = ((usage.prompt_tokens ?? 0) * spec.inputPricePerM + (usage.completion_tokens ?? 0) * spec.outputPricePerM) / 1_000_000;
    console.log(
      `[AI] ${spec.provider}:${spec.model} in=${usage.prompt_tokens ?? 0} out=${usage.completion_tokens ?? 0} $${cost.toFixed(6)}`,
    );

    return json;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function routeChat(params: any): Promise<any> {
  const primary = String(params?.model || DEFAULT_MODEL);
  const chain = [primary, ...(FALLBACKS[primary] ?? FALLBACKS.default)];
  let lastError: any;

  for (const name of chain) {
    const spec = resolveSpec(name);
    if (!getApiKey(spec.provider)) {
      lastError = new Error(`Provider ${spec.provider} not configured`);
      continue;
    }
    try {
      return await callProvider(spec, params);
    } catch (error: any) {
      lastError = error;
      if (error?.status && error.status >= 400 && error.status < 500 && ![401, 403, 408, 409, 429].includes(error.status)) {
        throw error;
      }
      console.warn(`[AI] ${spec.provider}:${spec.model} failed (${error?.status || 'network'}); trying next provider`);
    }
  }

  throw lastError ?? new Error('All AI providers failed');
}

/** Drop-in replacement for `new OpenAI(...)` (chat.completions.create only). */
export function createRoutedClient(): any {
  return { chat: { completions: { create: routeChat } } };
}

export function getProviderStatus() {
  const providers: Provider[] = ['openai', 'deepseek', 'groq', 'mistral'];
  return {
    defaultModel: DEFAULT_MODEL,
    reasoningEffort: process.env.AI_REASONING_EFFORT || 'none',
    providers: providers.map((provider) => ({
      provider,
      configured: Boolean(getApiKey(provider)),
    })),
    fallbacks: FALLBACKS[DEFAULT_MODEL] ?? FALLBACKS.default,
  };
}
