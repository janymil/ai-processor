import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { resetGatewayState } from '../gateway';
import { resetBreakers } from '../providers';
import { authed, call, captureConsole, completion, configureEnv, start, stubUpstream, type Running } from './helpers';

let server: Running;
let restoreEnv: () => void;

beforeEach(async () => {
  restoreEnv = configureEnv();
  resetBreakers();
  resetGatewayState();
  server = await start(createApp());
});

afterEach(async () => {
  await server.close();
  restoreEnv();
});

const task = (body: unknown, headers: Record<string, string> = authed()) =>
  call(server.port, { method: 'POST', path: '/execute-gpt-task', headers, body });

describe('legacy endpoints (deprecated, still secured)', () => {
  it('sit behind the same API key check', async () => {
    stubUpstream(() => completion());
    expect((await task({ task: 'spending-insights', userId: 'u', payload: {} }, {})).status).toBe(401);
    expect((await call(server.port, { method: 'POST', path: '/generate-financial-tip', body: {} })).status).toBe(401);
    expect((await call(server.port, { method: 'POST', path: '/api/ai/voice-extract', body: { prompt: 'x' } })).status).toBe(401);
  });

  it('answer with a Deprecation header', async () => {
    stubUpstream(() => completion('{}'));
    const reply = await task({ task: 'no-such-task', userId: 'u', payload: { a: 1 } });
    expect(reply.status).toBe(400);
    expect(reply.headers.deprecation).toBe('true');

    const tip = await call(server.port, { method: 'POST', path: '/generate-daily-recommendation', headers: authed(), body: {} });
    expect(tip.headers.deprecation).toBe('true');
  });

  it('financial-health-score with a bad payload is a 422, not a made-up score of 50', async () => {
    const calls = stubUpstream(() => completion('{}'));
    const reply = await task({ task: 'financial-health-score', userId: 'u', payload: { language: 'en-us' } });

    expect(reply.status).toBe(422);
    expect(reply.json.error).toMatchObject({ type: 'invalid_request_error', code: 'invalid_payload' });
    expect(reply.text).not.toContain('"score"');
    expect(calls).toHaveLength(0);
  });

  it('still routes real work through the shared provider chain', async () => {
    const calls = stubUpstream(() => completion(JSON.stringify({ category: 'Groceries', confidence: 0.9, reasoning: 'ok' })));
    const reply = await task({
      task: 'categorizeExpense',
      userId: 'u',
      payload: { description: 'Lidl', amount: 12.5, language: 'en-us' },
    });

    expect(reply.status).toBe(200);
    expect(reply.json.category).toBe('Groceries');
    expect(calls[0].host).toBe('api.openai.com');
  });

  it('never logs request payloads or results (contextual-tips used to log both)', async () => {
    const lines = captureConsole();
    stubUpstream(() => completion(JSON.stringify({ tips: [{ title: 'RESULT-MARKER-55e0', description: 'x' }] })));

    await task({
      task: 'contextual-tips',
      userId: 'user-with-a-long-id',
      payload: {
        summary: { totalIncome: 1000, totalExpenses: 500 },
        transactions: [{ description: 'PAYLOAD-MARKER-31bb', amount: 12, date: '2026-10-01', type: 'expense', categoryName: 'Food' }],
      },
    });

    const output = lines.join('\n');
    expect(output).not.toContain('PAYLOAD-MARKER-31bb');
    expect(output).not.toContain('RESULT-MARKER-55e0');
    expect(output).not.toContain('user-with-a-long-id');
  });
});

describe('module contract', () => {
  it('index.ts is the only file that listens', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '..');
    for (const file of ['app.ts', 'gateway.ts', 'legacy.ts', 'providers.ts']) {
      expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(/\.listen\(/);
    }
    expect(readFileSync(join(root, 'index.ts'), 'utf8')).toMatch(/\.listen\(/);
    vi.restoreAllMocks();
  });
});
