import { throwing } from './store.js';
import { toBinaryParam } from '../lib/db.js';
import { project } from '../lib/content.js';
import { canonical, sha256Hex } from '../lib/hash.js';
import { encodeValue } from '../lib/valuestore.js';
import { valueBatches } from './baselineStore.js';

/** Event payloads are wake-ups, not historical values. Record what was READ,
 * separately from the event timestamp, and never claim an intermediate edit
 * that Jira had already overwritten before delivery was captured exactly. */
export function observationPlan({ issueId, baseline, fields, issueFields, eventId, eventAt,
  actorAccountId, observedAt, detectedVia }) {
  const projection = project(issueFields, fields);
  const baselineDigests = typeof baseline.field_digests === 'string'
    ? JSON.parse(baseline.field_digests) : baseline.field_digests;
  const compared = fields.filter(f => Object.hasOwn(baselineDigests ?? {}, f.field_id));
  const matches = compared.length > 0 && compared.every(f => projection.digests[f.field_id] === baselineDigests[f.field_id]);
  const key = sha256Hex(canonical({ issueId, baseline: toBinaryParam(baseline.baseline_id),
    event: eventId || `${detectedVia}:${observedAt}`, hash: projection.contentHash }));
  const chunks = Object.entries(matches ? {} : projection.raw).flatMap(([fieldId, value]) => {
    const { chunks, encoding, rawBytes } = encodeValue(value);
    return chunks.map((data, seq) => [key, fieldId, seq, encoding, rawBytes, data]);
  });
  return { key, issueId, baseline, projection, matches, chunks, eventAt: eventAt ?? null,
    eventId: eventId || null, actorAccountId: actorAccountId ?? null, observedAt, detectedVia };
}

export async function recordObservation(args, query = throwing) {
  const p = observationPlan(args);
  const found = await query('SELECT state FROM va_observation WHERE observation_id = ?', [p.key]);
  if (found[0]?.state === 'COMPLETE') return { observationId: p.key, duplicate: true };
  // Reservations and chunk writes are retryable; COMPLETE is published last.
  await query(`INSERT INTO va_observation (observation_id, issue_id, baseline_id, baseline_version,
    content_hash, field_digests, matches_baseline, event_id, event_at, observed_at, actor_account_id, detected_via, state)
    VALUES (?, ?, FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CAPTURING')
    ON DUPLICATE KEY UPDATE observation_id = observation_id`,
  [p.key, p.issueId, toBinaryParam(p.baseline.baseline_id), p.baseline.version, p.projection.contentHash,
    JSON.stringify(p.projection.digests), p.matches ? 1 : 0, p.eventId?.slice(0, 128) ?? null,
    p.eventAt, p.observedAt, p.actorAccountId, p.detectedVia]);
  for (const batch of valueBatches(p.chunks)) {
    await query(`INSERT INTO va_observation_value (observation_id, field_id, seq, encoding, raw_bytes, data)
      VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?)').join(',')}
      ON DUPLICATE KEY UPDATE data = VALUES(data)`, batch.flat());
  }
  await query("UPDATE va_observation SET state = 'COMPLETE' WHERE observation_id = ? AND state = 'CAPTURING'", [p.key]);
  return { observationId: p.key, matchesBaseline: p.matches };
}
