import { FailClosed } from './errors.js';

export const SIG_STATE = { PENDING: 'PENDING', CONSUMED: 'CONSUMED', EXPIRED: 'EXPIRED', VOID: 'VOID' };

/** How long a signature stays usable before the transition must be performed. */
export const PENDING_TTL_MS = 15 * 60 * 1000;

/**
 * Consume a pending signature with one conditional UPDATE. Exactly one
 * concurrent caller can observe affectedRows === 1; deny the others.
 * Consume before writing the audit event so a caller that loses the race
 * cannot record a transition that did not happen. No transaction is needed.
 */
export async function consume(store, { approvalId, now }) {
  const affected = await store.casConsume({
    approvalId,
    now,
    fromState: SIG_STATE.PENDING,
    toState: SIG_STATE.CONSUMED
  });
  if (affected === 1) return { consumed: true };
  if (affected === 0) return { consumed: false };
  // More than one row updated means the approval_id primary key is not unique,
  // which should be impossible. Refuse to interpret it.
  throw new FailClosed('LEDGER_UNAVAILABLE', new Error(`CAS affected ${affected} rows`));
}

/**
 * Decide whether a transition may proceed.
 *
 * Pure decision logic, deliberately separated from I/O so the fail-closed
 * behaviour is directly testable. Every path that is not an explicit allow
 * returns a deny.
 */
export function evaluate({ candidate, now, currentContentHash }) {
  if (!candidate) return { allow: false, reason: 'NO_PENDING_SIGNATURE' };
  if (candidate.state !== SIG_STATE.PENDING) return { allow: false, reason: 'NO_PENDING_SIGNATURE' };
  if (candidate.expires_at <= now) return { allow: false, reason: 'SIGNATURE_EXPIRED' };
  if (candidate.content_hash !== currentContentHash) return { allow: false, reason: 'CONTENT_CHANGED' };
  return { allow: true, approvalId: candidate.approval_id };
}
