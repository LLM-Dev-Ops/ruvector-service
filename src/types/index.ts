/**
 * TypeScript interfaces for ruvvector-service
 * Based on SPARC specification
 */

// ============================================================================
// Normalized Event Structure
// ============================================================================

export interface NormalizedEvent {
  eventId: string;          // UUID, caller-generated
  correlationId: string;    // UUID, for request tracing
  timestamp: string;        // ISO 8601 UTC
  vector: number[];         // Embedding vector
  payload: object;          // Arbitrary JSON
  metadata: {
    source: string;         // Originating system identifier
    type: string;           // Event type classification
    version: string;        // Schema version
  };
}

// ============================================================================
// Ingest Endpoint Interfaces
// ============================================================================

export interface IngestRequest extends NormalizedEvent {}

export interface IngestResponse {
  eventId: string;
  vectorId: string;
  status: 'stored';
  timestamp: string;
  metadata: {
    correlationId: string;
    processingTime: number;  // Milliseconds
  };
}

// ============================================================================
// Query Endpoint Interfaces
// ============================================================================

export interface QueryRequest {
  queryVector?: number[] | null;  // Optional, for similarity search
  filters?: {
    source?: string | string[];
    type?: string | string[];
    metadata?: object;              // Key-value filters
  };
  timeRange?: {
    start: string;                  // ISO 8601
    end: string;                    // ISO 8601
  };
  limit?: number;                   // Optional, default 100, max 1000
  offset?: number;                  // Optional, default 0
}

export interface QueryResult {
  eventId: string;
  similarity: number | null;        // Present if queryVector provided
  timestamp: string;
  payload: object;
  metadata: object;
}

export interface QueryResponse {
  results: QueryResult[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  metadata: {
    correlationId: string;
    queryTime: number;              // Milliseconds
  };
}

// ============================================================================
// Simulate Endpoint Interfaces
// ============================================================================

export interface SimulateRequest {
  contextVectors: number[][];       // Required, 1 or more context vectors
  nearestNeighbors?: number;        // Optional, default 10, max 100
  similarityThreshold?: number;     // Optional, default 0.0, range [0, 1]
  includeMetadata?: boolean;        // Optional, default true
  includeVectors?: boolean;         // Optional, default false
}

export interface SimulateNeighbor {
  eventId: string;
  similarity: number;
  vector?: number[] | null;         // Present if includeVectors true
  payload: object;
  metadata?: object | null;         // Present if includeMetadata true
}

export interface SimulateResult {
  contextIndex: number;             // Index of input context vector
  neighbors: SimulateNeighbor[];
}

export interface SimulateResponse {
  results: SimulateResult[];
  execution: {
    vectorsProcessed: number;
    executionTime: number;          // Milliseconds
    correlationId: string;
  };
}

// ============================================================================
// Error Response Interface
// ============================================================================

export interface ErrorResponse {
  error: string;                    // Error code (snake_case)
  message: string;                  // Human-readable message
  correlationId: string;            // Request correlation ID
  details?: any[];                  // Optional additional details
}

// ============================================================================
// Health and Readiness Interfaces
// ============================================================================

export interface HealthResponse {
  status: 'healthy';
  timestamp: string;
}

export interface ReadyResponse {
  status: 'ready' | 'not ready';
  dependencies: {
    ruvvector: 'connected' | 'disconnected';
  };
  timestamp?: string;
}

// ============================================================================
// Entitlement Context Interface
// ============================================================================

export interface EntitlementContext {
  tenant: string;                   // Required
  scope: string;                    // Required
  tier?: string;                    // Optional, not enforced
  limits?: object;                  // Optional, not enforced
}

// ============================================================================
// VectorClient Operation Interfaces
// ============================================================================

export interface VectorInsertParams {
  id: string;
  vector: number[];
  payload: object;
  metadata: object;
}

export interface VectorInsertResult {
  id: string;
}

export interface VectorQueryParams {
  vector?: number[];                // Optional similarity search
  filters?: object;                 // Metadata filters
  timeRange?: {
    start: string;
    end: string;
  };
  limit: number;
  offset: number;
}

export interface VectorQueryResult {
  items: Array<{
    id: string;
    score?: number;
    vector?: number[];
    payload: object;
    metadata: object;
  }>;
  total: number;
  executionTime: number;            // Milliseconds
}

export interface VectorSimilarityParams {
  contextVectors: number[][];
  k: number;                        // Number of nearest neighbors
  threshold: number;                // Similarity threshold [0, 1]
  includeMetadata: boolean;
}

export interface VectorSimilarityResult {
  neighbors: Array<{
    id: string;
    score: number;
    vector?: number[];
    payload: object;
    metadata?: object;
  }>;
  processed: number;                // Number of vectors processed
  executionTime: number;            // Milliseconds
}

// ============================================================================
// Prediction Operation Interfaces (Layer 3 Contract)
// ============================================================================

export interface PredictionParams {
  model: string;                    // Model identifier
  input: number[] | object;         // Vector or structured input
}

export interface PredictionResult {
  model: string;                    // Model used
  output: object;                   // Model output (structure depends on model)
  confidence: number;               // Confidence score [0, 1]
  executionTime: number;            // Milliseconds
}

// ============================================================================
// Plans Storage Interfaces (Cloud Run API)
// ============================================================================

export interface RuvectorPlan {
  id: string;                       // UUID from planner
  type: 'plan';
  intent: string;                   // Original user intent/query
  plan: object;                     // Full plan JSON from planner
  created_at: string;               // ISO timestamp
  org_id: string;                   // Organization ID
  user_id: string;                  // User ID
  checksum: string;                 // SHA-256 of plan content
}

export interface CreatePlanRequest {
  id: string;
  intent: string;
  plan: object;
  org_id: string;
  user_id: string;
  checksum: string;
}

export interface CreatePlanResponse {
  success: boolean;
  id: string;
}

export interface ListPlansResponse {
  plans: RuvectorPlan[];
}

export interface DeletePlanResponse {
  success: boolean;
}
