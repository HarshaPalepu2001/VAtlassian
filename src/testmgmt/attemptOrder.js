import { contentDigest } from './content.js';

/** First invocation freezes an audit cutoff, before the first native sequence.
 * Old-version attempts audited after this cutoff have no provable ordering and
 * remain blocked. The only write is to the new clock, never a historical run.
 */
export const INITIALISE_ATTEMPT_CLOCK = `INSERT INTO tm_attempt_clock (clock_id, last_sequence, legacy_cutoff)
  SELECT 1, COALESCE(MAX(seq), 0), COALESCE(MAX(seq), 0) FROM va_audit
  ON DUPLICATE KEY UPDATE clock_id = clock_id`;

export async function historicalAttemptOrder(runs, query) {
  const historical = runs.filter(r => r.evidenceSchema !== 2 && r.attemptSequence == null);
  if (!historical.length) return runs;
  const q = async (sql, params = []) => { const result = await query(sql, params); if (!result?.result) throw new Error('Attempt order unavailable'); return result.data; };
  await q(INITIALISE_ATTEMPT_CLOCK);
  const clock = (await q('SELECT legacy_cutoff FROM tm_attempt_clock WHERE clock_id = 1'))[0];
  const cutoff = Number(clock?.legacy_cutoff);
  if (!Number.isSafeInteger(cutoff) || cutoff < 0) throw new Error('Attempt cutoff unavailable');
  const marks = historical.map(() => '?').join(', '), cap = historical.length * 2 + 1;
  const events = await q(`SELECT seq, entry_hash, HEX(event_id) AS event_id_hex, actor_account_id, issue_id, payload FROM va_audit
    WHERE event_type = 'TM_RUN_CREATED' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.runId')) IN (${marks})
    ORDER BY seq ASC LIMIT ${cap}`, historical.map(r => r.runId));
  if (!Array.isArray(events) || events.length >= cap) throw new Error('Attempt history incomplete');
  return runs.map(run => {
    if (!historical.includes(run)) return run;
    const matches = events.map(event => {
      let payload; try { payload = typeof event.payload === 'object' ? event.payload : JSON.parse(event.payload); } catch { throw new Error('Attempt history unreadable'); }
      return { event, payload };
    }).filter(({ payload }) => payload?.runId === run.runId);
    if (!matches.length) return run;
    const valid = matches.every(({ event, payload }) => Number.isSafeInteger(Number(event.seq)) && Number(event.seq) > 0 && Number(event.seq) <= cutoff &&
      /^[a-f0-9]{64}$/i.test(event.entry_hash ?? '') && /^[a-f0-9]{32}$/i.test(event.event_id_hex ?? '') &&
      String(event.issue_id) === run.executionIssueId && event.actor_account_id === run.createdBy && String(payload.testIssueId) === run.testIssueId &&
      payload.versionId === run.testVersionId && payload.testDigest === run.testDigest && payload.chainDigest === run.chainDigest &&
      (!run.creationFingerprint || payload.creationFingerprint === run.creationFingerprint) &&
      (!run.creationEventId || event.event_id_hex.toLowerCase() === run.creationEventId) && contentDigest(payload) === contentDigest(matches[0].payload));
    if (!valid) return run;
    const { event, payload } = matches[0];
    return { ...run, attemptSequence: Number(event.seq), attemptOrderProof: { kind: 'HISTORICAL_CREATION_AUDIT', seq: Number(event.seq),
      entryHash: event.entry_hash, eventId: event.event_id_hex.toLowerCase(), payload, cutoff } };
  });
}
