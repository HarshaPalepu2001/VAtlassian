import { driftedFields } from './interception.js';
import { scopeFromIssue } from './trackedFields.js';

/**
 * WHICH TRACKED FIELDS OF THIS WORK ITEM NO LONGER MATCH ITS ACTIVE BASELINE?
 *
 * The one live answer, shared by the panel (usecases/panelSummary.js) and the
 * validator (lib/approval/runtime.js). The validator holds an item still while
 * this reports a change, and the panel is where that change is decided — so the
 * two must reach the same verdict by construction, or an item is held with
 * nothing on the panel to approve or reject.
 *
 * A TREE baseline — every one a controlled transition captures — keeps its
 * digests on the root node, not on the va_baseline row, which it leaves as
 * '{}'. Comparing against that empty map fails towards drift on every read.
 * If the root node's digests cannot be read, the '{}' fallback still
 * over-reports rather than clearing.
 */
export async function baselineDrift({ baseline, issueId, issueFields, declared, readRootDigests }) {
  if (!baseline) return { changed: [], contentHash: null };
  const baselineDigests = baseline.tree_hash
    ? await Promise.resolve()
      .then(() => readRootDigests(baseline.baseline_id, issueId))
      .catch(() => null) ?? baseline.field_digests
    : baseline.field_digests;
  return driftedFields({ baselineDigests, issueFields,
    controlledFields: scopeFromIssue({ declared, issueFields }).fields });
}
