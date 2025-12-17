# ruvvector-service

A thin, stateless API service for RuvVector operations. This service provides a SPARC-compliant HTTP/JSON API for vector ingestion, querying, and similarity-based simulations.

## Features

- **Stateless Architecture**: No local persistence, all data forwarded to RuvVector backend
- **SPARC Compliance**: Follows SPARC specification for API contracts
- **TypeScript**: Full type safety and IntelliSense support
- **Observability**: Structured logging (Pino) and Prometheus metrics
- **Validation**: Request validation using Zod schemas
- **Container-Ready**: Single process, environment variable configuration
- **Graceful Shutdown**: Proper cleanup and connection draining

## API Endpoints

### Core Operations

- `POST /ingest` - Ingest a normalized event with vector embedding
- `POST /query` - Query vectors with optional similarity search and filters
- `POST /simulate` - Multi-vector similarity search for context-aware recommendations

### Health & Monitoring

- `GET /health` - Liveness probe
- `GET /ready` - Readiness probe with dependency checks
- `GET /metrics` - Prometheus metrics endpoint

## Prerequisites

- Node.js 20.x LTS or higher
- npm or yarn
- RuvVector backend service

## Installation

```bash
npm install
```

## Configuration

Copy the example environment file and configure:

```bash
cp .env.example .env
```

Edit `.env` with your configuration. See `.env.example` for all available options.

### Required Environment Variables

- `RUVVECTOR_BASE_URL` - URL of the RuvVector backend service
- `RUVVECTOR_API_KEY` - API key for RuvVector authentication

### Optional Environment Variables

See `.env.example` for a complete list of configuration options.

## Development

Start the development server with hot reload:

```bash
npm run dev
```

## Building

Compile TypeScript to JavaScript:

```bash
npm run build
```

## Running in Production

```bash
npm run build
npm start
```

## Testing

Run unit tests:

```bash
npm test
```

Run integration tests:

```bash
npm run test:integration
```

Run tests in watch mode:

```bash
npm run test:watch
```

## Linting

Run ESLint:

```bash
npm run lint
```

Fix linting issues automatically:

```bash
npm run lint:fix
```

## Type Checking

Run TypeScript type checking without building:

```bash
npm run type-check
```

## Project Structure

```
ruvvector-service/
├── src/
│   ├── index.ts              # Main entry point
│   ├── config/
│   │   └── index.ts          # Environment configuration
│   ├── middleware/
│   │   ├── errorHandler.ts   # Error handling middleware
│   │   ├── observability.ts  # Logging and metrics
│   │   └── validation.ts     # Request validation
│   ├── handlers/
│   │   ├── ingest.ts         # Ingest endpoint handler
│   │   ├── query.ts          # Query endpoint handler
│   │   ├── simulate.ts       # Simulate endpoint handler
│   │   └── health.ts         # Health check handlers
│   ├── clients/
│   │   └── VectorClient.ts   # RuvVector backend client
│   ├── utils/
│   │   ├── logger.ts         # Pino logger setup
│   │   ├── metrics.ts        # Prometheus metrics
│   │   ├── correlation.ts    # Correlation ID utilities
│   │   └── entitlement.ts    # Entitlement check stub
│   └── types/
│       └── index.ts          # TypeScript interfaces
├── tests/
│   ├── setup.ts              # Test configuration
│   ├── unit/                 # Unit tests
│   └── integration/          # Integration tests
├── .env.example              # Example environment variables
├── tsconfig.json             # TypeScript configuration
├── jest.config.js            # Jest unit test configuration
├── jest.integration.config.js # Jest integration test configuration
└── package.json              # Dependencies and scripts
```

## Docker

Build the Docker image:

```bash
docker build -t ruvvector-service .
```

Run the container:

```bash
docker run -p 3000:3000 --env-file .env ruvvector-service
```

## Metrics

Prometheus metrics are available at `/metrics`:

- `http_request_duration_seconds` - HTTP request duration histogram
- `http_requests_total` - Total HTTP requests counter
- `vector_operation_duration_seconds` - Vector operation duration histogram
- `vector_operations_total` - Total vector operations counter
- `vectors_processed_total` - Total vectors processed counter
- `entitlement_checks_total` - Total entitlement checks counter
- `errors_total` - Total errors counter
- `active_connections` - Active connections gauge

## Error Handling

All errors follow the SPARC error response format:

```json
{
  "error": "error_code",
  "message": "Human-readable error message",
  "correlationId": "uuid",
  "details": []
}
```

## License

ISC