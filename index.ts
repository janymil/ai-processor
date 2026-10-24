import 'dotenv/config';
import { createApp } from './app';

/** Bootstrap only. All behaviour lives in app.ts so tests can import it without listening. */
const app = createApp();
const port = parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';

if (!String(process.env.AI_PROCESSOR_API_KEY || '').trim()) {
  console.warn('[gateway] AI_PROCESSOR_API_KEY is not set: every route except GET /health will answer 503.');
}

app.listen(port, host, () => {
  console.log(`AI gateway listening on ${host}:${port}`);
});
