/**
 * DecisionEvent Signal Types - Memory Layer Hardening
 *
 * DECISIONEVENT RULES:
 * Emit ONLY:
 * - learning_update_signal
 * - feedback_assimilation_signal
 *
 * These are the ONLY valid signal types for the memory layer.
 * Any other signal type is a violation of memory layer constraints.
 */

/**
 * Valid DecisionEvent signal types.
 * Memory layer may ONLY emit these signal types.
 */
export const VALID_SIGNAL_TYPES = [
  'learning_update_signal',
  'feedback_assimilation_signal',
] as const;

export type ValidSignalType = typeof VALID_SIGNAL_TYPES[number];

/**
 * Map agent decision types to valid signal types.
 */
export const DECISION_TYPE_TO_SIGNAL: Record<string, ValidSignalType> = {
  approval_learning: 'learning_update_signal',
  feedback_assimilation: 'feedback_assimilation_signal',
};

/**
 * Assert that a signal type is valid for the memory layer.
 *
 * @param signalType - Signal type to validate
 * @throws Error if signal type is not valid
 */
export function assertValidSignalType(signalType: string): asserts signalType is ValidSignalType {
  if (!VALID_SIGNAL_TYPES.includes(signalType as ValidSignalType)) {
    throw new Error(
      `MEMORY LAYER VIOLATION: Invalid signal type '${signalType}'. ` +
      `Memory layer may ONLY emit: ${VALID_SIGNAL_TYPES.join(', ')}`
    );
  }
}

/**
 * Get the signal type for a decision type.
 *
 * @param decisionType - Decision type (e.g., 'approval_learning')
 * @returns Corresponding signal type
 * @throws Error if decision type has no mapped signal
 */
export function getSignalTypeForDecision(decisionType: string): ValidSignalType {
  const signalType = DECISION_TYPE_TO_SIGNAL[decisionType];
  if (!signalType) {
    throw new Error(
      `MEMORY LAYER VIOLATION: Decision type '${decisionType}' has no valid signal mapping. ` +
      `Valid decision types: ${Object.keys(DECISION_TYPE_TO_SIGNAL).join(', ')}`
    );
  }
  return signalType;
}

/**
 * Validate that an event emission is compliant with memory layer rules.
 *
 * @param event - Event to validate
 * @returns true if valid
 * @throws Error if event violates memory layer constraints
 */
export function validateEventEmission(event: {
  decision_type: string;
  source_type?: string;
}): boolean {
  // Validate decision type has valid signal mapping
  getSignalTypeForDecision(event.decision_type);

  // Validate source_type if present
  if (event.source_type) {
    const validSourceTypes = ['approval_learning', 'feedback_assimilation'];
    if (!validSourceTypes.includes(event.source_type)) {
      throw new Error(
        `MEMORY LAYER VIOLATION: Invalid source_type '${event.source_type}'. ` +
        `Valid source types: ${validSourceTypes.join(', ')}`
      );
    }
  }

  return true;
}

export default {
  VALID_SIGNAL_TYPES,
  DECISION_TYPE_TO_SIGNAL,
  assertValidSignalType,
  getSignalTypeForDecision,
  validateEventEmission,
};
