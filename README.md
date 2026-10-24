# AI Processor — a shared AI gateway

One small, secured service that every one of your apps can call for AI. It **does not know any
app's prompts**. The calling app owns its prompts and sends a finished, OpenAI-shaped chat
request; the gateway authenticates it, scrubs identifiers, routes it across providers with
automatic fallback, and tells the caller what it cost.

```
 your app ──(chat request + x-api-key)──▶ gateway ──▶ OpenAI ─┐
    ▲                                        │ fail/slow        │ (breaker per provider)
    └─────(answer + usage + cost)────────────┴──▶ DeepSeek ─▶ Groq
```

Any app can use it: Kaptia today, the next app tomorrow. Kaptia keeps its own direct
OpenAI chain as a fallback for when this service is down.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | `{ status, service, authConfigured }` — liveness only |
| GET | `/health/details` | key | providers, breaker state, limits (never keys) |
| POST | `/v1/chat/completions` | key | the gateway (see contract below) |
| POST | `/execute-gpt-task`, `/generate-financial-tip`, `/generate-daily-recommendation`, `/api/ai/voice-extract` | key | **deprecated** Kaptia endpoints, still working, answer with `Deprecation: true` |

**Fail closed:** if `AI_PROCESSOR_API_KEY` is empty, every route except `GET /health` answers
`503`. A forgotten variable can never turn this into an open relay for paid models.

## Contract: `POST /v1/chat/completions`

Headers: `x-api-key: <key>` (or `Authorization: Bearer <key>`), optional `x-app`, `x-task`,
`x-request-id` (echoed back; used in logs).

Body: OpenAI chat parameters. `messages` is required; `model` is optional. Only these are
forwarded: `model, messages, temperature, top_p, max_tokens, max_completion_tokens,
response_format, stop, seed, presence_penalty, frequency_penalty`. Anything else (including
`task`, `userId`) is dropped. `stream` is rejected.

```json
{
  "messages": [
    { "role": "system", "content": "Reply with JSON only." },
    { "role": "user", "content": "Categorise: Lidl 24.89" }
  ],
  "response_format": { "type": "json_object" },
  "temperature": 0.1,
  "max_tokens": 300
}
```

`200` response (OpenAI-shaped plus `x_gateway`):

```json
{
  "id": "…",
  "model": "gpt-6-luna",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "{…}" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150 },
  "x_gateway": { "provider": "openai", "model": "gpt-6-luna", "costUsd": 0.000035,
                 "fallback": false, "ms": 840, "redactions": 0 }
}
```

`x_gateway.fallback` is `true` when a provider other than the first choice answered.
`redactions` is how many identifiers the gateway's safety net removed.

Errors are always `{ "error": { "message", "type", "code" } }`:

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_messages`, `too_many_messages`, `request_too_large`, `stream_not_supported`, `invalid_json`, `invalid_request`, `upstream_rejected_request` | the request itself is wrong; not retried elsewhere |
| 401 | `invalid_api_key` | missing or wrong key |
| 429 | `rate_limited`, `auth_rate_limited` | too many requests (see `Retry-After`) or too many failed logins |
| 502 | `upstream_unavailable` | every provider failed |
| 503 | `gateway_not_configured`, `no_provider_configured` | no gateway key / no provider key set |
| 504 | `upstream_timeout` | providers did not answer in time |

Limits: 1–80 messages, ≤ 600 000 characters of text in total, `max_tokens` capped at 8000,
request body ≤ 5 MB.

## What the gateway guarantees

- **Authentication, constant-time**, per key; several keys allowed for rotation (`key1,key2`).
- **Rate limits:** `GATEWAY_RATE_PER_MIN` per key; failed logins per address are limited too.
- **Safety-net anonymisation** (`anonymizer.ts`, mirrors Kaptia's rules): e-mails, IBANs, card
  numbers, national/tax IDs, phones, addresses, URLs and long account numbers are removed from
  every message before it leaves. Callers should still anonymise first; this is a second layer.
- **Fallback with a circuit breaker per provider:** `AI_BREAKER_THRESHOLD` provider-side
  failures in a row skip that provider for `AI_BREAKER_COOLDOWN_MS`. A malformed request
  (4xx other than 401/403/408/409/429) is returned as 400 and is never retried or counted.
- **No wasted billing:** if the caller disconnects, the in-flight upstream request is aborted
  and no further provider is tried.
- **Bounded time:** `AI_REQUEST_TIMEOUT_MS` per attempt, `AI_TOTAL_BUDGET_MS` for the whole chain.
- **Never logs content.** Logs are one metadata line per request
  (`app task request status provider model in out cost fallback redactions ms`).
- **Metering:** token usage and `costUsd` in every answer, so the calling app can record real cost.
- **No CORS** unless `GATEWAY_CORS_ORIGINS` lists origins; this is a server-to-server service.

## Environment variables

See [.env.example](.env.example). Summary:

| Variable | Default | Notes |
|---|---|---|
| `AI_PROCESSOR_API_KEY` | — | **required**; comma-separate to rotate |
| `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY` | — | set the providers you want in the chain |
| `AI_DEFAULT_MODEL` | `gpt-6-luna` | any id in `providers.ts` |
| `AI_REASONING_EFFORT` | `none` | `none/minimal/low/medium` |
| `AI_REQUEST_TIMEOUT_MS` | `90000` | per provider attempt |
| `AI_TOTAL_BUDGET_MS` | `120000` | whole fallback walk |
| `AI_BREAKER_THRESHOLD` / `AI_BREAKER_COOLDOWN_MS` | `3` / `60000` | circuit breaker |
| `GATEWAY_RATE_PER_MIN` | `120` | per API key |
| `GATEWAY_AUTH_FAILS_PER_MIN` | `10` | per client address |
| `GATEWAY_CORS_ORIGINS` | empty (off) | comma-separated origins |
| `GATEWAY_TRUST_PROXY` | `false` | `true` behind nginx/Caddy (otherwise every caller shares one address) |
| `GATEWAY_ALLOW_ANY_MODEL` | `false` | `true` lets callers name a model that is not in the catalogue |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | |

## Develop, test, run

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest; no network, no provider keys needed
npm start             # tsx index.ts   (needs AI_PROCESSOR_API_KEY in .env)

curl -s http://localhost:8080/health
curl -s http://localhost:8080/v1/chat/completions \
  -H "x-api-key: $AI_PROCESSOR_API_KEY" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say hi in JSON"}],"response_format":{"type":"json_object"}}'
```

Tests stub `fetch`, so the suite can never reach a provider or spend money.

## Deploy

```bash
sh release.sh                 # docker compose (default; compose binds 127.0.0.1:8081)
DEPLOY_MODE=pm2 sh release.sh # pm2 on the host (pm2.config.json, port 8081)
```

`release.sh` installs, typechecks, runs the tests, restarts, then polls `GET /health` for up to
30 s (it must answer `status: ok` **and** `authConfigured: true`). If the gate fails it rolls
back to the previous image (docker) or the last healthy commit (pm2) and exits 1.

The container runs as the non-root `node` user on `node:22-alpine`, with a read-only
filesystem and a `HEALTHCHECK`. Put nginx/Caddy in front for TLS and set
`GATEWAY_TRUST_PROXY=true`; keep `proxy_read_timeout` ≥ 180 s.

## Using it from another app

1. Give the app its own key: add it to `AI_PROCESSOR_API_KEY` (comma-separated), redeploy.
2. Build your prompts in the app. Send `x-app: my-app` and `x-task: what-it-does` so the logs
   and your cost reports can tell traffic apart.
3. Read `choices[0].message.content`, record `usage` and `x_gateway.costUsd`.
4. Treat any non-200 as "gateway unavailable" and use your own fallback (Kaptia calls OpenAI directly).

## Migration notes (from the old Kaptia-only processor)

- `POST /execute-gpt-task` and the other Kaptia routes still work, are **deprecated**, and now
  require the API key even when none was set before (no key → 503, not "open").
- `financial-health-score` with a payload that has no `transactions` array used to return a
  made-up score of 50 as a success; it now returns `422 { error: { code: "invalid_payload" } }`.
- `GET /health` no longer lists providers; use the authenticated `GET /health/details`.
- Payloads and results are no longer written to the logs.
- CORS is off by default. Browser callers must be listed in `GATEWAY_CORS_ORIGINS`, but this
  service is meant to be called from servers, not browsers.
- Node 22 and `npm ci` are used in the image; `express`, `axios` and `tsx` were upgraded to clear
  known vulnerabilities (`npm audit --omit=dev` reports none).
- `index.ts` is now only the bootstrap; the app lives in `app.ts` (importable by tests),
  the gateway in `gateway.ts`, providers in `providers.ts`, the deprecated routes in `legacy.ts`.

## Known limitation

The legacy Kaptia prompts in `legacy.ts` duplicate prompts that also live in the Kaptia app.
New work should use `/v1/chat/completions` and keep prompts in the calling app.
