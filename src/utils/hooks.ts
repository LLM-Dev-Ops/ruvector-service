/**
 * Post-execution hooks for fan-out to core bundles.
 * All calls are non-blocking (fire-and-forget via Promise.allSettled).
 * Forwards X-Correlation-ID from execution_metadata.trace_id.
 */
import logger from './logger';

const HOOK_TIMEOUT_MS = 5000;

interface HookTarget {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Fire non-blocking POST calls to multiple targets.
 * Uses Promise.allSettled so failures in one target don't affect others.
 */
function fireHooks(targets: HookTarget[], correlationId: string): void {
  Promise.allSettled(
    targets.map(async ({ url, body }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HOOK_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-ID': correlationId,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          logger.warn(
            { correlationId, hookUrl: url, status: res.status },
            'Hook target returned non-OK status'
          );
        } else {
          logger.info({ correlationId, hookUrl: url }, 'Hook delivered successfully');
        }
      } catch (err) {
        logger.warn(
          { correlationId, hookUrl: url, error: (err as Error).message },
          'Hook delivery failed'
        );
      } finally {
        clearTimeout(timeout);
      }
    })
  ).catch((err) => {
    // Should never happen with allSettled, but guard defensively
    logger.error({ correlationId, error: (err as Error).message }, 'Unexpected hook fan-out error');
  });
}

// ---------------------------------------------------------------------------
// Core bundle base URLs
// ---------------------------------------------------------------------------
const DATA_CORE = 'https://data-core-1062287243982.us-central1.run.app';
const GOVERNANCE_CORE = 'https://governance-core-1062287243982.us-central1.run.app';
const INTELLIGENCE_CORE = 'https://intelligence-core-1062287243982.us-central1.run.app';
const AUTOMATION_CORE = 'https://automation-core-1062287243982.us-central1.run.app';
const SECURITY_CORE = 'https://security-core-1062287243982.us-central1.run.app';

// ---------------------------------------------------------------------------
// Plan hooks
// ---------------------------------------------------------------------------

interface PlanHookPayload {
  plan_id: string;
  intent: string;
  org_id: string;
  checksum: string;
}

/**
 * Fire post-store hooks for plan creation/upsert.
 * Called after successful DB write; non-blocking.
 */
export function firePlanStoredHooks(payload: PlanHookPayload, correlationId: string): void {
  const timestamp = new Date().toISOString();
  const base = { source: 'ruvvector-service' as const, event: 'plan_stored' as const, timestamp };

  fireHooks(
    [
      {
        url: `${DATA_CORE}/v1/lineage/record`,
        body: { ...base, ...payload },
      },
      {
        url: `${GOVERNANCE_CORE}/v1/policy/evaluate`,
        body: {
          ...base,
          plan_id: payload.plan_id,
          intent: payload.intent,
          org_id: payload.org_id,
        },
      },
    ],
    correlationId
  );
}

// ---------------------------------------------------------------------------
// Deployment hooks
// ---------------------------------------------------------------------------

interface DeploymentHookPayload {
  deployment_id: string;
  status: string;
  environment: string;
  previous_status?: string;
}

/**
 * Fire post-store hooks for deployment create/update.
 * Called after successful DB write; non-blocking.
 */
export function fireDeploymentChangedHooks(payload: DeploymentHookPayload, correlationId: string): void {
  const timestamp = new Date().toISOString();
  const base = { source: 'ruvvector-service' as const, event: 'deployment_changed' as const, timestamp };

  fireHooks(
    [
      {
        url: `${INTELLIGENCE_CORE}/v1/ingest/telemetry`,
        body: {
          ...base,
          deployment_id: payload.deployment_id,
          status: payload.status,
          environment: payload.environment,
        },
      },
      {
        url: `${AUTOMATION_CORE}/v1/workflow/trigger`,
        body: {
          ...base,
          deployment_id: payload.deployment_id,
          status: payload.status,
          previous_status: payload.previous_status,
        },
      },
      {
        url: `${SECURITY_CORE}/v1/audit/record`,
        body: {
          ...base,
          deployment_id: payload.deployment_id,
          environment: payload.environment,
          status: payload.status,
        },
      },
    ],
    correlationId
  );
}
