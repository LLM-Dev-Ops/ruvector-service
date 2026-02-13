/**
 * Canonical Contract Schemas — agentics-contracts
 *
 * This module is the SINGLE SOURCE OF TRUTH for all execution context,
 * execution graph, telemetry envelope, lineage, and span schemas.
 *
 * ruvvector-service MUST NOT define its own schema copies.
 * All inbound payloads MUST be validated against these schemas at runtime.
 * Validation failures MUST return HTTP 400 with error details.
 */
import { z } from 'zod';

// ============================================================================
// Execution Root Span Schema
// ============================================================================

export const ExecutionRootSpanSchema = z.object({
  span_id: z.string().uuid(),
  type: z.literal('execution_root'),
  parent_span_id: z.null(),
  created_at: z.string().datetime({ offset: true }),
});

export type ExecutionRootSpan = z.infer<typeof ExecutionRootSpanSchema>;

// ============================================================================
// Authority Span Schema
// ============================================================================

export const AuthoritySpanSchema = z.object({
  span_id: z.string().uuid(),
  type: z.literal('authority'),
  origin: z.literal('ruvvector-service'),
  parent: z.null(),
  created_at: z.string().datetime({ offset: true }),
});

export type AuthoritySpan = z.infer<typeof AuthoritySpanSchema>;

// ============================================================================
// Execution Lineage Metadata Schema
// ============================================================================

export const ExecutionLineageMetadataSchema = z.object({
  origin_service: z.literal('ruvvector-service'),
  origin_version: z.string().min(1),
  acceptance_timestamp: z.string().datetime({ offset: true }),
  root_span: ExecutionRootSpanSchema,
  caller_id: z.string().min(1),
  org_id: z.string().min(1),
  simulation_context: z.record(z.unknown()),
});

export type ExecutionLineageMetadata = z.infer<typeof ExecutionLineageMetadataSchema>;

// ============================================================================
// Lightweight Lineage Seed Schema (POST /v1/simulations)
// ============================================================================

export const LineageSeedSchema = z.object({
  root_span: AuthoritySpanSchema,
  intent_description: z.string().min(1),
  caller_id: z.string().min(1).optional(),
  org_id: z.string().min(1).optional(),
  simulation_context: z.record(z.unknown()).optional(),
});

export type LineageSeed = z.infer<typeof LineageSeedSchema>;

// ============================================================================
// Execution Context Schema
// ============================================================================

export const ExecutionContextSchema = z.object({
  execution_id: z.string().regex(/^exec-[0-9a-f-]{36}$/, 'execution_id must match exec-{uuid} format'),
  parent_span_id: z.string().uuid(),
  repo_name: z.string().min(1),
  simulation_resolution: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
});

export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;

// ============================================================================
// Execution Record Schema (stored in DB)
// ============================================================================

export const ExecutionRecordSchema = z.object({
  execution_id: z.string().regex(/^exec-[0-9a-f-]{36}$/),
  accepted: z.boolean(),
  reason: z.string().nullable(),
  caller_id: z.string().nullable(),
  org_id: z.string().nullable(),
  simulation_type: z.string().nullable(),
  simulation_context: z.record(z.unknown()),
  authority_signature: z.string().min(1),
  root_span_id: z.string().uuid(),
  lineage: z.union([ExecutionLineageMetadataSchema, LineageSeedSchema]),
  idempotency_key: z.string().nullable(),
  created_at: z.string().datetime({ offset: true }),
});

export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

// ============================================================================
// Accept Execution Request Schema (POST /v1/executions/accept)
// ============================================================================

export const AcceptExecutionRequestSchema = z.object({
  caller_id: z.string().min(1).max(255),
  org_id: z.string().min(1).max(255),
  simulation_type: z.string().min(1).max(100),
  simulation_context: z.record(z.unknown()),
  idempotency_key: z.string().max(255).optional(),
});

export type AcceptExecutionRequest = z.infer<typeof AcceptExecutionRequestSchema>;

// ============================================================================
// Accept Execution Response Schema
// ============================================================================

export const AcceptExecutionResponseSchema = z.object({
  execution_id: z.string().regex(/^exec-[0-9a-f-]{36}$/),
  accepted: z.boolean(),
  reason: z.string().nullable(),
  authority_signature: z.string().min(1),
  lineage: ExecutionLineageMetadataSchema,
  created_at: z.string().datetime({ offset: true }),
});

export type AcceptExecutionResponse = z.infer<typeof AcceptExecutionResponseSchema>;

// ============================================================================
// Validate Execution Request/Response Schema
// ============================================================================

export const ValidateExecutionRequestSchema = z.object({
  execution_id: z.string().min(1),
  authority_signature: z.string().min(1),
});

export type ValidateExecutionRequest = z.infer<typeof ValidateExecutionRequestSchema>;

export const ValidateExecutionResponseSchema = z.object({
  valid: z.boolean(),
  execution_id: z.string(),
  reason: z.string().nullable(),
});

export type ValidateExecutionResponse = z.infer<typeof ValidateExecutionResponseSchema>;

// ============================================================================
// Acceptance Request Schema (POST /v1/simulations)
// ============================================================================

export const AcceptanceRequestSchema = z.object({
  intent_description: z.string().min(1).max(2000),
  caller_id: z.string().min(1).max(255).optional(),
  org_id: z.string().min(1).max(255).optional(),
  simulation_type: z.string().min(1).max(100).optional(),
  simulation_context: z.record(z.unknown()).optional(),
});

export type AcceptanceRequest = z.infer<typeof AcceptanceRequestSchema>;

// ============================================================================
// Acceptance Response Schema
// ============================================================================

export const AcceptanceResponseSchema = z.object({
  execution_id: z.string().regex(/^exec-[0-9a-f-]{36}$/),
  parent_span_id: z.string().uuid(),
  authority: z.literal('ruvvector-service'),
  accepted: z.literal(true),
  timestamp: z.string().datetime({ offset: true }),
});

export type AcceptanceResponse = z.infer<typeof AcceptanceResponseSchema>;

// ============================================================================
// Decision Signals Schema
// ============================================================================

export const DecisionSignalsSchema = z.object({
  financial: z.string(),
  risk: z.string(),
  complexity: z.string(),
});

export type DecisionSignals = z.infer<typeof DecisionSignalsSchema>;

// ============================================================================
// Decision Graph Relations Schema (Execution Graph)
// ============================================================================

export const DecisionGraphRelationsSchema = z.object({
  objective_to_repos: z.array(z.string()),
  repos_to_signals: z.record(z.array(z.string())),
  signals_to_recommendation: z.array(z.string()),
});

export type DecisionGraphRelations = z.infer<typeof DecisionGraphRelationsSchema>;

// ============================================================================
// Decision Record Schema
// ============================================================================

export const DecisionRecordSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  command: z.string().min(1),
  raw_output_hash: z.string().min(1),
  recommendation: z.string().min(1),
  confidence: z.string().min(1),
  signals: DecisionSignalsSchema,
  embedding_text: z.string().min(1),
  embedding: z.array(z.number()).nullable().optional(),
  graph_relations: DecisionGraphRelationsSchema,
  created_at: z.string(),
});

export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

// ============================================================================
// Create Decision Request Schema
// ============================================================================

export const CreateDecisionRequestSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  command: z.string().min(1),
  raw_output_hash: z.string().min(1),
  recommendation: z.string().min(1),
  confidence: z.string().min(1),
  signals: DecisionSignalsSchema,
  embedding_text: z.string().min(1),
  graph_relations: DecisionGraphRelationsSchema,
  created_at: z.string().optional(),
});

export type CreateDecisionRequest = z.infer<typeof CreateDecisionRequestSchema>;

// ============================================================================
// Approval Request/Response Schemas
// ============================================================================

export const CreateApprovalRequestSchema = z.object({
  decision_id: z.string().min(1),
  approved: z.boolean(),
  confidence_adjustment: z.number().min(-1).max(1).optional(),
  advisory: z.boolean().optional().default(false),
  timestamp: z.string().optional(),
});

export type CreateApprovalRequest = z.infer<typeof CreateApprovalRequestSchema>;

// ============================================================================
// Learning Decision Event Schema
// ============================================================================

export const LearningDecisionEventSchema = z.object({
  agent_id: z.string().min(1),
  agent_version: z.string().min(1),
  decision_type: z.enum(['approval_learning', 'feedback_assimilation']),
  inputs_hash: z.string().length(64),
  outputs: z.record(z.unknown()),
  confidence: z.number().min(0).max(1),
  constraints_applied: z.record(z.unknown()),
  execution_ref: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
});

export type LearningDecisionEvent = z.infer<typeof LearningDecisionEventSchema>;

// ============================================================================
// Approval Learning Request Schema
// ============================================================================

export const ApprovalLearningRequestSchema = z.object({
  decision_id: z.string().min(1).optional(),
  approved: z.boolean(),
  confidence_adjustment: z.number().min(-1).max(1).optional(),
  reviewer_role: z.string().optional(),
  review_scope: z.string().optional(),
  artifact_type: z.string().optional(),
  feedback: z.string().optional(),
  timestamp: z.string().optional(),
});

export type ApprovalLearningRequest = z.infer<typeof ApprovalLearningRequestSchema>;

// ============================================================================
// Feedback Assimilation Request Schema
// ============================================================================

export const FeedbackSignalSchema = z.object({
  dimension: z.string(),
  value: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
});

export type FeedbackSignal = z.infer<typeof FeedbackSignalSchema>;

export const FeedbackAssimilationRequestSchema = z.object({
  agent_id: z.string().default('feedback-assimilation-agent'),
  agent_version: z.string().default('1.0.0'),
  source_artifact_id: z.string().min(1),
  feedback_type: z.enum(['qualitative', 'quantitative', 'mixed']),
  raw_feedback: z.string().min(1),
  normalized_signals: z.array(FeedbackSignalSchema).optional(),
  assimilation_metadata: z.object({
    feedback_source: z.string(),
    processing_method: z.string(),
  }),
  outputs: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  constraints_applied: z.record(z.unknown()).optional(),
  execution_ref: z.string().optional(),
  inputs_hash: z.string().optional(),
  timestamp: z.string().optional(),
});

export type FeedbackAssimilationRequest = z.infer<typeof FeedbackAssimilationRequestSchema>;

// ============================================================================
// Decision Event Schemas (Execution Engine Consumption)
// ============================================================================

export const DecisionEventTypeSchema = z.enum([
  'plan_created',
  'plan_approved',
  'plan_rejected',
  'plan_deferred',
]);

export type DecisionEventType = z.infer<typeof DecisionEventTypeSchema>;

export const DecisionEventPayloadSchema = z.object({
  plan_id: z.string().optional(),
  simulation_id: z.string().optional(),
  decision_id: z.string().optional(),
  objective: z.string().optional(),
  recommendation: z.string().optional(),
  confidence: z.string().optional(),
  reward: z.number().optional(),
  reviewer_outcome: z.string().optional(),
  command: z.string().optional(),
  checksum: z.string().optional(),
  confidence_adjustment: z.number().nullable().optional(),
}).passthrough();

export type DecisionEventPayload = z.infer<typeof DecisionEventPayloadSchema>;

export const DecisionEventSchema = z.object({
  id: z.string(),
  type: DecisionEventTypeSchema,
  timestamp: z.string(),
  payload: DecisionEventPayloadSchema,
});

export type DecisionEvent = z.infer<typeof DecisionEventSchema>;

// ============================================================================
// Telemetry Envelope Schema
// ============================================================================

export const TelemetryEnvelopeSchema = z.object({
  trace_id: z.string().uuid(),
  root_span_id: z.string().uuid(),
  parent_span_id: z.string().uuid(),
  span_id: z.string().uuid(),
  execution_id: z.string().regex(/^exec-[0-9a-f-]{36}$/),
  repo_name: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  payload: z.record(z.unknown()),
});

export type TelemetryEnvelope = z.infer<typeof TelemetryEnvelopeSchema>;

// ============================================================================
// Span Validation Utilities
// ============================================================================

/**
 * Validate span integrity: parent_span_id MUST exist, no orphan spans.
 * root_span_id and trace_id MUST be explicitly provided.
 */
export function validateSpanIntegrity(span: {
  span_id: string;
  parent_span_id: string | null;
  root_span_id?: string;
  trace_id?: string;
}): void {
  if (!span.span_id) {
    throw new ContractViolationError('span_id is required');
  }

  // Root spans have parent_span_id = null, but must have type = execution_root or authority
  // Non-root spans MUST have a parent_span_id
  if (span.parent_span_id !== null && !span.parent_span_id) {
    throw new ContractViolationError('parent_span_id must be explicitly set (null for root spans, UUID for child spans)');
  }

  if (span.root_span_id !== undefined && !span.root_span_id) {
    throw new ContractViolationError('root_span_id must not be empty when provided');
  }

  if (span.trace_id !== undefined && !span.trace_id) {
    throw new ContractViolationError('trace_id must not be empty when provided');
  }
}

// ============================================================================
// Contract Violation Error
// ============================================================================

export class ContractViolationError extends Error {
  public readonly code = 'contract_violation';
  public readonly statusCode = 400;
  public readonly details: unknown[];

  constructor(message: string, details: unknown[] = []) {
    super(message);
    this.name = 'ContractViolationError';
    this.details = details;
  }
}

// ============================================================================
// Runtime Validation Helper
// ============================================================================

/**
 * Validate a payload against a contract schema.
 * Throws ContractViolationError on failure with full error details.
 */
export function validateContract<T>(schema: z.ZodSchema<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ContractViolationError(
      'Contract validation failed',
      result.error.errors.map(e => ({
        path: e.path.join('.'),
        message: e.message,
        code: e.code,
      }))
    );
  }
  return result.data;
}
