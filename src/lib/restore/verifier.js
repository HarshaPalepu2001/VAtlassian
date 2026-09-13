import { route } from '@forge/api';
import { project } from '../content.js';
import { OUTCOME } from './executor.js';

/**
 * Proving the restore worked.
 *
 * WHY THIS EXISTS AS A SEPARATE PASS. A 204 from Jira means the request was
 * accepted, which is not the same as the field now holding the value we sent.
 * Values get coerced, screens silently drop fields they do not carry, workflow
 * post-functions overwrite things a moment later, and a custom field with a
 * validator can reject a value while the surrounding request succeeds.
 *
 * So the executor never marks anything verified, and this module is the only
 * thing that can. It re-reads the issue and compares digests — the same digests
 * content.js computes everywhere else, so "restored" means exactly what
 * "unchanged since approval" means, computed the same way. Anything else would
 * be two definitions of correct.
 */

/**
 * Re-read and confirm.
 *
 * @param api
 * @param issueKey
 * @param controlledFields
 * @param baselineDigests   { fieldId: digest } from the baseline
 * @param detail            per-field outcomes from executeRestore
 *
 * @returns detail, with `verified` set truthfully on every entry.
 *
 * A FAILED VERIFICATION READ DOWNGRADES EVERYTHING. If the issue cannot be
 * re-read, nothing can be claimed, so every field that was written is reported
 * unverified and therefore failed. That is deliberately pessimistic: an
 * unverifiable restore reported as complete is the one outcome this whole
 * module exists to prevent, and "we could not confirm" is a fine thing to tell
 * a reviewer.
 */
export async function verifyRestore({ api, issueKey, controlledFields, baselineDigests, detail, expectedStatusId = null }) {
  let current, currentStatusId;
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=*all`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    current = body.fields ?? {};
    currentStatusId = current.status?.id == null ? null : String(current.status.id);
  } catch (e) {
    console.error('restore: verification read failed', issueKey, e);
    // Deliberately pessimistic. An unverifiable restore reported as complete is
    // the one outcome this module exists to prevent. `unmatched` carries a
    // sentinel so tally() cannot reach COMPLETE on an unread issue either.
    return {
      detail: detail.map((d) => (
        d.outcome === OUTCOME.SUCCEEDED
          ? {
              ...d, outcome: OUTCOME.FAILED, verified: false,
              reason: 'The work item could not be re-read, so this restore could not be confirmed. Nothing is known to have failed — but nothing is confirmed either.'
            }
          : { ...d, verified: false }
      )),
      unmatched: [{ fieldId: null, fieldName: 'the work item', expected: null, actual: null,
        reason: 'The work item could not be re-read, so no field could be confirmed.' }]
    };
  }

  const { digests } = project(current, controlledFields);

  const verified = detail.map((d) => {
    if (d.outcome !== OUTCOME.SUCCEEDED) return { ...d, verified: false };

    const expected = baselineDigests?.[d.fieldId] ?? null;
    const actual = Object.hasOwn(current, d.fieldId) && current[d.fieldId] !== undefined
      ? digests?.[d.fieldId] ?? null : null;
    if (expected != null && actual === expected) return { ...d, verified: true };

    return {
      ...d, outcome: OUTCOME.FAILED, verified: false,
      reason: expected == null
        ? 'No approved digest was recorded for this field, so the restore cannot be confirmed.'
        : 'Jira accepted the write but the field does not match the approved value. A screen configuration or a workflow post-function may be overriding it.'
    };
  });

  // ── The whole tracked projection, not just what we tried to write ─────────
  //
  // A field this restore never touched can still be wrong: a post-function or
  // a concurrent edit can change it between the plan and the re-read. Checking
  // only attempted writes is how "restore complete" came to mean "every write
  // we attempted landed", which is a different and much weaker claim.
  const byId = new Map(controlledFields.map((f) => [f.field_id, f]));
  const unmatched = [];
  if (expectedStatusId != null && currentStatusId !== String(expectedStatusId)) {
    unmatched.push({
      fieldId: 'status',
      fieldName: 'Status',
      expected: String(expectedStatusId),
      actual: currentStatusId,
      reason: 'The work item is no longer in the baseline review status, so restoration cannot be confirmed.'
    });
  }
  for (const [fieldId, field] of byId) {
    const expected = baselineDigests?.[fieldId] ?? null;
    const present = Object.hasOwn(current, fieldId) && current[fieldId] !== undefined;
    const actual = present ? digests?.[fieldId] ?? null : null;
    if (expected != null && present && actual === expected) continue;
    unmatched.push({
      fieldId,
      fieldName: field.field_name ?? fieldId,
      expected,
      actual,
      reason: expected == null ? 'No approved digest was recorded for this tracked field, so it cannot be confirmed.'
        : !present ? 'Jira omitted this tracked field from the verification read, so its value cannot be confirmed.'
          : 'This tracked field does not match its approved value after the restore.'
    });
  }

  return { detail: verified, unmatched };
}

/**
 * The sentence the reviewer reads when it is over.
 *
 * Written to be plain about a partial result rather than upbeat about the part
 * that worked. "Restored 11 of 14 fields" is the honest headline; "Restore
 * complete" with a footnote is not.
 */
export function describeResult({ counters, state }) {
  if (state === 'COMPLETE_WITH_REPLACEMENTS') {
    return 'Restored with replacements. All controlled content and relationships match the approved baseline; recreated work items now have new Jira identities.';
  }
  if (state === 'COMPLETE') {
    return counters.succeeded === 1
      ? 'Restored. 1 field is back to its approved value.'
      : `Restored. All ${counters.succeeded} fields are back to their approved values.`;
  }

  const parts = [];
  if (counters.succeeded > 0) parts.push(`${counters.succeeded} restored`);
  if (counters.failed > 0) parts.push(`${counters.failed} could not be restored`);
  if (counters.irreversible > 0) parts.push(`${counters.irreversible} cannot be undone in Jira`);
  if (counters.skipped > 0) parts.push(`${counters.skipped} left for you to correct`);

  if (counters.unmatched > 0) {
    parts.push(`${counters.unmatched} tracked field${counters.unmatched === 1 ? ' still does' : 's still do'} not match the approved values`);
  }

  if (state === 'FAILED') {
    return `Nothing was restored. ${parts.join(', ')}. The details below say why for each field.`;
  }
  return `Partly restored: ${parts.join(', ')}. The details below say why for each field.`;
}

/**
 * Which fields are still wrong, so the panel can offer "retry these".
 *
 * A retry is safe to offer because restores are absolute writes rather than
 * deltas: re-running one is idempotent, and re-running a partially applied one
 * simply reapplies the fields that did not take.
 */
export function retryableFields(detail) {
  return detail
    .filter((d) => d.outcome === OUTCOME.FAILED)
    .map((d) => d.fieldId);
}
