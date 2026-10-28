import { invoke as forgeInvoke, events } from '@forge/bridge';
import { recordHarnessEvent, getActiveTraceId } from './harness';

/** Resolver keys whose success means a durable, visible state change — a
 *  signature recorded, a transition retried, a restoration retried. Every
 *  other open surface needs to know when one of these actually happens. */
const MUTATION_KEYS = ['signature:submit', 'approval:submit', 'approval:retryTransition', 'restore:retry'];
const CONFIGURATION_MUTATIONS = new Set([
  'admin:grantAdmin', 'admin:revokeAdmin', 'admin:grantEligibility', 'admin:revokeEligibility',
  'admin:createControlledTransition', 'admin:updateControlledTransition', 'admin:revokeControlledTransition',
  'admin:saveConfig', 'admin:issueCredentialResetGrant'
]);

/** `respond()` on the server never rejects the resolver call — it resolves
 *  with `{ error, reason }` — so a failed mutation still returns here as a
 *  normal value. This is the one place that decides "durable" from that
 *  shape, so every caller of `invoke` gets the same answer without having to
 *  emit anything itself. A `transitionError` can follow a persisted approval:
 *  in that case other views still need to refresh and show the recorded
 *  decision, even though Jira did not complete the requested move. */
function isDurable(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as { success?: boolean; ok?: boolean; error?: string; transitionError?: string; approvalId?: string };
  return r.success !== false && r.ok !== false && !r.error && (!r.transitionError || typeof r.approvalId === 'string');
}

/** The app requests plain resolver bodies, never bridge response metadata. */
export async function invoke<T = unknown>(key: string, payload?: Record<string, unknown>): Promise<T> {
  const isInternalTelemetry = key === 'harness:logAction';
  const startedAt = Date.now();
  const activeTrace = getActiveTraceId();
  const enrichedPayload = payload
    ? (activeTrace && !payload.traceId ? { ...payload, traceId: activeTrace } : payload)
    : (activeTrace ? { traceId: activeTrace } : undefined);

  try {
    const result = await forgeInvoke<T>(key, enrichedPayload) as T;
    const durationMs = Date.now() - startedAt;

    if (!isInternalTelemetry) {
      const isOk = !result || typeof result !== 'object'
        || ((result as { success?: boolean; ok?: boolean; error?: string }).success !== false
          && (result as { ok?: boolean }).ok !== false
          && !(result as { error?: string }).error);

      recordHarnessEvent(isOk ? 'BRIDGE' : 'ERROR', `invoke:${key}`, {
        durationMs,
        traceId: activeTrace ?? (payload?.traceId as string | undefined),
        success: isOk,
        issueKey: payload?.issueKey,
        ...(payload ? { request: payload } : {}),
        response: typeof result === 'object' && result !== null
          ? {
              success: (result as { success?: boolean }).success,
              ok: (result as { ok?: boolean }).ok,
              reason: (result as { reason?: string }).reason,
              error: (result as { error?: string }).error,
              transitioned: (result as { transitioned?: boolean }).transitioned,
              state: (result as { state?: string }).state
            }
          : result
      });
    }

    const changeEvent = MUTATION_KEYS.includes(key) ? 'VA_ISSUE_CHANGED'
      : CONFIGURATION_MUTATIONS.has(key) ? 'VA_CONFIGURATION_CHANGED' : null;
    if (changeEvent && isDurable(result)) {
      const change = changeEvent === 'VA_ISSUE_CHANGED' ? { issueKey: payload?.issueKey } : { operation: key };
      void events.emit(changeEvent, change).catch(() => {});
    }
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (!isInternalTelemetry) {
      recordHarnessEvent('ERROR', `invoke:${key}:failed`, {
        durationMs,
        traceId: activeTrace ?? (payload?.traceId as string | undefined),
        issueKey: payload?.issueKey,
        request: payload
      }, error);
    }
    throw error;
  }
}
