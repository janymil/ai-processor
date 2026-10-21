# Kaptia AI Processor Service

Standalone Node/Express microservice that proxies Kaptia's AI tasks. It is **optional**: the main app now calls OpenAI/DeepSeek/Groq directly through `lib/aiProvider.ts`, and only uses this service when `AI_PROCESSOR_ENABLED=true`.

## What it does

It receives `{ task, userId, payload }` and runs the matching prompt against OpenAI (and, for voice, Mistral). It keeps the API keys on the server instead of the app, and can host the heavy statement-parsing work away from the web dyno.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness probe. Returns `{ status, service, model }` |
| POST | `/execute-gpt-task` | Main entry point used by the app (`task` + `payload`) |
| POST | `/generate-financial-tip` | Single financial tip |
| POST | `/generate-daily-recommendation` | Daily recommendations |
| POST | `/api/ai/voice-extract` | Voice transcript → transaction |
| POST | `/generate-pdf` | PDF report rendering (Puppeteer/Chromium) |

Supported `task` values for `/execute-gpt-task`: `voice-extraction`, `contextual-tips`, `financial-tips`, `daily-recommendations`, `spending-insights`, `financial-health-score`, `trend-predictions`, `expense-predictions`, `categorizeExpense`, `parseBankStatement`.

**Response contract:** the app passes the JSON straight through, so each task must return the same shape the corresponding function in `server/openai.ts` returns. An `{ "error": ... }` body or an empty array is treated as a failure and the app falls back to direct providers.

## Deployment (new VPS)

Target: `162.35.25.125` → `ai-processor.formatika.dev` (not live yet).

1. **DNS** – point `ai-processor.formatika.dev` (A record) to `162.35.25.125`.
2. **Runtime** – Node 20+, `npm install --omit=dev`, `npm start` (`tsx index.ts`). Chromium is only needed for `/generate-pdf`.
3. **Process manager** – run under systemd or pm2 so it restarts on reboot, e.g.:
   ```ini
   [Service]
   WorkingDirectory=/opt/kaptia-ai-processor
   ExecStart=/usr/bin/npm start
   Environment=PORT=8080
   EnvironmentFile=/opt/kaptia-ai-processor/.env
   Restart=always
   ```
4. **TLS** – terminate HTTPS with nginx/Caddy and proxy to `127.0.0.1:8080`:
   ```nginx
   server {
     server_name ai-processor.formatika.dev;
     location / { proxy_pass http://127.0.0.1:8080; proxy_read_timeout 180s; }
   }
   ```
   `proxy_read_timeout` must stay ≥ 180s: `parseBankStatement` on a large PDF can take that long.
5. **Firewall** – allow 80/443 publicly; keep 8080 bound to localhost.
6. **Health check** – `curl https://ai-processor.formatika.dev/health`.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | yes | Model calls (`gpt-6-luna` by default) |
| `DEEPSEEK_API_KEY` | recommended | First fallback (`deepseek-flash`, thinking disabled) |
| `GROQ_API_KEY` | recommended | Second fallback (`openai/gpt-oss-20b`) |
| `MISTRAL_API_KEY` | for voice/OCR | `voxtral-mini-transcribe-3` / `mistral-ocr-latest` |
| `AI_DEFAULT_MODEL` | no | default `gpt-6-luna`; any id from `providers.ts` |
| `AI_REASONING_EFFORT` | no | `none` (default) / `minimal` / `low` / `medium` |
| `AI_REQUEST_TIMEOUT_MS` | no | default 90000 |
| `PORT` | no | default 8080 behind the proxy |

Model ids and prices live in `providers.ts`. Add a provider there and it is available to
every route — `chat.completions.create` is normalised (`max_tokens` → `max_completion_tokens`,
`reasoning_effort`, DeepSeek `thinking: disabled`) and retried on the fallback chain.

## Enabling it in the main app

```env
AI_PROCESSOR_ENABLED=true
AI_PROCESSOR_URL=https://ai-processor.formatika.dev
AI_PROCESSOR_TIMEOUT_MS=20000
AI_PROCESSOR_COOLDOWN_MS=300000
```

If the service is disabled, misconfigured, times out, or returns an error body, the app logs it, skips the processor for 5 minutes, and answers with the direct provider chain (`gpt-6-luna` → `deepseek-flash` → `openai/gpt-oss-20b`). Users never see a failure caused by this service being down.

## Known limitations

- The service duplicates the prompts that also live in `server/openai.ts`; keep them in sync or it will drift.
- Model IDs were updated to `gpt-6-luna` / `mistral-small-latest`; older deployments may still point at retired `mistral-small-2506`.
- It has no authentication of its own — do not expose `/execute-gpt-task` publicly without a reverse-proxy rule or shared secret, otherwise anyone can spend your OpenAI credit.

## Local test

```bash
npm install
npm start
curl http://localhost:3000/health
curl -X POST http://localhost:3000/execute-gpt-task \
  -H "Content-Type: application/json" \
  -d '{"task":"financial-tips","userId":"test","payload":{"totalIncome":2500,"totalExpenses":1850}}'
```
