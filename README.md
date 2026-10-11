<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20_LTS-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 20 LTS" />
  <img src="https://img.shields.io/badge/TypeScript-5.3-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Express-4.18-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/Cloud_Run-Deployed-4285F4?style=for-the-badge&logo=google-cloud&logoColor=white" alt="Cloud Run" />
</p>

<h1 align="center">🛡️ Ruvector Service</h1>

<p align="center">
  <strong>Enterprise-grade decision engine &amp; vector operations API</strong><br/>
  <em>Stateless · SPARC-compliant · Production-hardened</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-ISC-blue?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/coverage-70%25_minimum-brightgreen?style=flat-square" alt="Coverage gate: 70% minimum" />
  <img src="https://img.shields.io/badge/status-production-success?style=flat-square" alt="Status" />
</p>

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Ruvector Service                          │
│                                                                  │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌────────────────┐  │
│  │ Ingest  │  │  Query   │  │ Simulate  │  │   Decisions    │  │
│  │ Handler │  │ Handler  │  │  Handler  │  │  & Approvals   │  │
│  └────┬────┘  └────┬─────┘  └─────┬─────┘  └───────┬────────┘  │
│       │            │              │                  │           │
│  ┌────▼────────────▼──────────────▼──────────────────▼────────┐ │
│  │              Middleware Layer                               │ │
│  │  Validation · Correlation · Metrics · Latency Budget       │ │
│  └────┬───────────────────────────────────────────────┬───────┘ │
│       │                                               │         │
│  ┌────▼─────────┐                          ┌──────────▼───────┐ │
│  │ VectorClient │                          │  DatabaseClient  │ │
│  │  (RuvVector) │                          │   (PostgreSQL)   │ │
│  └──────────────┘                          └──────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

---

## ✨ Features

| | Feature | Description |
|---|---|---|
| 🔒 | **Execution Authority** | HMAC-SHA256 signed execution IDs — Ruvector is the sole minting authority |
| 📊 | **Decision Events** | Real-time decision event polling & ingestion for orchestration engines |
| 🧠 | **Learning Signals** | Approval learning and feedback assimilation agents with latency budgets |
| ⚡ | **Circuit Breaker** | Automatic failure isolation with configurable thresholds and recovery |
| 📈 | **Prometheus Metrics** | Full observability with request duration, throughput, and pool gauges |
| 🔄 | **Graceful Shutdown** | Connection draining within configurable timeout on SIGTERM/SIGINT |
| 🛡️ | **Startup Hardening** | 4-phase boot: env assertions → DB init → storage health → data integrity |
| 🐳 | **Cloud Run Ready** | Stateless, single-process, <256 MB baseline, 8080 health-checked |

---

## 📡 API Reference

### Health & Monitoring

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | 🟢 Liveness probe with database connectivity check |
| `GET` | `/ready` | 🟢 Readiness probe with VectorClient dependency check |
| `GET` | `/metrics` | 📈 Prometheus metrics (requests, latency, connections, circuit state) |
| `GET` | `/metadata` | 📋 Service metadata and capability discovery |

### Plans API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/plans` | Create a new plan |
| `GET` | `/v1/plans` | List plans (filterable by `org_id`) |
| `GET` | `/v1/plans/:id` | Retrieve a plan by ID |
| `DELETE` | `/v1/plans/:id` | Delete a plan |

### Deployments API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/deployments` | Create a deployment record |
| `GET` | `/v1/deployments` | List deployments (filter by environment, status) |
| `GET` | `/v1/deployments/:id` | Retrieve a deployment by ID |
| `PUT` | `/v1/deployments/:id` | Update a deployment |
| `DELETE` | `/v1/deployments/:id` | Delete a deployment |

### Decisions & Approvals API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/decisions` | Store a new decision record |
| `GET` | `/v1/decisions` | List decisions |
| `GET` | `/v1/decisions/:id` | Retrieve a decision by ID |
| `POST` | `/decision/approval` | Process approval event and apply learning |

### Execution Authority API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/executions/accept` | 🔐 Synchronous execution acceptance (canonical mint) |
| `GET` | `/v1/executions/:id` | Retrieve an execution record |
| `GET` | `/v1/executions` | List executions |
| `POST` | `/v1/executions/validate` | Validate execution ID + authority signature |

### Simulations API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/simulations` | Accept simulation intent and mint execution authority |

### Decision Events API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/events/decisions` | 📡 Poll decision events (cursor-based, supports `types`, `after`, `limit`) |
| `POST` | `/events/decisions` | 📥 Ingest decision events from orchestration |

### Learning Signals API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/learning/learn` | Approval learning agent (latency-budgeted) |
| `POST` | `/learning/assimilate` | Feedback assimilation agent (latency-budgeted) |
| `GET` | `/learning/inspect` | Inspect learning events (read-only) |

### Legacy Vector Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/ingest` | Ingest a normalized event with vector embedding |
| `POST` | `/query` | Query vectors with similarity search and filters |
| `POST` | `/simulate` | Multi-vector similarity search for recommendations |
| `POST` | `/graph` | Graph operations |
| `POST` | `/predict` | Run ML predictions |

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 20.x LTS or higher
- **PostgreSQL** 16+
- **RuvVector** backend service

### Install

```bash
npm install
```

### Configure

```bash
cp .env.example .env
# Edit .env with your configuration
```

### Run (Development)

```bash
npm run dev
```

### Run (Production)

```bash
npm run build
npm start
```

---

## ⚙️ Configuration

All configuration is via environment variables. No `.env` files in production.

### Required

| Variable | Description |
|----------|-------------|
| `EXECUTION_HMAC_SECRET` | 🔐 HMAC-SHA256 signing secret for execution authority |
| `RUVVECTOR_DB_PASSWORD` | PostgreSQL password |

### Database (PostgreSQL)

| Variable | Default | Description |
|----------|---------|-------------|
| `RUVVECTOR_DB_HOST` | `localhost` | Database hostname |
| `RUVVECTOR_DB_PORT` | `5432` | Database port |
| `RUVVECTOR_DB_NAME` | `ruvector-postgres` | Database name |
| `RUVVECTOR_DB_USER` | `postgres` | Database user |
| `RUVVECTOR_DB_PASSWORD` | — | Database password |
| `RUVVECTOR_DB_MAX_CONNECTIONS` | `20` | Connection pool size |
| `RUVVECTOR_DB_IDLE_TIMEOUT` | `30000` | Idle timeout (ms) |
| `RUVVECTOR_DB_CONNECTION_TIMEOUT` | `10000` | Connection timeout (ms) |
| `RUVVECTOR_DB_SSL` | `false` | Enable SSL |

### RuvVector Backend

| Variable | Default | Description |
|----------|---------|-------------|
| `RUVVECTOR_SERVICE_URL` | `http://localhost:6379` | RuvVector service URL |
| `RUVVECTOR_API_KEY` | — | API key (optional) |
| `RUVVECTOR_TIMEOUT` | `30000` | Request timeout (ms) |
| `RUVVECTOR_POOL_SIZE` | `10` | Connection pool size |

### Circuit Breaker

| Variable | Default | Description |
|----------|---------|-------------|
| `CIRCUIT_BREAKER_THRESHOLD` | `5` | Failures before opening |
| `CIRCUIT_BREAKER_TIMEOUT` | `30000` | Open state duration (ms) |
| `CIRCUIT_BREAKER_RESET` | `60000` | Full reset timeout (ms) |

### Service

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error, fatal) |
| `SHUTDOWN_TIMEOUT` | `30000` | Graceful shutdown timeout (ms) |
| `MAX_LATENCY_MS` | `2000` | Learning endpoint latency budget (ms) |
| `METRICS_ENABLED` | `true` | Enable Prometheus metrics |
| `METRICS_PORT` | `9090` | Metrics port |

---

## 🐳 Docker

```bash
# Build
docker build -t ruvector-service .

# Run
docker run -p 8080:8080 --env-file .env ruvector-service
```

---

## ☁️ Deploy to Cloud Run

```bash
gcloud run deploy ruvector-service \
  --source=. \
  --region=us-central1 \
  --port=8080 \
  --memory=256Mi \
  --cpu=1 \
  --max-instances=10 \
  --set-env-vars="NODE_ENV=production,LOG_LEVEL=info,MAX_LATENCY_MS=2000,RUVVECTOR_DB_SSL=true" \
  --set-secrets="RUVVECTOR_DB_HOST=RUVECTOR_DB_HOST:latest,RUVVECTOR_DB_PORT=RUVECTOR_DB_PORT:latest,RUVVECTOR_DB_NAME=RUVECTOR_DB_NAME:latest,RUVVECTOR_DB_USER=RUVECTOR_DB_USER:latest,RUVVECTOR_DB_PASSWORD=RUVECTOR_DB_PASSWORD:latest,EXECUTION_HMAC_SECRET=EXECUTION_HMAC_SECRET:latest" \
  --add-cloudsql-instances=agentics-dev:us-central1:ruvector-postgres \
  --allow-unauthenticated
```

---

## 🧪 Testing

```bash
# Unit tests
npm test

# Integration tests
npm run test:integration

# Watch mode
npm run test:watch
```

---

## 📊 Prometheus Metrics

Available at `GET /metrics`:

| Metric | Type | Description |
|--------|------|-------------|
| `http_request_duration_seconds` | Histogram | Request latency by endpoint |
| `http_requests_total` | Counter | Total requests by endpoint and status |
| `active_connections` | Gauge | Current active connections |
| `vector_operation_duration_seconds` | Histogram | Vector operation latency |
| `vector_operations_total` | Counter | Total vector operations |

---

## 🗂️ Project Structure

```
ruvector-service/
├── src/
│   ├── index.ts                # 🚀 Application entry point & route registration
│   ├── config/
│   │   └── index.ts            # ⚙️ Environment variable configuration
│   ├── handlers/
│   │   ├── health.ts           # Health & readiness probes
│   │   ├── ingest.ts           # Vector ingestion
│   │   ├── query.ts            # Vector querying
│   │   ├── simulate.ts         # Similarity simulations
│   │   ├── plans.ts            # Plans CRUD
│   │   ├── deployments.ts      # Deployments CRUD
│   │   ├── decisions.ts        # Decisions API
│   │   ├── approvals.ts        # Approval processing
│   │   ├── executions.ts       # Execution authority minting
│   │   ├── simulations.ts      # Simulation intent acceptance
│   │   ├── decisionEvents.ts   # Decision event polling & ingestion
│   │   └── learning.ts         # Learning signal agents
│   ├── clients/
│   │   ├── VectorClient.ts     # RuvVector backend client
│   │   └── DatabaseClient.ts   # PostgreSQL connection pool
│   ├── middleware/
│   │   ├── validation.ts       # Zod request validation
│   │   ├── errorHandler.ts     # Error handling
│   │   └── latencyBudget.ts    # Learning endpoint latency enforcement
│   ├── guards/
│   │   └── immutability.ts     # Historical data integrity checks
│   ├── startup.ts              # Startup hardening assertions
│   └── utils/
│       ├── logger.ts           # Pino structured logging
│       ├── metrics.ts          # Prometheus metric definitions
│       └── correlation.ts      # Correlation ID utilities
├── tests/
│   ├── unit/                   # Unit tests
│   └── integration/            # Integration tests
├── scripts/
│   ├── deploy.sh               # Deployment script (ruv-cloud)
│   └── deploy-cloudrun.sh      # Deployment script (agentics-dev)
├── Dockerfile                  # Multi-stage production build
├── cloudbuild.yaml             # Google Cloud Build pipeline
├── tsconfig.json               # TypeScript configuration
├── jest.config.js              # Jest test configuration
├── .env.example                # Environment variable reference
└── package.json                # Dependencies and scripts
```

---

## 🚨 Error Response Format

All errors follow a consistent SPARC-compliant structure:

```json
{
  "error": "error_code",
  "message": "Human-readable error message",
  "correlationId": "uuid",
  "details": []
}
```

---

## 📄 License

ISC
