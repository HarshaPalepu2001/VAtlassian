import { entryHash, GENESIS_HASH, canonical } from './hash.js';
import { FailClosed } from './errors.js';

export const MAX_APPEND_ATTEMPTS = 128;  // above any realistic burst; the deadline is the real bound
export const APPEND_DEADLINE_MS = 3_000;

/**
 * Append-only, hash-chained audit ledger — without transactions.
 *
 * The problem: appending is read-then-write (read the tail hash, then insert a
 * row linking to it). Forge SQL permits one statement per call and has no
 * BEGIN/COMMIT, so two concurrent appends can read the same tail and fork the
 * chain — producing two entries at the same seq with the same prev_hash, which
 * is exactly the corruption the chain exists to detect.
 *
 * The fix: `seq` is the PRIMARY KEY. Uniqueness on the primary key is the
 * serialisation mechanism. Two racing appends compute the same candidate seq;
 * the database admits exactly one and rejects the other with a duplicate-key
 * error. No transaction is required, because the INSERT itself is atomic.
 *
 * GUARANTEED FORWARD PROGRESS. The obvious retry — re-read the tail and try
 * again — starves under contention: every loser re-reads, they all land on the
 * same new seq, and they collide again. Measured at 40 concurrent appends, some
 * writers exhausted their retries and were refused. For this product that means
 * refusing a valid signature under load, which is not acceptable.
 *
 * So on collision we do NOT re-read the tail. We read the row that beat us at
 * seq N (it definitionally now exists), take its hash as our new prev_hash, and
 * try N+1. Each retry therefore advances by exactly one and can only be beaten
 * by a writer that itself made progress. With N concurrent writers the last one
 * finishes in at most N attempts, and no writer can be starved indefinitely.
 *
 * Bounded by BOTH an attempt count and a wall-clock deadline, because the
 * caller may be a workflow validator holding a Jira transition open.
 *
 * On exhaustion we FAIL CLOSED. An action whose audit event could not be
 * recorded must not take effect — an unrecorded signature is worse than a
 * refused one.
 */
export async function append(store, event, { now = Date.now, sleep = defaultSleep, deadlineMs = APPEND_DEADLINE_MS } = {}) {
  const deadline = now() + deadlineMs;
  let lastError;

  const tail = await store.readTail();
  let seq = tail ? tail.seq + 1 : 1;
  let prevHash = tail ? tail.entry_hash : GENESIS_HASH;

  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    if (now() > deadline) break;

    const occurredAt = event.occurredAt ?? now();
    const payload = event.payload ?? {};
    const row = {
      seq,
      event_id: event.eventId,
      occurred_at: occurredAt,
      actor_account_id: event.actorAccountId,
      event_type: event.eventType,
      issue_id: event.issueId ?? null,
      approval_id: event.approvalId ?? null,
      payload: canonical(payload),
      prev_hash: prevHash
    };
    row.entry_hash = entryHash({
      seq,
      prevHash,
      occurredAt,
      actorAccountId: row.actor_account_id,
      eventType: row.event_type,
      issueId: row.issue_id,
      approvalId: row.approval_id,
      payload
    });

    try {
      await store.insertEntry(row);
      return { seq, entryHash: row.entry_hash, attempts: attempt + 1 };
    } catch (err) {
      if (!store.isDuplicateKey(err)) {
        throw new FailClosed('LEDGER_UNAVAILABLE', err);
      }
      lastError = err;

      // Someone took our slot. Chain onto THEIR entry and advance by one.
      const taken = await store.entryAt(seq);
      if (taken) {
        prevHash = taken.entry_hash;
        seq = seq + 1;
      } else {
        // Should not happen (the duplicate proves a row exists), but if the
        // read races a prune, resync from the tail rather than guessing.
        const t = await store.readTail();
        seq = t ? t.seq + 1 : 1;
        prevHash = t ? t.entry_hash : GENESIS_HASH;
      }

      // Small jittered pause. Without jitter, contending writers advance in
      // lockstep and keep colliding.
      await sleep(Math.floor(Math.random() * 3));
    }
  }
  throw new FailClosed('LEDGER_UNAVAILABLE', lastError);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Walk the chain and report the first break.
 *
 * This is the operational expression of 21 CFR 11.10(a) — "the ability to
 * discern invalid or altered records". It cannot prevent tampering; it detects
 * it, which is what the clause actually requires.
 *
 * Runs daily as a scheduled job and on demand from the admin console.
 *
 * `maxEntries` bounds a single call so a scheduled job can walk a large ledger
 * in windows without running past its invocation budget. A call that stops
 * short returns `partial: true` with the `nextSeq` to resume from — that is a
 * verdict on the window it covered, NOT on the whole chain. Only a result with
 * `partial` absent has reached the tail. See jobs/verify.js for what a
 * multi-run pass can and cannot claim.
 */
export async function verifyChain(store, { from = 1, batchSize = 500, maxEntries = Infinity } = {}) {
  let expectedSeq = from;
  let prevHash = from === 1 ? GENESIS_HASH : await store.entryHashAt(from - 1);
  if (prevHash == null) {
    return { ok: false, brokenAt: from, reason: 'MISSING_PREDECESSOR' };
  }

  let checked = 0;
  for (;;) {
    const remaining = maxEntries - checked;
    if (remaining <= 0) {
      return { ok: true, partial: true, checked, nextSeq: expectedSeq, terminalHash: prevHash };
    }
    const batch = await store.readRange(expectedSeq, Math.min(batchSize, remaining));
    if (batch.length === 0) break;

    for (const row of batch) {
      if (row.seq !== expectedSeq) {
        return { ok: false, brokenAt: expectedSeq, reason: 'SEQUENCE_GAP', found: row.seq, checked };
      }
      if (row.prev_hash !== prevHash) {
        return { ok: false, brokenAt: row.seq, reason: 'CHAIN_MISMATCH', checked };
      }
      const recomputed = entryHash({
        seq: row.seq,
        prevHash: row.prev_hash,
        occurredAt: row.occurred_at,
        actorAccountId: row.actor_account_id,
        eventType: row.event_type,
        issueId: row.issue_id,
        approvalId: row.approval_id,
        payload: JSON.parse(row.payload)
      });
      if (recomputed !== row.entry_hash) {
        return { ok: false, brokenAt: row.seq, reason: 'ENTRY_ALTERED', checked };
      }
      prevHash = row.entry_hash;
      expectedSeq += 1;
      checked += 1;
    }
  }
  return { ok: true, checked, terminalSeq: expectedSeq - 1, terminalHash: prevHash };
}

export const EVENT = {
  // 2026-08-18: TOTP replaced the PIN as the second identification component.
  TOTP_ENROLLED: 'TOTP_ENROLLED',
  TOTP_CONFIRMED: 'TOTP_CONFIRMED',
  TOTP_RESET: 'TOTP_RESET',
  TOTP_ATTEMPT_FAILED: 'TOTP_ATTEMPT_FAILED',
  TOTP_LOCKED_OUT: 'TOTP_LOCKED_OUT',
  WEBAUTHN_CREDENTIAL_ENROLLED: 'WEBAUTHN_CREDENTIAL_ENROLLED',
  WEBAUTHN_AUTH_FAILED: 'WEBAUTHN_AUTH_FAILED',
  CREDENTIAL_RESET_GRANT_ISSUED: 'CREDENTIAL_RESET_GRANT_ISSUED',
  CREDENTIAL_RESET_GRANT_REDEEMED: 'CREDENTIAL_RESET_GRANT_REDEEMED',
  SIGNATURE_CREATED: 'SIGNATURE_CREATED',
  SIGNATURE_CONSUMED: 'SIGNATURE_CONSUMED',
  SIGNATURE_VOIDED: 'SIGNATURE_VOIDED',
  // 2026-08-18: an eligible signer explicitly declined to sign a gated
  // transition (resolvers/panel.js's panel:reject) — an attested "no", not
  // just an absence of a "yes". Distinct from TRANSITION_DENIED, which is
  // gate.js refusing an unauthorized/invalid attempt, not a reviewer's own
  // recorded decision.
  SIGNATURE_DECLINED: 'SIGNATURE_DECLINED',
  CONTENT_CHANGED: 'CONTENT_CHANGED',
  ITEM_FIRST_OBSERVED: 'ITEM_FIRST_OBSERVED',
  // 2026-08-26: the item left the status its baseline was signed into, so that
  // signature stopped describing the record and drift detection disarmed —
  // lib/interception.js's supersede().
  //
  // Audited rather than silent because it is a change in the CONTROL that
  // applies to a record, not a change to the record. Every other event here
  // answers "what happened to this document"; this one answers "why did this
  // app stop watching it", and an auditor who finds an item that quietly
  // ceased to be tracked deserves better than an absence. Nothing is destroyed
  // by it: va_signature and the Electronic Signature field both still hold the
  // signature it supersedes.
  BASELINE_SUPERSEDED: 'BASELINE_SUPERSEDED',
  SIGNATURE_EXPIRED: 'SIGNATURE_EXPIRED',
  TRANSITION_DENIED: 'TRANSITION_DENIED',
  ADMIN_SEEDED: 'ADMIN_SEEDED',
  ELIGIBILITY_CHANGED: 'ELIGIBILITY_CHANGED',
  CONTROLLED_TRANSITION_CHANGED: 'CONTROLLED_TRANSITION_CHANGED',
  SEGMENT_SEALED: 'SEGMENT_SEALED',
  // 2026-08-31: an administrator produced a copy of the records under
  // 21 CFR 11.10(b). Deliberately NOT reusing SEGMENT_SEALED, which means a
  // ledger range was sealed for archival — a different act with different
  // consequences. Two events sharing one name is how an audit trail starts
  // describing things that did not happen.
  //
  // Taking a copy of the signature evidence is itself worth recording: who
  // exported what, when, and the SHA-256 of what they took, so a copy that
  // surfaces later can be tied back to the moment it was produced.
  RECORDS_EXPORTED: 'RECORDS_EXPORTED',
  CHAIN_VERIFIED: 'CHAIN_VERIFIED',
  CHAIN_BROKEN: 'CHAIN_BROKEN',
  // 2026-08-31: jobs/gatecheck.js found the sig-gate validator missing,
  // disabled, or orphaned on an edge va_controlled_transition says is
  // controlled — or found a second ungated route into a controlled status.
  //
  // Audited rather than only tabled because this is the app noticing that its
  // OWN control stopped applying, which is the one event it cannot record at
  // the moment it happens: a detached validator means Jira never calls the
  // gate, so there is no transition to deny and nothing to write. The ledger
  // entry is therefore the only dated evidence that an edge went unenforced,
  // and 11.10(f) is defensible at audit precisely to the extent this exists.
  GATE_DRIFT_DETECTED: 'GATE_DRIFT_DETECTED',
  // The same finding stopped being observed. Recorded, not deleted: a window
  // in which a control was absent remains a fact about the record even after
  // someone reattaches the validator.
  GATE_DRIFT_CLEARED: 'GATE_DRIFT_CLEARED',
  // 2026-08-31: 21 CFR 11.300(e) device testing. A correct TOTP code is the
  // authenticator proving it still holds the right secret and a clock inside
  // the window — there is nothing more meaningful we could administer. These
  // three record that the test happened, that one is overdue, and that a
  // long-silent device was used.
  //
  // DORMANT_DEVICE_USED is the one that earns its place. We cannot tell a
  // returning employee from someone holding a secret cloned months ago, and we
  // do not pretend to — but "this device had been silent for 214 days" is the
  // context an investigator needs, and until now the record could not supply it.
  DEVICE_CHECK_PASSED: 'DEVICE_CHECK_PASSED',
  DEVICE_CHECK_DUE: 'DEVICE_CHECK_DUE',
  DORMANT_DEVICE_USED: 'DORMANT_DEVICE_USED',
  // Item 3: admin review of an intercepted content change.
  CHANGE_APPROVED: 'CHANGE_APPROVED',
  CHANGE_REJECTED: 'CHANGE_REJECTED',
  BASELINE_CAPTURED: 'BASELINE_CAPTURED',
  BASELINE_DISARMED: 'BASELINE_DISARMED',
  BASELINE_DEGRADED: 'BASELINE_DEGRADED',
  DRIFT_DETECTED: 'DRIFT_DETECTED',
  DRIFT_RECONCILED: 'DRIFT_RECONCILED',
  DRIFT_SELF_REVERTED: 'DRIFT_SELF_REVERTED',
  DRIFT_RECALLED: 'DRIFT_RECALLED',
  // 2026-09-13: `payload.reason` is one of NOT_GATED, NO_ROUTE, AMBIGUOUS_ROUTE,
  // SCREEN_BLOCKED, JIRA_REFUSED, or BASELINE_POLICY_INCOMPLETE — see
  // lib/recall.js's RECALL constants and lib/restore/recall.js's
  // recordRecallFailure(). The same failure is also raised as a deduplicated
  // administrator finding (db/incidentStore.js's recordRecallFinding); this
  // ledger entry is this work item's own permanent record that it happened,
  // the finding is the live, actionable one an admin works from.
  DRIFT_RECALL_FAILED: 'DRIFT_RECALL_FAILED',
  DECISION_RECORDED: 'DECISION_RECORDED',
  DECISION_CONSUMED: 'DECISION_CONSUMED',
  DECISION_VOIDED: 'DECISION_VOIDED',
  DECISION_EXPIRED: 'DECISION_EXPIRED',
  RESTORE_STARTED: 'RESTORE_STARTED',
  RESTORE_COMPLETED: 'RESTORE_COMPLETED',
  RESTORE_PARTIAL: 'RESTORE_PARTIAL',
  RESTORE_FAILED: 'RESTORE_FAILED',
  TRANSITION_ALLOWED: 'TRANSITION_ALLOWED',
  REPORT_GENERATED: 'REPORT_GENERATED',
  REPORT_DEGRADED: 'REPORT_DEGRADED',
  CONFIG_CHANGED: 'CONFIG_CHANGED',
  REVIEWER_CHANGED: 'REVIEWER_CHANGED',
  GATED_TRANSITION_CHANGED: 'GATED_TRANSITION_CHANGED',
  FIELD_RETENTION_CHANGED: 'FIELD_RETENTION_CHANGED',
  CONTROLLED_FIELDS_BASELINED: 'CONTROLLED_FIELDS_BASELINED',
  APPROVAL_RECORDED: 'APPROVAL_RECORDED',
  APPROVAL_CONSUMED: 'APPROVAL_CONSUMED',
  APPROVAL_VOIDED: 'APPROVAL_VOIDED',
  APPROVAL_REFUSED: 'APPROVAL_REFUSED',
  TRANSITION_BLOCKED: 'TRANSITION_BLOCKED',
  TRANSITION_COMPLETED: 'TRANSITION_COMPLETED',
  TREE_RESTORE_PLAN_CREATED: 'TREE_RESTORE_PLAN_CREATED',
  TREE_RESTORE_STEP_CLAIMED: 'TREE_RESTORE_STEP_CLAIMED',
  TREE_RESTORE_REPLACEMENT_RECORDED: 'TREE_RESTORE_REPLACEMENT_RECORDED',
  // What a rejection destroyed, written before the work item is deleted. See
  // the DELETE_ADDED_NODE branch of lib/tree/restoreExecutor.js: this entry IS
  // the record that the deleted record existed.
  TREE_RESTORE_NODE_DESTROYED: 'TREE_RESTORE_NODE_DESTROYED',
  TREE_RESTORE_VERIFIED: 'TREE_RESTORE_VERIFIED'
};
