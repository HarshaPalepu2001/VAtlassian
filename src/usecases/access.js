import { DENY, needsUserConsent } from '../lib/errors.js';

/**
 * THE THREE PRIMITIVES EVERY RESOLVER SHARES, AND NOTHING ELSE.
 *
 * Pulled out of panelAccess.js so a caller that only needs "who is asking"
 * and "how do I report failure" — panelSummary.js's narrow read, most of
 * all — does not import panelAccess.js's heavy snapshot() graph (recursive
 * tree reads, the changelog, editmeta) just to reach these three functions.
 * panelAccess.js re-exports all of them unchanged for every existing caller.
 */

export function fail(reason) { const error = new Error(reason); error.reason = reason; throw error; }

/** A refusal whose sentence depends on the case — it names the work items
 *  involved — so it carries its own words instead of a DENY entry. */
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

export async function respond(operation) {
  try { return serialise(await operation()); }
  catch (error) {
    if (needsUserConsent(error)) throw error;
    const reason = error.reason ?? 'ERROR';
    return { error: error.userMessage ?? DENY[reason] ?? error.message ?? String(error), reason };
  }
}
