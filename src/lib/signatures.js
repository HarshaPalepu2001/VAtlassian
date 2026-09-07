import { FailClosed } from './errors.js';

export const SIG_STATE = { PENDING: 'PENDING', CONSUMED: 'CONSUMED', EXPIRED: 'EXPIRED', VOID: 'VOID' };

/** How long a signature stays usable before the transition must be performed. */
export const PENDING_TTL_MS = 15 * 60 * 1000;

/**
 * Consume a pending signature — atomically, without a transaction.
 *
 * A single UPDATE with the state predicate in the WHERE clause is a
 * compare-and-swap. The engine applies it atomically, so of N concurrent
 * callers exactly one observes affectedRows === 1. Everyone else sees 0 and is
 * denied. This closes the replay hole (one signature, one transition) without
 * needing BEGIN/COMMIT.
 *
 * Order matters: consume FIRST, then let the caller record the audit event. If
 * we audited first and the CAS then lost the race, the ledger would claim a
 * transition that never happened.
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
