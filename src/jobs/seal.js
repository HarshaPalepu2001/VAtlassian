/**
 * SEAL — closing tamper-evident boundaries over the audit trail, and refusing
 * to prune anything without evidence it survives elsewhere.
 *
 * The reasoning is in lib/retention.js, including why 21 CFR 11.10(c) requires
 * retention and retrievability rather than deletion, and why an unconfigured
 * instance therefore retains everything forever.
 *
 * WHAT SEALING IS. A segment records that entries [from_seq, to_seq] were
 * verified intact at a moment in time, and pins the boundary hashes. That is
 * worth doing whether or not anyone ever prunes: it converts "the chain
 * verified today" into a dated, durable statement about a specific range, which
 * is what an auditor asking "was the trail intact in March" actually needs. The
 * daily chain walk (jobs/verify.js) proves the chain is whole NOW; a seal
 * proves a range was whole THEN.
 *
 * IT NEVER SEALS A BROKEN CHAIN. The range is verified immediately before it is
 * sealed, and a failure aborts. Sealing over a break would take the one artefact
 * that says the records are trustworthy and attach it to records that are not —
 * strictly worse than having no seal at all.
 *
 * IT NEVER PRUNES HERE. Pruning is deliberately not implemented in this job
 * even though the policy exists to permit it, because the prerequisite does
 * not: a segment may only be pruned once it has been exported and the copy's
 * hash read back, and there is no automated export target yet. The refusal is
 * evaluated and logged on every run so the reason is visible rather than
 * implicit, and so the day an export target lands, the gate is already written
 * and already tested. Until then this job's answer to "may I delete anything"
 * is a recorded no.
 */
import { executeQuery, toBinaryParam, limitClause } from '../lib/db.js';
import { verifyChain, append, EVENT } from '../lib/ledger.js';
import { auditStore, newId } from '../db/store.js';
import { canonical, sha256Hex } from '../lib/hash.js';
import {
  retentionPolicy, prunable, describeRetention,
  RETENTION_DAYS_CFG, RETENTION_ACK_CFG, PRUNE_REFUSAL
} from '../lib/retention.js';

/** Entries per seal. Bounded so one run cannot exceed its budget. */
export const SEAL_BATCH = 1000;

/**
 * Entries left unsealed at the tail.
 *
 * Not a correctness requirement — the ledger is append-only and a contiguous
 * prefix is always safe to seal — but a seal is a statement about a settled
 * range, and sealing right up to the live tail means every run closes a segment
 * over entries written seconds earlier. Leaving a margin keeps segments
 * meaningful rather than a running commentary.
 */
export const TAIL_MARGIN = 50;

const ACTOR = 'system:seal';

async function readConfig() {
  const res = await executeQuery(
    'SELECT cfg_key, cfg_value FROM va_config WHERE cfg_key IN (?, ?)',
    [RETENTION_DAYS_CFG, RETENTION_ACK_CFG]
  );
  if (!res.result) {
    // Unreadable config must not read as "pruning enabled". retentionPolicy({})
    // returns the never-prune default, which is the correct failure here.
    console.error('seal: could not read retention config; assuming retain-forever', res.error);
    return {};
  }
  return Object.fromEntries((res.data ?? []).map((r) => [r.cfg_key, r.cfg_value]));
}

/** The highest sequence already covered by a segment, or 0. */
async function highestSealed() {
  const res = await executeQuery('SELECT MAX(to_seq) AS max_to FROM va_chain_segment');
  if (!res.result) throw new Error(`seal: could not read sealed segments: ${res.error}`);
  const value = res.data?.[0]?.max_to;
  return value == null ? 0 : Number(value);
}

async function tailSeq() {
  const res = await executeQuery('SELECT MAX(seq) AS max_seq FROM va_audit');
  if (!res.result) throw new Error(`seal: could not read the audit tail: ${res.error}`);
  const value = res.data?.[0]?.max_seq;
  return value == null ? 0 : Number(value);
}

/** Open segments, oldest first — the candidates for pruning. */
async function sealedSegments() {
  const res = await executeQuery(
    `SELECT TO_BASE64(segment_id) AS segment_id, from_seq, to_seq, sealed_at,
            export_ref, export_sha256, verified_at, pruned_at
       FROM va_chain_segment
      WHERE pruned_at IS NULL
      ORDER BY from_seq ASC
      LIMIT ${limitClause(200)}`
  );
  if (!res.result) {
    console.error('seal: could not read segments for the prune check', res.error);
    return [];
  }
  return res.data ?? [];
}

export async function run({ now = Date.now() } = {}) {
  const started = Date.now();
  const config = await readConfig();
  const policy = retentionPolicy(config);

  if (policy.warning) {
    // Repeated every run on purpose: a retention period below the floor is a
    // standing condition, and one log line on the day it was set would scroll
    // away long before anyone acted on it.
    console.warn('seal: RETENTION BELOW FLOOR —', policy.warning);
  }

  // --- seal the next settled range ---------------------------------------
  const sealedTo = await highestSealed();
  const tail = await tailSeq();
  const from = sealedTo + 1;
  const to = Math.min(from + SEAL_BATCH - 1, tail - TAIL_MARGIN);

  let sealed = null;
  if (to >= from) {
    const maxEntries = to - from + 1;
    const verification = await verifyChain(auditStore, { from, maxEntries });

    if (!verification.ok) {
      // Never seal over a break. The daily verify job raises the alert; this
      // job's job is to not make the situation worse by certifying it.
      console.error('seal: refusing to seal a range that failed verification', JSON.stringify({
        from, to, brokenAt: verification.brokenAt, reason: verification.reason
      }));
      return { ok: false, reason: 'CHAIN_BROKEN', brokenAt: verification.brokenAt, ms: Date.now() - started };
    }

    const rows = await auditStore.readRange(from, maxEntries);
    if (rows.length > 0) {
      const openingHash = rows[0].prev_hash;
      const terminalHash = rows[rows.length - 1].entry_hash;
      const contentHash = sha256Hex(canonical(rows.map((r) => ({
        seq: r.seq, occurredAt: r.occurred_at, actor: r.actor_account_id,
        eventType: r.event_type, issueId: r.issue_id, payload: r.payload,
        prevHash: r.prev_hash, entryHash: r.entry_hash
      }))));

      const segmentId = newId();
      const insert = await executeQuery(
        `INSERT INTO va_chain_segment
           (segment_id, from_seq, to_seq, opening_hash, terminal_hash, sealed_at,
            export_target, export_ref, export_sha256, verified_at, pruned_at)
         VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
        [
          toBinaryParam(segmentId), rows[0].seq, rows[rows.length - 1].seq,
          openingHash, terminalHash, now,
          // No automated export target exists yet, and saying NONE is how the
          // prune gate stays shut. A placeholder here would look like an export
          // that had happened.
          'NONE', contentHash
        ]
      );

      if (!insert.result) {
        console.error('seal: could not record the segment', insert.error);
        return { ok: false, reason: 'SEGMENT_WRITE_FAILED', ms: Date.now() - started };
      }

      sealed = { from: rows[0].seq, to: rows[rows.length - 1].seq, contentHash };
      await append(auditStore, {
        eventId: newId(),
        actorAccountId: ACTOR,
        eventType: EVENT.SEGMENT_SEALED,
        payload: {
          fromSeq: sealed.from, toSeq: sealed.to,
          openingHash, terminalHash, contentHash,
          entriesVerified: verification.checked
        }
      });
    }
  }

  // --- the prune gate, evaluated and recorded even though it always says no --
  const segments = await sealedSegments();
  const refusals = {};
  let prunable_ = 0;
  for (const segment of segments) {
    const verdict = prunable(segment, policy, now);
    if (verdict.prune) prunable_ += 1;
    else refusals[verdict.reason] = (refusals[verdict.reason] ?? 0) + 1;
  }

  const summary = {
    ok: true,
    retention: describeRetention(policy),
    sealed,
    segments: segments.length,
    // Non-zero would mean every evidence precondition is met and only an export
    // target is missing. Today NOT_EXPORTED accounts for all of them.
    eligibleForPrune: prunable_,
    refusals,
    pruned: 0,
    note: 'Pruning is not performed: no export target exists, so no segment can satisfy the export-and-verify precondition.',
    ms: Date.now() - started
  };
  console.log('seal:', JSON.stringify(summary));
  return summary;
}

export { PRUNE_REFUSAL };
export const handler = run;
