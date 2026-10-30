import { DENY, needsUserConsent } from '../lib/errors.js';

/**
 * Shared access and refusal helpers. Keeping these separate lets callers such
 * as panelSummary.js avoid importing panelAccess.js and its heavy snapshot()
 * dependencies, including recursive tree reads, changelog and editmeta.
 * panelAccess.js re-exports the helpers for existing callers.
 */

export function fail(reason) { const error = new Error(reason); error.reason = reason; throw error; }

/** A refusal naming the affected work items. Use its supplied message
 *  instead of the generic DENY entry. */
export function failWith(reason, message) {
  const error = new Error(message); error.reason = reason; error.userMessage = message; throw error;
}

export function actorFrom(context) {
  if (!context?.accountId) fail('AUTHENTICATION_REQUIRED');
  return { accountId: context.accountId };
}

export function serialise(value) {
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(serialise);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialise(v)]));
  return value;
}

/**
 * Forward supplied retry metadata only for upstream 429/503 failures.
 *
 * Jira adapters such as testmgmt/jira.js json() retain raw 403/404 status on the
 * error while mapping both to NOT_FOUND. Forwarding those statuses would reveal
 * whether an inaccessible issue exists. Never fabricate metadata or forward
 * other codes. tmRespond in testmgmt/messages.js uses the same helper.
 */
export function retryGuidance(error) {
  if (error?.status !== 429 && error?.status !== 503) return {};
  return {
    status: error.status,
    ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {})
  };
}

export async function respond(operation) {
  try { return serialise(await operation()); }
  catch (error) {
    if (needsUserConsent(error)) throw error;
    const reason = error.reason ?? 'ERROR';
    return { error: error.userMessage ?? DENY[reason] ?? error.message ?? String(error), reason, ...retryGuidance(error) };
  }
}
