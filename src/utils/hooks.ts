/**
 * Post-execution hooks for fan-out to core bundles.
 * All calls are non-blocking (fire-and-forget via Promise.allSettled).
 * Forwards X-Correlation-ID from execution_metadata.trace_id.
 *
 * Authentication: Uses Google Cloud metadata server to obtain OIDC identity
 * tokens for Cloud Run service-to-service auth.
 */
import logger from './logger';

const HOOK_TIMEOUT_MS = 5000;

// Cache identity tokens per audience (they last ~1 hour; refresh at 55 min)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

/**
 * Fetch a Google Cloud OIDC identity token for a given audience.
 * Works on Cloud Run via the metadata server; returns null locally.
 */
async function getIdentityToken(audience: string): Promise<string | null> {
  const cached = tokenCache.get(audience);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  try {
    const metadataUrl =
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
    const res = await fetch(metadataUrl, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(2000),
    });

    if (!res.ok) {
      logger.warn({ audience, status: res.status }, 'Failed to fetch identity token from metadata server');
      return null;
    }

    const token = await res.text();
    // Identity tokens are valid for ~1 hour
    tokenCache.set(audience, { token, expiresAt: Date.now() + 55 * 60 * 1000 - TOKEN_REFRESH_MARGIN_MS });
    return token;
  } catch {
    // Not running on GCP or metadata server unavailable — skip auth
    return null;
  }
}

/**
 * Extract the base URL (scheme + host) from a full URL for use as the OIDC audience.
 */
function getAudience(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

interface HookTarget {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Fire non-blocking POST calls to multiple targets.
 * Uses Promise.allSettled so failures in one target don't affect others.
 * Includes OIDC identity token for Cloud Run IAM authentication.
 */
function fireHooks(targets: HookTarget[], correlationId: string): void {
  Promise.allSettled(
    targets.map(async ({ url, body }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HOOK_TIMEOUT_MS);

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Correlation-ID': correlationId,
        };

        // Obtain OIDC identity token for the target service
        const audience = getAudience(url);
        const idToken = await getIdentityToken(audience);
        if (idToken) {
          headers['Authorization'] = `Bearer ${idToken}`;
        }

        const res = await fetch(url, {
          method: 'POST',
          headers,
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
const ECOSYSTEM_CORE = 'https://ecosystem-core-1062287243982.us-central1.run.app';

// ---------------------------------------------------------------------------
// Plan hooks
// ---------------------------------------------------------------------------

interface PlanHookPayload {
  plan_id: string;
  intent: string;
  org_id: string;
  checksum: string;
  plan: Record<string, unknown>;
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
      {
        url: `${AUTOMATION_CORE}/v1/orchestration/event`,
        body: {
          source: 'ruvvector-service',
          event_type: 'plan_stored',
          execution_id: payload.plan_id,
          timestamp,
          payload: payload.plan,
        },
      },
      {
        url: `${ECOSYSTEM_CORE}/v1/ecosystem/event`,
        body: {
          source: 'ruvvector-service',
          event_type: 'plan_stored',
          execution_id: payload.plan_id,
          timestamp,
          payload: { plan_id: payload.plan_id, action: 'store' },
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
