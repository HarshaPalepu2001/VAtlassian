/**
 * Decide whether a restore retry can use an earlier rejection signature.
 *
 * The signature binds a rejected candidate and a target baseline. A retry can
 * continue only while every tracked field matches either its rejected value
 * or its approved value. A third value indicates a later edit the signer did
 * not review, so the signature no longer authorizes that write.
 *
 * Do not replace the signed content hash with a retry-time hash. The previous
 * implementation did that and compared current content to itself, always
 * passing the check.
 *
 * These functions perform no I/O and use no clock or database.
 */

import { isStructuralField } from '../tree/structure.js';

/**
 * Exclude parent and subtasks digests. The tree model owns these Jira ids,
 * and restoration may change them without changing approved content.
 * See lib/tree/structure.js.
 */
export function comparableDigests(digests) {
  return Object.fromEntries(
    Object.entries(digests ?? {}).filter(([fieldId]) => !isStructuralField(fieldId))
  );
}

/**
 * Read the approved root digests from va_baseline_node for tree baselines.
 * Their va_baseline.field_digests contains '{}', which would reject restored
 * values as NEW_EVIDENCE_REQUIRES_APPROVAL. Candidate, current and approved
 * digests must cover the same root node and tracked fields.
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
