# =============================================================================
# RuvVector Service Dockerfile
# SPARC Specification Compliant
#
# Technical Constraints:
# - Runtime: Node.js LTS (20.x)
# - State: Stateless - no local persistence beyond process memory
# - Deployment: Container-ready, single process
# - Startup time: < 5 seconds to healthy
# - Memory footprint: < 256MB baseline
# =============================================================================

# Build stage - use full node image for native dependencies (hnswlib-node requires Python)
FROM node:20 AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Prune dev dependencies for smaller image
RUN npm prune --production

# Production stage - use slim (Debian-based) for compatibility with native modules
FROM node:20-slim AS production

# SPARC: Container-ready, single process
WORKDIR /app

# Create non-root user for security
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs nodejs

# Copy built application and production dependencies from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Set ownership
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# SPARC: Environment-driven configuration
ENV NODE_ENV=production
ENV PORT=3000
ENV LOG_LEVEL=info

# SPARC: Default RuvVector connection
ENV RUVVECTOR_HOST=localhost
ENV RUVVECTOR_PORT=6379
ENV RUVVECTOR_TIMEOUT=30000
ENV RUVVECTOR_POOL_SIZE=10

# SPARC: Circuit breaker defaults
ENV CIRCUIT_BREAKER_THRESHOLD=5
ENV CIRCUIT_BREAKER_TIMEOUT=30000
ENV CIRCUIT_BREAKER_RESET=60000

# SPARC: Metrics defaults
ENV METRICS_ENABLED=true
ENV METRICS_PORT=9090

# SPARC: Graceful shutdown
ENV SHUTDOWN_TIMEOUT=30000

# Expose service port
EXPOSE 3000

# SPARC: Liveness probe - GET /health
# Startup time < 5 seconds per SPARC spec
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# SPARC: Single process deployment
CMD ["node", "dist/index.js"]
