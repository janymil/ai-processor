import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { resetGatewayState } from '../gateway';
import { resetBreakers } from '../providers';
import {
  GATEWAY_KEY,
  OPENAI_KEY,
  authed,
  call,
  captureConsole,
  chatBody,
  completion,
  configureEnv,
  failure,
  hangUntilAborted,
  start,
  stubUpstream,
  waitFor,
  type Running,
} from './helpers';

let server: Running;
let restoreEnv: () => void;

async function boot(overrides: Record<string, string | undefined> = {}) {
  restoreEnv = configureEnv(overrides);
  resetBreakers();
  resetGatewayState();
  server = await start(createApp());
}

afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  restoreEnv?.();
});

const chat = (body: unknown, headers: Record<string, string> = authed()) =>
  call(server.port, { method: 'POST', path: '/v1/chat/completions', headers, body });

describe('authentication (fail closed)', () => {
  it('answers 503 on every route except /health when no key is configured', async () => {
    await boot({ AI_PROCESSOR_API_KEY: undefined });
    const calls = stubUpstream(() => completion());

    for (const path of ['/v1/chat/completions', '/health/details', '/execute-gpt-task', '/anything']) {
      const reply = await call(server.port, { method: path === '/health/details' ? 'GET' : 'POST', path, headers: authed(), body: chatBody() });
      expect(reply.status, path).toBe(503);
      expect(reply.json.error.code).toBe('gateway_not_configured');
    }
    expect(calls).toHaveLength(0);

    const health = await call(server.port, { path: '/health' });
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ status: 'ok', service: 'ai-processor', authConfigured: false });
  });

  it('answers 401 for a missing or wrong key and never reaches a provider', async () => {
    await boot();
    const calls = stubUpstream(() => completion());

    const missing = await chat(chatBody(), {});
    const wrong = await chat(chatBody(), { 'x-api-key': 'nope' });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(wrong.json.error).toMatchObject({ type: 'authentication_error', code: 'invalid_api_key' });
    expect(calls).toHaveLength(0);
  });

  it('accepts the key as x-api-key or as a Bearer token', async () => {
    await boot();
    stubUpstream(() => completion());

    expect((await chat(chatBody(), { 'x-api-key': GATEWAY_KEY })).status).toBe(200);
    expect((await chat(chatBody(), { authorization: `Bearer ${GATEWAY_KEY}` })).status).toBe(200);
  });

  it('accepts any key from a comma-separated list (key rotation)', async () => {
    await boot({ AI_PROCESSOR_API_KEY: 'old-key, new-key' });
    stubUpstream(() => completion());

    expect((await chat(chatBody(), { 'x-api-key': 'old-key' })).status).toBe(200);
    expect((await chat(chatBody(), { 'x-api-key': 'new-key' })).status).toBe(200);
    expect((await chat(chatBody(), { 'x-api-key': 'old-key, new-key' })).status).toBe(401);
  });

  it('locks an address out after too many failed attempts', async () => {
    await boot({ GATEWAY_AUTH_FAILS_PER_MIN: '3' });
    stubUpstream(() => completion());

    for (let i = 0; i < 3; i++) {
      expect((await chat(chatBody(), { 'x-api-key': 'bad' })).status).toBe(401);
    }
    const locked = await chat(chatBody(), { 'x-api-key': 'bad' });
    expect(locked.status).toBe(429);
    expect(locked.json.error.code).toBe('auth_rate_limited');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('authentication under attack', () => {
  it('lets the right key through even after bad keys locked the address out', async () => {
    await boot({ GATEWAY_AUTH_FAILS_PER_MIN: '3' });
    stubUpstream(() => completion());

    for (let i = 0; i < 5; i++) await chat(chatBody(), { 'x-api-key': 'bad' });
    expect((await chat(chatBody(), { 'x-api-key': 'bad' })).status).toBe(429);

    expect((await chat(chatBody(), authed())).status).toBe(200);
  });
});

describe('request validation', () => {
  beforeEach(async () => {
    await boot();
  });

  it.each([
    ['no messages', {}, 'invalid_messages'],
    ['messages not an array', { messages: 'hi' }, 'invalid_messages'],
    ['empty messages', { messages: [] }, 'invalid_messages'],
    ['unknown role', { messages: [{ role: 'wizard', content: 'x' }] }, 'invalid_messages'],
    ['content missing', { messages: [{ role: 'user' }] }, 'invalid_messages'],
    ['non-positive max_tokens', chatBody('x', { max_tokens: 0 }), 'invalid_request'],
  ])('rejects %s with 400', async (_name, body, code) => {
    const calls = stubUpstream(() => completion());
    const reply = await chat(body);
    expect(reply.status).toBe(400);
    expect(reply.json.error).toMatchObject({ type: 'invalid_request_error', code });
    expect(calls).toHaveLength(0);
  });

  it('rejects a model the gateway does not price or route, before anything is sent', async () => {
    const calls = stubUpstream(() => completion());
    const reply = await chat(chatBody('x', { model: 'some-very-expensive-model' }));
    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBe('unknown_model');
    expect(calls).toHaveLength(0);
  });

  it.each([123, '', '   ', null])('rejects a model that is not a name (%j)', async (model) => {
    stubUpstream(() => completion());
    const reply = await chat(chatBody('x', { model }));
    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBe('invalid_model');
  });

  it('accepts every catalogued model, and no model at all', async () => {
    stubUpstream(() => completion());
    for (const model of ['gpt-6-luna', 'deepseek-flash', 'openai/gpt-oss-120b', 'mistral-small-latest']) {
      expect((await chat(chatBody('x', { model }))).status, model).toBe(200);
    }
    expect((await chat(chatBody())).status).toBe(200);
  });

  it('lets an operator allow any model on purpose', async () => {
    await boot({ GATEWAY_ALLOW_ANY_MODEL: 'true' });
    stubUpstream(() => completion());
    expect((await chat(chatBody('x', { model: 'brand-new-model' }))).status).toBe(200);
  });

  it('rejects more than 80 messages', async () => {
    stubUpstream(() => completion());
    const messages = Array.from({ length: 81 }, () => ({ role: 'user', content: 'x' }));
    const reply = await chat({ messages });
    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBe('too_many_messages');
  });

  it('accepts exactly 80 messages', async () => {
    stubUpstream(() => completion());
    const messages = Array.from({ length: 80 }, () => ({ role: 'user', content: 'x' }));
    expect((await chat({ messages })).status).toBe(200);
  });

  it('rejects more than 600k characters of text and accepts exactly 600k', async () => {
    const calls = stubUpstream(() => completion());
    const tooBig = await chat(chatBody('a'.repeat(600_001)));
    expect(tooBig.status).toBe(400);
    expect(tooBig.json.error.code).toBe('request_too_large');
    expect(calls).toHaveLength(0);

    const exact = await chat(chatBody('a'.repeat(600_000)));
    expect(exact.status).toBe(200);
  });

  it('counts the text parts of array content', async () => {
    stubUpstream(() => completion());
    const reply = await chat({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(600_001) }] }] });
    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBe('request_too_large');
  });

  it('rejects a body over 5mb as too large, with the standard error shape', async () => {
    stubUpstream(() => completion());
    const reply = await call(server.port, {
      method: 'POST',
      path: '/v1/chat/completions',
      headers: authed(),
      raw: JSON.stringify(chatBody('a'.repeat(5.5 * 1024 * 1024))),
    });
    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBe('request_too_large');
  });

  it('rejects malformed JSON with 400', async () => {
    const reply = await call(server.port, { method: 'POST', path: '/v1/chat/completions', headers: authed(), raw: '{not json' });
    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBe('invalid_json');
  });

  it('rejects streaming', async () => {
    const calls = stubUpstream(() => completion());
    const reply = await chat(chatBody('hi', { stream: true }));
    expect(reply.status).toBe(400);
    expect(reply.json.error.code).toBe('stream_not_supported');
    expect(calls).toHaveLength(0);
  });

  it('caps max_tokens at 8000', async () => {
    const calls = stubUpstream(() => completion());
    await chat(chatBody('hi', { max_tokens: 99_999 }));
    expect(calls[0].body.max_completion_tokens).toBe(8000);
    expect(calls[0].body.max_tokens).toBeUndefined();
  });

  it('drops control and unknown fields before the request leaves', async () => {
    const calls = stubUpstream(() => completion());
    await chat(chatBody('hi', { task: 'secret-task', userId: 'user-1', foo: 'bar', stream: false, temperature: 0.2 }));
    const sent = calls[0].body;
    expect(sent).not.toHaveProperty('task');
    expect(sent).not.toHaveProperty('userId');
    expect(sent).not.toHaveProperty('foo');
    expect(sent).not.toHaveProperty('stream');
    expect(sent.temperature).toBe(0.2);
    expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('returns a JSON 404 for unknown routes (after authentication)', async () => {
    const reply = await call(server.port, { path: '/nope', headers: authed() });
    expect(reply.status).toBe(404);
    expect(reply.json.error.code).toBe('not_found');
  });
});

describe('routing and metering', () => {
  beforeEach(async () => {
    await boot();
  });

  it('returns an OpenAI-shaped answer with usage and x_gateway', async () => {
    const calls = stubUpstream(() => completion('{"hello":"world"}'));
    const reply = await chat(chatBody('hi'), authed({ 'x-app': 'kaptia', 'x-task': 'tips', 'x-request-id': 'req-123' }));

    expect(reply.status).toBe(200);
    expect(reply.headers['x-request-id']).toBe('req-123');
    expect(reply.json.choices[0].message).toEqual({ role: 'assistant', content: '{"hello":"world"}' });
    expect(reply.json.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    expect(reply.json.x_gateway).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', fallback: false, redactions: 0 });
    // gpt-6-luna: $0.10 / $0.50 per million tokens.
    expect(reply.json.x_gateway.costUsd).toBeCloseTo((100 * 0.1 + 50 * 0.5) / 1_000_000, 10);
    expect(typeof reply.json.x_gateway.ms).toBe('number');

    expect(calls[0].host).toBe('api.openai.com');
    expect(calls[0].headers).toMatchObject({ Authorization: `Bearer ${OPENAI_KEY}` });
  });

  it('computes total_tokens and zero cost when the provider sends no usage', async () => {
    stubUpstream(() => completion('{"a":1}', null));
    const reply = await chat(chatBody('hi'));
    expect(reply.json.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    expect(reply.json.x_gateway.costUsd).toBe(0);
  });

  it('strips code fences some models add around JSON', async () => {
    stubUpstream(() => completion('```json\n{"a":1}\n```'));
    const reply = await chat(chatBody('hi'));
    expect(reply.json.choices[0].message.content).toBe('{"a":1}');
  });

  it.each([500, 429])('falls back to the next provider after a %i', async (status) => {
    const calls = stubUpstream((c) => (c.host === 'api.openai.com' ? failure(status) : completion('{"from":"deepseek"}')));
    const reply = await chat(chatBody('hi'));

    expect(reply.status).toBe(200);
    expect(reply.json.x_gateway).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash', fallback: true });
    expect(calls.map((c) => c.host)).toEqual(['api.openai.com', 'api.deepseek.com']);
    expect(calls[1].body.thinking).toEqual({ type: 'disabled' });
  });

  it('falls back when a provider answers with empty content', async () => {
    stubUpstream((c) => (c.host === 'api.openai.com' ? completion('   ') : completion('{"ok":1}')));
    const reply = await chat(chatBody('hi'));
    expect(reply.status).toBe(200);
    expect(reply.json.x_gateway.provider).toBe('deepseek');
  });

  it('does NOT fall back on a 400: the request itself is wrong', async () => {
    const calls = stubUpstream(() => failure(400, 'invalid request'));
    const reply = await chat(chatBody('hi'));

    expect(reply.status).toBe(400);
    expect(reply.json.error).toMatchObject({ type: 'invalid_request_error', code: 'upstream_rejected_request' });
    expect(calls).toHaveLength(1);
  });

  it('retries once on the same provider without sampling parameters when temperature is rejected', async () => {
    const calls = stubUpstream((c) =>
      c.body.temperature !== undefined ? failure(400, "Unsupported value: 'temperature' does not support 0.2") : completion('{"ok":1}'),
    );
    const reply = await chat(chatBody('hi', { temperature: 0.2 }));

    expect(reply.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].host).toBe('api.openai.com');
    expect(calls[1].body.temperature).toBeUndefined();
  });

  it('answers 502 when every provider fails', async () => {
    const calls = stubUpstream(() => failure(503));
    const reply = await chat(chatBody('hi'));
    expect(reply.status).toBe(502);
    expect(reply.json.error).toMatchObject({ type: 'server_error', code: 'upstream_unavailable' });
    expect(calls).toHaveLength(3);
  });

  it('answers 504 when every provider times out', async () => {
    await server.close();
    restoreEnv();
    await boot({ AI_REQUEST_TIMEOUT_MS: '30' });
    const calls = stubUpstream(hangUntilAborted);

    const reply = await chat(chatBody('hi'));
    expect(reply.status).toBe(504);
    expect(reply.json.error.code).toBe('upstream_timeout');
    expect(calls).toHaveLength(3);
  });

  it('answers 503 when the gateway has a key but no provider is configured', async () => {
    await server.close();
    restoreEnv();
    await boot({ OPENAI_API_KEY: undefined, DEEPSEEK_API_KEY: undefined, GROQ_API_KEY: undefined });
    const calls = stubUpstream(() => completion());

    const reply = await chat(chatBody('hi'));
    expect(reply.status).toBe(503);
    expect(reply.json.error.code).toBe('no_provider_configured');
    expect(calls).toHaveLength(0);
  });

  it('stops walking the fallback chain once the time budget is spent', async () => {
    await server.close();
    restoreEnv();
    await boot({ AI_TOTAL_BUDGET_MS: '1' });
    const calls = stubUpstream(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return failure(500);
    });

    const reply = await chat(chatBody('hi'));
    expect(reply.status).toBe(502);
    expect(calls).toHaveLength(1);
  });
});

describe('circuit breaker', () => {
  beforeEach(async () => {
    await boot();
  });

  it('skips a provider after 3 failures in a row, and tries it again after the cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const calls = stubUpstream((c) => (c.host === 'api.openai.com' ? failure(500) : completion('{"ok":1}')));
    const openaiCalls = () => calls.filter((c) => c.host === 'api.openai.com').length;

    for (let i = 0; i < 3; i++) await chat(chatBody('hi'));
    expect(openaiCalls()).toBe(3);

    const skipped = await chat(chatBody('hi'));
    expect(skipped.status).toBe(200);
    expect(skipped.json.x_gateway.provider).toBe('deepseek');
    expect(openaiCalls()).toBe(3); // not asked a 4th time

    const details = await call(server.port, { path: '/health/details', headers: authed() });
    const openai = details.json.providers.find((p: any) => p.provider === 'openai');
    expect(openai).toMatchObject({ circuit: 'open', consecutiveFailures: 3 });

    vi.setSystemTime(Date.now() + 61_000);
    await chat(chatBody('hi'));
    expect(openaiCalls()).toBe(4); // cooldown over: one new attempt
  });

  it('does not count a 400 against a provider', async () => {
    stubUpstream(() => failure(400, 'bad request'));
    for (let i = 0; i < 4; i++) await chat(chatBody('hi'));

    const details = await call(server.port, { path: '/health/details', headers: authed() });
    const openai = details.json.providers.find((p: any) => p.provider === 'openai');
    expect(openai).toMatchObject({ circuit: 'closed', consecutiveFailures: 0 });
  });

  it('a success closes the failure streak', async () => {
    let fail = true;
    stubUpstream((c) => (c.host === 'api.openai.com' && fail ? failure(500) : completion('{"ok":1}')));
    await chat(chatBody('hi'));
    await chat(chatBody('hi'));
    fail = false;
    await chat(chatBody('hi'));

    const details = await call(server.port, { path: '/health/details', headers: authed() });
    expect(details.json.providers.find((p: any) => p.provider === 'openai').consecutiveFailures).toBe(0);
  });
});

describe('client disconnect', () => {
  it('aborts the in-flight upstream request and stops trying other providers', async () => {
    await boot();
    let upstreamSignal: AbortSignal | undefined;
    let upstreamStarted!: () => void;
    const started = new Promise<void>((resolve) => (upstreamStarted = resolve));
    const calls = stubUpstream((c) => {
      upstreamSignal = c.signal;
      upstreamStarted();
      return hangUntilAborted(c);
    });

    const payload = JSON.stringify(chatBody('hi'));
    const req = http.request({
      host: '127.0.0.1',
      port: server.port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { ...authed(), 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
    });
    req.on('error', () => undefined);
    req.end(payload);

    await started;
    expect(upstreamSignal?.aborted).toBe(false);
    req.destroy();

    await waitFor(() => upstreamSignal?.aborted === true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toHaveLength(1); // no fallback attempt for a reader who left
  });
});

describe('anonymisation safety net', () => {
  beforeEach(async () => {
    await boot();
  });

  it('removes identifiers before the request leaves and reports how many', async () => {
    const calls = stubUpstream(() => completion());
    const reply = await chat({
      messages: [
        { role: 'system', content: 'You help with receipts.' },
        { role: 'user', content: 'Mail john.doe@example.com and pay SK3112000000198742637541 for the Lidl receipt, 24.89 EUR' },
        { role: 'user', content: [{ type: 'text', text: 'Also jane@corp.io' }] },
      ],
    });

    expect(reply.status).toBe(200);
    const sent = JSON.stringify(calls[0].body.messages);
    expect(sent).not.toContain('john.doe@example.com');
    expect(sent).not.toContain('jane@corp.io');
    expect(sent).not.toContain('SK3112000000198742637541');
    expect(sent).toContain('Lidl receipt, 24.89 EUR');
    expect(reply.json.x_gateway.redactions).toBe(3);
  });
});

describe('rate limit', () => {
  it('answers 429 with Retry-After after the per-minute budget', async () => {
    await boot({ GATEWAY_RATE_PER_MIN: '2' });
    stubUpstream(() => completion());

    expect((await chat(chatBody('1'))).status).toBe(200);
    expect((await chat(chatBody('2'))).status).toBe(200);
    const limited = await chat(chatBody('3'));
    expect(limited.status).toBe(429);
    expect(limited.json.error).toMatchObject({ type: 'rate_limit_error', code: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('health', () => {
  it('/health is open and tiny', async () => {
    await boot();
    const reply = await call(server.port, { path: '/health' });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ status: 'ok', service: 'ai-processor', authConfigured: true });
  });

  it('/health/details needs the key and never shows a secret', async () => {
    await boot();
    expect((await call(server.port, { path: '/health/details' })).status).toBe(401);

    const reply = await call(server.port, { path: '/health/details', headers: authed() });
    expect(reply.status).toBe(200);
    expect(reply.json.providers.map((p: any) => p.provider)).toEqual(['openai', 'deepseek', 'groq', 'mistral']);
    expect(reply.json.providers.find((p: any) => p.provider === 'mistral').configured).toBe(false);
    expect(reply.json.limits).toMatchObject({ requestTimeoutMs: 90000, totalBudgetMs: 120000, breakerThreshold: 3, breakerCooldownMs: 60000 });
    for (const secret of [GATEWAY_KEY, OPENAI_KEY, 'sk-test-deepseek-secret', 'sk-test-groq-secret']) {
      expect(reply.text).not.toContain(secret);
    }
  });
});

describe('CORS', () => {
  it('sends no CORS headers by default', async () => {
    await boot();
    const reply = await call(server.port, { path: '/health', headers: { origin: 'https://evil.example' } });
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows only the listed origins when GATEWAY_CORS_ORIGINS is set', async () => {
    await boot({ GATEWAY_CORS_ORIGINS: 'https://app.example.com' });
    const allowed = await call(server.port, { path: '/health', headers: { origin: 'https://app.example.com' } });
    const denied = await call(server.port, { path: '/health', headers: { origin: 'https://evil.example' } });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('logging', () => {
  it('never writes message content or answers to the console, only metadata', async () => {
    await boot();
    const lines = captureConsole();
    stubUpstream(() => completion('{"answer":"ANSWER-MARKER-9f3a"}'));

    const reply = await chat(
      chatBody('Please analyse PROMPT-MARKER-7c1d for me'),
      authed({ 'x-app': 'kaptia', 'x-task': 'insights' }),
    );
    expect(reply.status).toBe(200);

    const output = lines.join('\n');
    expect(output).not.toContain('PROMPT-MARKER-7c1d');
    expect(output).not.toContain('ANSWER-MARKER-9f3a');
    expect(output).toContain('[gateway]');
    expect(output).toContain('app=kaptia');
    expect(output).toContain('task=insights');
    expect(output).toContain('provider=openai');
    expect(output).toContain('cost=');
  });

  it('does not log content when a request fails either', async () => {
    await boot();
    const lines = captureConsole();
    stubUpstream(() => failure(500, 'upstream says PROMPT-MARKER-7c1d'));

    await chat(chatBody('PROMPT-MARKER-7c1d'));
    expect(lines.join('\n')).not.toContain('PROMPT-MARKER-7c1d');
  });
});
