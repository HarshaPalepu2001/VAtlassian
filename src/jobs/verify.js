/**
 * Verify the audit hash chain on a daily schedule.
 *
 * The scheduled handler was previously empty even though
 * lib/ledger.js#verifyChain was implemented and tested. Successful checks record
 * CHAIN_VERIFIED under 21 CFR 11.10(e); detected breaks record CHAIN_BROKEN.
 *
 * Verify at most WINDOW entries per run using a cursor in va_config. Resume
 * from that cursor on the next run. At the tail, reset to sequence 1 for the
 * next full pass. A pass across several runs does not prove the whole chain
 * was intact at one instant. State the detection interval as "verified within
 * N days", never "continuously verified". Increasing WINDOW shortens the
 * cycle at the cost of invocation time.
 *
 * A break leaves the cursor unchanged and is reported on each run until
 * resolved. MISSING_PREDECESSOR resets the cursor to 1 instead of reporting
 * tampering: a sealed and pruned prefix could make the preceding entry
 * unavailable. Pruning is not yet implemented. A deleted entry still appears
 * as SEQUENCE_GAP in a pass starting at sequence 1.
 */
import { verifyChain, append, EVENT } from '../lib/ledger.js';
import { auditStore, newId } from '../db/store.js';
import { executeQuery } from '../lib/db.js';
import { chainBrokenAlert } from '../lib/alerts.js';
import { enqueue } from '../db/alertStore.js';

export const CURSOR_KEY = 'verify.cursor';

// Bound entries per run because verifyChain re-hashes every row. A smaller
// window increases detection latency without holding a Jira transition open.
export const WINDOW = 2_000;

const ACTOR = 'system:verify';

export async function readCursor() {
  const res = await executeQuery(
    'SELECT cfg_value FROM va_config WHERE cfg_key = ?',
    [CURSOR_KEY]
  );
  // An unreadable cursor starts a full pass instead of skipping verification.
  if (!res.result) {
    console.error('verify: could not read cursor, starting a full pass', res.error);
    return 1;
  }
  const parsed = Number.parseInt(res.data?.[0]?.cfg_value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

export async function writeCursor(seq) {
  const res = await executeQuery(
    `INSERT INTO va_config (cfg_key, cfg_value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value), updated_at = VALUES(updated_at)`,
    [CURSOR_KEY, String(seq), Date.now(), ACTOR]
  );
  // A failed cursor write repeats a window next run but skips no checks.
  // Keep the verification result instead of failing the run.
  if (!res.result) {
    console.error('verify: could not persist cursor; next run repeats this window', res.error);
  }
  return res.result === true;
}

async function record(eventType, payload) {
  try {
    await append(auditStore, {
      eventId: newId(),
      actorAccountId: ACTOR,
      eventType,
      payload
    });
    return true;
  } catch (e) {
    // Log and return the verdict even when the ledger cannot record it.
    // A failed audit write must not hide a detected chain break.
    console.error(`verify: could not append ${eventType}`, e);
    return false;
  }
}

export async function run() {
  const started = Date.now();
  const from = await readCursor();

  const result = await verifyChain(auditStore, { from, maxEntries: WINDOW });

  if (!result.ok) {
    if (result.reason === 'MISSING_PREDECESSOR') {
      // See the header: expected after a future prune, not evidence of
      // tampering. Resync and let the next run walk from the start.
      console.warn(`verify: no entry at seq ${from - 1}; resyncing cursor to 1`);
      await writeCursor(1);
      const summary = { ok: true, resynced: true, from, ms: Date.now() - started };
      console.log('verify:', JSON.stringify(summary));
      return summary;
    }

    const detail = {
      from,
      brokenAt: result.brokenAt,
      reason: result.reason,
      checked: result.checked ?? 0,
      found: result.found ?? null
    };
    const recorded = await record(EVENT.CHAIN_BROKEN, detail);
    // Recorded is not reported. Deduped on the position of the break, so an
    // unrepaired chain raises one work item and keeps it rather than a new one
    // every day.
    await enqueue(chainBrokenAlert({
      brokenAt: result.brokenAt,
      reason: result.reason,
      checked: result.checked ?? 0,
      occurredAt: started
    }));
    console.error('verify: CHAIN BROKEN', JSON.stringify({ ...detail, recorded }));
    // Cursor deliberately left where it is, so every subsequent run re-raises.
    return { ok: false, ...detail, recorded, ms: Date.now() - started };
  }

  if (result.partial) {
    await writeCursor(result.nextSeq);
    const summary = {
      ok: true,
      complete: false,
      from,
      checked: result.checked,
      nextSeq: result.nextSeq,
      ms: Date.now() - started
    };
    console.log('verify:', JSON.stringify(summary));
    return summary;
  }

  // Reached the tail: one full pass over the ledger is complete.
  await writeCursor(1);

  const summary = {
    ok: true,
    complete: true,
    from,
    checked: result.checked,
    throughSeq: result.terminalSeq,
    ms: Date.now() - started
  };

  // An empty ledger is verified vacuously. Appending CHAIN_VERIFIED to it would
  // make the first entry in the audit trail a statement about its own absence.
  if (result.terminalSeq >= 1) {
    summary.recorded = await record(EVENT.CHAIN_VERIFIED, {
      throughSeq: result.terminalSeq,
      terminalHash: result.terminalHash,
      checkedThisRun: result.checked,
      passStartedFrom: from
    });
  }

  console.log('verify:', JSON.stringify(summary));
  return summary;
}

// scheduledTrigger points at `handler: jobs/verify.run` (manifest.yml), so
// `run` is the entry point; `handler` is kept as an alias for consistency with
// the other jobs.
export const handler = run;
