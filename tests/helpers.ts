import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { vi } from 'vitest';

export const GATEWAY_KEY = 'test-gateway-key';
export const OPENAI_KEY = 'sk-test-openai-secret';

const ENV_TO_CLEAR = [
  'AI_PROCESSOR_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENAI_BASE_URL',
  'AI_DEFAULT_MODEL',
  'AI_REASONING_EFFORT',
  'AI_REQUEST_TIMEOUT_MS',
  'AI_TOTAL_BUDGET_MS',
  'AI_BREAKER_THRESHOLD',
  'AI_BREAKER_COOLDOWN_MS',
  'GATEWAY_RATE_PER_MIN',
  'GATEWAY_AUTH_FAILS_PER_MIN',
  'GATEWAY_CORS_ORIGINS',
  'GATEWAY_TRUST_PROXY',
];

/** Resets the environment to a known configured gateway; returns a function that restores it. */
export function configureEnv(overrides: Record<string, string | undefined> = {}): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_TO_CLEAR) saved[key] = process.env[key];

  for (const key of ENV_TO_CLEAR) delete process.env[key];
  process.env.AI_PROCESSOR_API_KEY = GATEWAY_KEY;
  process.env.OPENAI_API_KEY = OPENAI_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek-secret';
  process.env.GROQ_API_KEY = 'sk-test-groq-secret';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return () => {
    for (const key of ENV_TO_CLEAR) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

export interface Running {
  port: number;
  close: () => Promise<void>;
}

export async function start(app: Express): Promise<Running> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Talks to the app over a real socket with node:http (global fetch is stubbed for the upstream). */
export function call(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: unknown; raw?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (payload !== undefined) {
      headers['content-type'] ??= 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export const authed = (extra: Record<string, string> = {}) => ({ 'x-api-key': GATEWAY_KEY, ...extra });

export const chatBody = (content = 'Say hello', extra: Record<string, unknown> = {}) => ({
  messages: [{ role: 'user', content }],
  ...extra,
});

// ---------------------------------------------------------------- upstream stub

export interface UpstreamCall {
  url: string;
  host: string;
  body: any;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
}

export const completion = (
  content = '{"ok":true}',
  usage: Record<string, number> | null = { prompt_tokens: 100, completion_tokens: 50 },
) =>
  new Response(
    JSON.stringify({
      id: 'cmpl-test',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      ...(usage ? { usage } : {}),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

export const failure = (status: number, text = 'upstream failure') => new Response(text, { status });

/** Replaces global fetch. Every call is recorded; nothing leaves the process. */
export function stubUpstream(handler: (call: UpstreamCall) => Response | Promise<Response>): UpstreamCall[] {
  const calls: UpstreamCall[] = [];
  vi.stubGlobal('fetch', async (input: any, init: any = {}) => {
    const url = String(input);
    const call: UpstreamCall = {
      url,
      host: new URL(url).host,
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
      signal: init.signal,
    };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

/** A pending upstream call that only ends when its signal aborts (or never). */
export function hangUntilAborted(call: UpstreamCall): Promise<Response> {
  return new Promise((_resolve, reject) => {
    call.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  });
}

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Captures everything written through console.*; returns the lines. */
export function captureConsole(): string[] {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(
        args
          .map((arg) => {
            if (typeof arg === 'string') return arg;
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          })
          .join(' '),
      );
    });
  }
  return lines;
}
