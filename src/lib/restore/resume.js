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

import { isStructuralField } from '../tree/structure.js';

/**
 * The digests a retry may compare.
 *
 * `parent` and `subtasks` carry Jira-assigned ids that the tree model owns and
 * that a restore legitimately changes (see lib/tree/structure.js). Comparing
 * them here would report a correct restore as an outside edit and refuse the
 * retry — the same mistake, in a second place.
 */
export function comparableDigests(digests) {
  return Object.fromEntries(
    Object.entries(digests ?? {}).filter(([fieldId]) => !isStructuralField(fieldId))
  );
}

/**
 * The approved digests to resume AGAINST.
 *
 * ─── WHY THIS IS NOT JUST `baseline.field_digests` ───────────────────────────
 *
 * A tree baseline keeps its digests per node, in va_baseline_node.field_digests;
 * va_baseline.field_digests is written as the literal string '{}' (see
 * lib/capture.js). Reading it here handed resumable() an EMPTY approved set,
 * while the candidate and current sets were full root projections. The approved
 * value was therefore never in the permitted pair, so every field a restore had
 * successfully put back read as an intrusion, and the check returned
 * NEW_EVIDENCE_REQUIRES_APPROVAL.
 *
 * The visible consequence: after a partial restore the panel offers "Retry
 * restore", the retry is refused as needing a fresh approval, and the fresh
 * approval is refused because the work item no longer matches the evidence the
 * reviewer signed. A dead end reachable only by the app's own failure — which
 * is exactly when a retry has to work.
 *
 * All three sides of the comparison must be computed over the same node and the
 * same fields. The root is the node the candidate and current projections are
 * taken from, so the root's approved digests are what belong here.
 */
export function approvedDigestsFor({ baseline, baselineTree, issueId }) {
  if (baseline?.tree_hash) {
    const nodes = baselineTree?.nodes ?? [];
    const root = nodes.find(node => Number(node.originalIssueId) === Number(issueId))
      ?? nodes.find(node => (node.parentLogicalNodeId ?? node.parentLogicalId) == null);
    return root?.digests ?? {};
  }
  const stored = baseline?.field_digests;
  if (typeof stored === 'string') {
    try { return JSON.parse(stored); } catch { return {}; }
  }
  return stored ?? {};
}

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
