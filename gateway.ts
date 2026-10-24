import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { anonymizeText } from './anonymizer';
import { GatewayError, MAX_OUTPUT_TOKENS, chatRoute, getProviderStatus, isKnownModel } from './providers';

/**
 * The app-agnostic part of the service: authentication, rate limits, validation and the
 * OpenAI-shaped `POST /v1/chat/completions` route.
 *
 * Callers own their prompts and send finished chat requests. The gateway only secures,
 * routes and meters them. It never logs message content or answers — metadata only.
 */

export const MAX_MESSAGES = 80;
export const MAX_TOTAL_CHARS = 600_000;

type ErrorType = 'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'server_error';

export function errorBody(message: string, type: ErrorType, code: string) {
  return { error: { message, type, code } };
}

function sendError(res: Response, status: number, message: string, type: ErrorType, code: string) {
  return res.status(status).json(errorBody(message, type, code));
}

// ---------------------------------------------------------------- tiny fixed-window limiter

interface Bucket {
  count: number;
  resetAt: number;
}

class WindowCounter {
  private buckets = new Map<string, Bucket>();
  private static readonly MAX_KEYS = 10_000;

  /** Adds one hit and returns how many hits the window now holds plus seconds until reset. */
  hit(key: string, windowMs: number): { count: number; retryAfter: number } {
    const now = Date.now();
    if (this.buckets.size >= WindowCounter.MAX_KEYS) this.prune(now);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { count: 1, retryAfter: Math.ceil(windowMs / 1000) };
    }
    bucket.count += 1;
    return { count: bucket.count, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  peek(key: string): { count: number; retryAfter: number } {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) return { count: 0, retryAfter: 0 };
    return { count: bucket.count, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  private prune(now: number) {
    for (const [key, bucket] of Array.from(this.buckets.entries())) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    if (this.buckets.size >= WindowCounter.MAX_KEYS) this.buckets.clear();
  }

  clear() {
    this.buckets.clear();
  }
}

const requestWindow = new WindowCounter();
const failedAuthWindow = new WindowCounter();
const WINDOW_MS = 60_000;

/** Test helper. */
export function resetGatewayState(): void {
  requestWindow.clear();
  failedAuthWindow.clear();
}

function ratePerMinute(): number {
  return Number(process.env.GATEWAY_RATE_PER_MIN) || 120;
}
function authFailsPerMinute(): number {
  return Number(process.env.GATEWAY_AUTH_FAILS_PER_MIN) || 10;
}

// ---------------------------------------------------------------- authentication

function configuredKeys(): string[] {
  return String(process.env.AI_PROCESSOR_API_KEY || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Compares through a fixed-length hash so neither length nor content leaks through timing. */
function matchingKey(candidate: string, keys: string[]): string | null {
  const candidateHash = digest(candidate);
  let found: string | null = null;
  for (const key of keys) {
    if (timingSafeEqual(candidateHash, digest(key))) found = key;
  }
  return found;
}

function suppliedKey(req: Request): string {
  const header = req.headers['x-api-key'] ?? req.headers['x-api-token'];
  if (typeof header === 'string' && header) return header;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return '';
}

function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Fail closed: with no key configured every route except `GET /health` answers 503, so a
 * forgotten environment variable can never turn the service into an open relay for paid
 * models.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' && req.path === '/health') return next();
  if (req.method === 'OPTIONS') return next();

  const keys = configuredKeys();
  if (keys.length === 0) {
    return sendError(res, 503, 'The gateway is not configured', 'server_error', 'gateway_not_configured');
  }

  // A correct key always gets through. The lockout only slows down guessing: checking it first
  // would let anyone sharing an address (everyone, behind a proxy that is not trusted) lock the
  // real client out by sending bad keys.
  const candidate = suppliedKey(req);
  const key = candidate ? matchingKey(candidate, keys) : null;
  if (key) {
    (res.locals as any).keyId = digest(key).toString('hex').slice(0, 12);
    return next();
  }

  const ip = clientIp(req);
  const failures = failedAuthWindow.peek(ip);
  if (failures.count >= authFailsPerMinute()) {
    res.setHeader('Retry-After', String(failures.retryAfter));
    return sendError(res, 429, 'Too many failed authentication attempts', 'rate_limit_error', 'auth_rate_limited');
  }

  failedAuthWindow.hit(ip, WINDOW_MS);
  return sendError(res, 401, 'Invalid or missing API key', 'authentication_error', 'invalid_api_key');
}

/** Per API key, so one noisy app cannot starve the others. */
export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const keyId = String((res.locals as any).keyId || 'anonymous');
  const max = ratePerMinute();
  const { count, retryAfter } = requestWindow.hit(keyId, WINDOW_MS);
  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(max - count, 0)));
  if (count > max) {
    res.setHeader('Retry-After', String(retryAfter));
    return sendError(res, 429, 'Rate limit exceeded', 'rate_limit_error', 'rate_limited');
  }
  return next();
}

// ---------------------------------------------------------------- validation

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);

interface Validated {
  params: Record<string, any>;
  messages: Array<{ role: string; content: any }>;
}

function invalid(message: string, code = 'invalid_request'): GatewayError & { code: string } {
  const error: any = new GatewayError('bad_request', message, 400);
  error.code = code;
  return error;
}

function textLength(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, part) => total + (typeof part?.text === 'string' ? part.text.length : 0), 0);
  }
  return 0;
}

export function validateChatRequest(body: any): Validated {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('The request body must be a JSON object');
  }
  if (body.stream) {
    throw invalid('Streaming is not supported by this gateway', 'stream_not_supported');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalid('`messages` must be a non-empty array', 'invalid_messages');
  }
  if (body.messages.length > MAX_MESSAGES) {
    throw invalid(`At most ${MAX_MESSAGES} messages are allowed`, 'too_many_messages');
  }

  let total = 0;
  for (const message of body.messages) {
    if (!message || typeof message !== 'object' || !ROLES.has(message.role)) {
      throw invalid('Every message needs a valid `role`', 'invalid_messages');
    }
    const { content } = message;
    if (typeof content !== 'string' && !Array.isArray(content)) {
      throw invalid('Every message needs string or array `content`', 'invalid_messages');
    }
    total += textLength(content);
  }
  if (total > MAX_TOTAL_CHARS) {
    throw invalid(`The messages hold ${total} characters; the limit is ${MAX_TOTAL_CHARS}`, 'request_too_large');
  }

  // Callers choose among the models this gateway prices and routes; an arbitrary model name would
  // be sent upstream at whatever it costs. GATEWAY_ALLOW_ANY_MODEL=true lifts this on purpose.
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !body.model.trim()) {
      throw invalid('`model` must be a non-empty string', 'invalid_model');
    }
    if (!isKnownModel(body.model) && process.env.GATEWAY_ALLOW_ANY_MODEL !== 'true') {
      throw invalid(`Unknown model "${body.model.slice(0, 60)}"`, 'unknown_model');
    }
  }

  for (const key of ['max_tokens', 'max_completion_tokens']) {
    const value = body[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 1)) {
      throw invalid(`\`${key}\` must be a positive number`);
    }
  }

  const params: Record<string, any> = { ...body };
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    if (typeof params[key] === 'number') params[key] = Math.min(params[key], MAX_OUTPUT_TOKENS);
  }
  return { params, messages: body.messages };
}

/** Second-layer anonymisation of every text part. Returns the count of removed identifiers. */
export function anonymizeChat(messages: Array<{ role: string; content: any }>) {
  let redactions = 0;
  const scrub = (text: string) => {
    const result = anonymizeText(text);
    redactions += Object.values(result.redactions).reduce((sum, n) => sum + n, 0);
    return result.text;
  };

  const cleaned = messages.map((message) => {
    if (typeof message.content === 'string') {
      return { ...message, content: scrub(message.content) };
    }
    return {
      ...message,
      content: message.content.map((part: any) =>
        part && typeof part === 'object' && typeof part.text === 'string' ? { ...part, text: scrub(part.text) } : part,
      ),
    };
  });
  return { messages: cleaned, redactions };
}

// ---------------------------------------------------------------- the route

function label(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[\w.:-]{1,64}$/.test(text) ? text : '-';
}

export async function chatCompletionsHandler(req: Request, res: Response) {
  const requestId = typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].length <= 100
    ? (req.headers['x-request-id'] as string)
    : randomUUID();
  res.setHeader('x-request-id', requestId);

  const app = label(req.headers['x-app']);
  const task = label(req.headers['x-task']);
  const startedAt = Date.now();
  const logLine = (fields: Record<string, string | number | boolean>) =>
    console.log(
      '[gateway] ' +
        Object.entries({ app, task, request: requestId, ...fields })
          .map(([key, value]) => `${key}=${value}`)
          .join(' '),
    );

  let validated: Validated;
  try {
    validated = validateChatRequest(req.body);
  } catch (error: any) {
    logLine({ status: 400, code: error.code || 'invalid_request' });
    return sendError(res, 400, error.message, 'invalid_request_error', error.code || 'invalid_request');
  }

  const { messages, redactions } = anonymizeChat(validated.messages);

  // A client that disconnects cancels the upstream call and the fallback walk.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  try {
    const { response, meta } = await chatRoute({ ...validated.params, messages }, { signal: controller.signal });

    logLine({
      status: 200,
      provider: meta.provider,
      model: meta.model,
      in: response.usage.prompt_tokens,
      out: response.usage.completion_tokens,
      cost: meta.costUsd.toFixed(6),
      fallback: meta.fallback,
      redactions,
      ms: meta.ms,
    });

    return res.json({
      id: response.id || requestId,
      object: 'chat.completion',
      model: meta.model,
      choices: response.choices,
      usage: response.usage,
      x_gateway: {
        provider: meta.provider,
        model: meta.model,
        costUsd: meta.costUsd,
        fallback: meta.fallback,
        ms: meta.ms,
        redactions,
      },
    });
  } catch (error: any) {
    if (error instanceof GatewayError) {
      if (error.kind === 'aborted') {
        logLine({ status: 'client_closed', ms: Date.now() - startedAt });
        return;
      }
      const map: Record<string, [number, ErrorType, string]> = {
        bad_request: [400, 'invalid_request_error', 'upstream_rejected_request'],
        timeout: [504, 'server_error', 'upstream_timeout'],
        unavailable: [502, 'server_error', 'upstream_unavailable'],
        not_configured: [503, 'server_error', 'no_provider_configured'],
      };
      const [status, type, code] = map[error.kind];
      logLine({ status, code, ms: Date.now() - startedAt });
      return sendError(res, status, error.message, type, code);
    }
    logLine({ status: 502, code: 'unexpected', ms: Date.now() - startedAt });
    return sendError(res, 502, 'Unexpected gateway failure', 'server_error', 'upstream_unavailable');
  }
}

// ---------------------------------------------------------------- health

export function healthHandler(_req: Request, res: Response) {
  res.json({
    status: 'ok',
    service: 'ai-processor',
    authConfigured: configuredKeys().length > 0,
  });
}

export function healthDetailsHandler(_req: Request, res: Response) {
  res.json({
    status: 'ok',
    service: 'ai-processor',
    version: process.env.npm_package_version || '2.0.0',
    ...getProviderStatus(),
    gateway: {
      ratePerMinute: ratePerMinute(),
      authFailsPerMinute: authFailsPerMinute(),
      maxMessages: MAX_MESSAGES,
      maxTotalChars: MAX_TOTAL_CHARS,
      corsOrigins: corsOrigins().length,
    },
  });
}

export function corsOrigins(): string[] {
  return String(process.env.GATEWAY_CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
