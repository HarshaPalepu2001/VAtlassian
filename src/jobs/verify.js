/**
 * VERIFY — the daily walk of the audit chain.
 *
 * This file was `export const run = async () => {}` while manifest.yml
 * scheduled it daily with the comment "walk the audit chain, alert on break".
 * The walk itself was never missing — lib/ledger.js's verifyChain() has always
 * been complete and tested. What was missing was anything that CALLED it on a
 * schedule, so a broken chain would have sat undetected until someone happened
 * to open the admin console and ask.
 *
 * WHY THIS IS A CONTROL AND NOT A HEALTH CHECK. 21 CFR 11.10(e) requires a
 * secure, computer-generated, time-stamped audit trail. A hash chain nobody
 * walks is an assertion, not a control: it makes tampering detectABLE without
 * making it detectED. The daily pass is what converts the one into the other,
 * and the CHAIN_VERIFIED entry it appends is the dated evidence that the
 * detection actually ran — which is the part an auditor asks for, because
 * "our records are tamper-evident" is a claim and "here is the daily record of
 * us checking" is proof.
 *
 * WINDOWED, AND WHAT THAT COSTS. A full walk is O(ledger), which is fine today
 * and will not be after a year on a busy instance. So each run verifies at most
 * WINDOW entries from a cursor in va_config and stops; the next run resumes
 * where it left off. When a pass reaches the tail the cursor resets to 1 and
 * the next cycle starts over.
 *
 * Be honest about what that proves. A pass spread over several runs does NOT
 * show the whole chain was intact at any single instant — an alteration could
 * in principle move behind the cursor mid-pass. What it does guarantee is that
 * any alteration is caught within one full cycle, because every cycle restarts
 * at seq 1 and re-checks everything. That is a detection-latency bound, not a
 * gap: state it as "verified within N days", never as "continuously verified".
 * Raise WINDOW to shorten the cycle; the cost is invocation time.
 *
 * A BREAK DOES NOT ADVANCE THE CURSOR. It is a standing alarm, re-raised on
 * every run until someone resolves it. Advancing past a break would silence the
 * alarm on the second day, which is precisely when it matters most.
 *
 * MISSING_PREDECESSOR IS NOT TREATED AS TAMPERING. verifyChain reports it when
 * the entry before the cursor cannot be read, which will one day be the normal
 * result of sealing and pruning an old segment (jobs/seal.js, va_chain_segment)
 * rather than evidence of anything. Since prune does not exist yet this cannot
 * currently happen, but crying wolf the first time it does would train whoever
 * reads these alerts to ignore them. So it resyncs the cursor to 1 and lets the
 * next run start a clean pass. Nothing is lost by that: a genuinely DELETED
 * entry still surfaces as SEQUENCE_GAP on the pass from seq 1, which is where
 * every cycle begins.
 */
import { verifyChain, append, EVENT } from '../lib/ledger.js';
import { auditStore, newId } from '../db/store.js';
import { executeQuery } from '../lib/db.js';
import { chainBrokenAlert } from '../lib/alerts.js';
import { enqueue } from '../db/alertStore.js';

export const CURSOR_KEY = 'verify.cursor';

// Entries per run. Deliberately conservative: verifyChain re-hashes every row
// it reads, and the cost of a slow pass is latency to detection rather than a
// failed transition — this job holds nothing open.
export const WINDOW = 2_000;

const ACTOR = 'system:verify';

export async function readCursor() {
  const res = await executeQuery(
    'SELECT cfg_value FROM va_config WHERE cfg_key = ?',
    [CURSOR_KEY]
  );
  // An unreadable cursor must not skip verification — start a full pass.
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
  // A cursor that fails to persist costs a repeated window next run — wasted
  // work, never a missed check. Not worth failing the run over.
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
    // The ledger being unwritable is itself something this job exists to
    // notice. Log loudly and still return the verdict — a break that could not
    // be recorded must not also go unreported.
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
