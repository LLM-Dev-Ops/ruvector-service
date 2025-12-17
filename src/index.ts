import express, { Application, Request, Response, NextFunction } from 'express';
import { Server } from 'http';
import { config } from './config';
import logger from './utils/logger';
import {
  register,
  ruvvectorRequestsTotal,
  ruvvectorRequestDuration,
  ruvvectorCircuitBreakerState,
  ruvvectorActiveConnections
} from './utils/metrics';
import { VectorClient } from './clients/VectorClient';

// Middleware
import { validateRequiredHeaders, validateRequest, ingestSchema, querySchema, simulateSchema } from './middleware/validation';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

// Handlers
import { ingestHandler } from './handlers/ingest';
import { queryHandler } from './handlers/query';
import { simulateHandler } from './handlers/simulate';
import { healthHandler, readyHandler } from './handlers/health';

/**
 * Request metrics middleware - SPARC compliant
 */
function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  ruvvectorActiveConnections.inc();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const endpoint = req.path;
    const status = res.statusCode.toString();

    ruvvectorRequestDuration.observe({ endpoint }, duration);
    ruvvectorRequestsTotal.inc({ endpoint, status });
    ruvvectorActiveConnections.dec();
  });

  next();
}

/**
 * Initialize Express application with all middleware and routes
 * SPARC compliant: Three endpoints maximum
 */
function createApp(vectorClient: VectorClient): Application {
  const app = express();

  // Basic middleware
  app.use(express.json({ limit: '10mb' }));

  // Metrics middleware for all requests
  app.use(metricsMiddleware);

  // Health endpoints (no authentication required per SPARC)
  // SPARC: GET /health - Liveness probe
  app.get('/health', healthHandler);

  // SPARC: GET /ready - Readiness probe
  app.get('/ready', (req, res, next) => {
    readyHandler(req, res, vectorClient).catch(next);
  });

  // SPARC: GET /metrics - Prometheus metrics
  app.get('/metrics', async (_req, res) => {
    // Update circuit breaker state metric
    const circuitState = vectorClient.getCircuitState();
    ruvvectorCircuitBreakerState.set(circuitState === 'open' ? 1 : 0);

    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  // API endpoints (require x-correlation-id and x-entitlement-context headers)
  // SPARC: POST /ingest - Accept normalized events
  app.post(
    '/ingest',
    validateRequiredHeaders,
    validateRequest(ingestSchema),
    (req, res, next) => {
      ingestHandler(req, res, vectorClient).catch(next);
    }
  );

  // SPARC: POST /query - Retrieve events
  app.post(
    '/query',
    validateRequiredHeaders,
    validateRequest(querySchema),
    (req, res, next) => {
      queryHandler(req, res, vectorClient).catch(next);
    }
  );

  // SPARC: POST /simulate - Execute simulation queries
  app.post(
    '/simulate',
    validateRequiredHeaders,
    validateRequest(simulateSchema),
    (req, res, next) => {
      simulateHandler(req, res, vectorClient).catch(next);
    }
  );

  // Error handlers (must be last)
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Start the HTTP server
 * SPARC: Service listen port from PORT env var, default 3000
 */
async function startServer(): Promise<Server> {
  // Initialize VectorClient with SPARC-compliant config
  const vectorClient = new VectorClient({
    host: config.ruvVector.host,
    port: config.ruvVector.port,
    timeout: config.ruvVector.timeout,
    poolSize: config.ruvVector.poolSize,
    circuitBreaker: {
      threshold: config.circuitBreaker.threshold,
      timeout: config.circuitBreaker.timeout,
      resetTimeout: config.circuitBreaker.resetTimeout,
    },
  });

  // Create Express app
  const app = createApp(vectorClient);

  // Start HTTP server
  const server = app.listen(config.port, () => {
    const connectionInfo = vectorClient.getConnectionInfo();
    logger.info(
      {
        port: config.port,
        ruvvectorHost: connectionInfo.host,
        ruvvectorPort: connectionInfo.port,
        service: 'ruvvector-service',
      },
      'Server started successfully'
    );
  });

  // SPARC: Request timeout - Configurable, default 30s
  server.timeout = config.ruvVector.timeout;
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  return server;
}

/**
 * Graceful shutdown handler
 * SPARC: Drain connections within 30s
 */
function setupGracefulShutdown(server: Server): void {
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown');

    // Stop accepting new connections
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // SPARC: Graceful shutdown - Drain connections within 30s (configurable)
    const shutdownTimeout = setTimeout(() => {
      logger.error('Graceful shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, config.shutdown.timeout);

    try {
      await new Promise<void>((resolve) => {
        server.on('close', resolve);
      });

      clearTimeout(shutdownTimeout);
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error during graceful shutdown');
      clearTimeout(shutdownTimeout);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.fatal({ reason, promise }, 'Unhandled promise rejection');
    process.exit(1);
  });
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    logger.info(
      {
        service: 'ruvvector-service',
        logLevel: config.logLevel,
      },
      'Starting ruvvector-service'
    );

    const server = await startServer();
    setupGracefulShutdown(server);
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  main();
}

export { createApp, startServer };
