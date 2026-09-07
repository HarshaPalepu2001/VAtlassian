/**
 * May a retry continue a signature that was given earlier?
 *
 * THE RULE. A reviewer signed a rejection of a specific candidate, to be
 * returned to a specific baseline. A retry may resume that signature only while
 * the work item is somewhere on the path between those two states — every
 * tracked field holding either the value they rejected or the value they
 * approved. Any third value means somebody edited the item after the signature
 * and the reviewer never saw it, so the signature no longer describes what
 * would be written.
 *
 * WHY NOT JUST RE-HASH. The previous implementation replaced the signed content
 * hash with a hash computed at retry time, which made the comparison vacuous —
 * it compared today's content with itself and always passed. A signature bound
 * to content it does not describe is not a signature.
 *
 * Pure. No I/O, no clock, no database.
 */

export function resumable({ baselineDigests = {}, candidateDigests = {}, currentDigests = {} }) {
  const candidateFields = Object.keys(candidateDigests);
  if (candidateFields.length === 0) {
    // No durable record of what was signed. Refusing is the only honest answer:
    // this restore predates candidate capture, or the row was written by an
    // older version, and a retry would be authorised by nothing.
    return { ok: false, reason: 'NO_SIGNED_CANDIDATE', intruded: [] };
  }

  const intruded = [];
  const tracked = new Set([...Object.keys(baselineDigests), ...candidateFields]);

  for (const fieldId of tracked) {
    const current = Object.prototype.hasOwnProperty.call(currentDigests, fieldId)
      ? currentDigests[fieldId]
      : undefined;
    // A field that vanished from the read is not "unchanged"; it is unknown,
    // and unknown fails closed.
    if (current === undefined) { intruded.push(fieldId); continue; }
    const permitted = [baselineDigests[fieldId], candidateDigests[fieldId]]
      .filter((d) => d !== undefined);
    if (!permitted.includes(current)) intruded.push(fieldId);
  }

  intruded.sort();
  return intruded.length === 0
    ? { ok: true, reason: null, intruded: [] }
    : { ok: false, reason: 'NEW_EVIDENCE_REQUIRES_APPROVAL', intruded };
}
