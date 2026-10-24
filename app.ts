import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import {
  authMiddleware,
  chatCompletionsHandler,
  corsOrigins,
  errorBody,
  healthDetailsHandler,
  healthHandler,
  rateLimitMiddleware,
} from './gateway';
import { registerLegacyRoutes } from './legacy';

/**
 * Builds the express app without listening, so tests can drive it directly.
 *
 *   GET  /health               open: { status, service, authConfigured }
 *   GET  /health/details       authenticated: providers, breakers, limits
 *   POST /v1/chat/completions  the gateway (any app, OpenAI-shaped)
 *   POST /execute-gpt-task ... deprecated Kaptia endpoints (see legacy.ts)
 *
 * Every route except `GET /health` sits behind the fail-closed API key check.
 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.GATEWAY_TRUST_PROXY === 'true') app.set('trust proxy', 1);

  // Server-to-server service: no CORS headers unless origins are listed explicitly.
  const origins = corsOrigins();
  if (origins.length > 0) {
    app.use(cors({ origin: origins }));
  }

  app.get('/health', healthHandler);
  app.use(authMiddleware);
  app.get('/health/details', healthDetailsHandler);

  app.post('/v1/chat/completions', rateLimitMiddleware, express.json({ limit: '5mb' }), chatCompletionsHandler);

  registerLegacyRoutes(app);

  app.use((_req: Request, res: Response) => {
    res.status(404).json(errorBody('Not found', 'invalid_request_error', 'not_found'));
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (error?.type === 'entity.too.large') {
      return res.status(400).json(errorBody('The request body is too large', 'invalid_request_error', 'request_too_large'));
    }
    if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
      return res.status(400).json(errorBody('The request body is not valid JSON', 'invalid_request_error', 'invalid_json'));
    }
    console.error('[gateway] unhandled error:', error?.message || error);
    return res.status(500).json(errorBody('Internal gateway error', 'server_error', 'internal_error'));
  });

  return app;
}

export const app = createApp();
