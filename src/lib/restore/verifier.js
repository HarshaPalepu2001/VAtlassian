import { route } from '@forge/api';
import { project, digestsEquivalent } from '../content.js';
import { OUTCOME } from './executor.js';
import { canonicaliseIssue, danglingMediaPointers } from '../attachmentIdentity.js';
import { identityRecords } from '../../db/vaultStore.js';
import { hydrateLinkPolicyIssue } from '../linkPolicy.js';

/**
 * Re-read restored fields and compare their content.js digests with the
 * baseline. A successful Jira response confirms acceptance, not the final
 * stored value. Coercion, screen rules, validators and post-functions may
 * change the result. Only this verification pass marks fields verified.
 */

/**
 * Re-read and verify every field outcome against approved digests.
 * If the read fails, leave all written fields unverified and failed.
 *
 * @param api
 * @param issueKey
 * @param controlledFields
 * @param baselineDigests   { fieldId: digest } from the baseline
 * @param detail            per-field outcomes from executeRestore
 * @returns detail with verified set on every entry
 */
export async function verifyRestore({ api, issueKey, controlledFields, baselineDigests, detail, expectedStatusId = null,
  readIdentity = identityRecords, linkPolicy = null }) {
  let current, currentStatusId, raw, issueId;
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=*all`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const read = await res.json();
    // Kept as Jira holds it: canonicalisation below builds new objects rather
    // than changing these, and a broken image is only visible here.
    raw = read?.fields ?? {};
    issueId = read?.id;
    // Read under canonical attachment ids: a file this restore re-uploaded is
    // confirmed as the approved original only once its alias is recorded,
    // which happens after its bytes matched the vault's hash.
    const body = await canonicaliseIssue(read, { read: readIdentity });
    const hydrated = await hydrateLinkPolicyIssue(body, linkPolicy, async ref => {
      const response = await api.asApp().requestJira(route`/rest/api/3/issue/${ref}?fields=project,issuetype`);
      if (!response.ok) throw new Error('Linked work item could not be checked');
      return response.json();
    });
    current = hydrated.fields ?? {};
    currentStatusId = current.status?.id == null ? null : String(current.status.id);
  } catch (e) {
    console.error('restore: verification read failed', issueKey, e);
    // Mark unread fields unverified. The unmatched sentinel prevents tally()
    // from declaring COMPLETE when the verification read failed.
    return {
      detail: detail.map((d) => (
        d.outcome === OUTCOME.SUCCEEDED
          ? {
              ...d, outcome: OUTCOME.FAILED, verified: false,
              reason: 'The work item could not be re-read, so this restore could not be confirmed. No failure was confirmed, but no result was verified.'
            }
          : { ...d, verified: false }
      )),
      unmatched: [{ fieldId: null, fieldName: 'the work item', expected: null, actual: null,
        reason: 'The work item could not be re-read, so no field could be confirmed.' }]
    };
  }

  const { digests } = project(current, controlledFields, { linkPolicy, issue: { id: issueId, fields: current } });

  const verified = detail.map((d) => {
    if (d.outcome !== OUTCOME.SUCCEEDED) return { ...d, verified: false };

    const expected = baselineDigests?.[d.fieldId] ?? null;
    const actual = Object.hasOwn(current, d.fieldId) && current[d.fieldId] !== undefined
      ? digests?.[d.fieldId] ?? null : null;
    if (expected != null && digestsEquivalent(d.fieldId, actual, expected)) return { ...d, verified: true };

    return {
      ...d, outcome: OUTCOME.FAILED, verified: false,
      reason: expected == null
        ? 'No approved digest was recorded for this field, so the restore cannot be confirmed.'
        : 'Jira accepted the write but the field does not match the approved value. A screen configuration or a workflow post-function may be overriding it.'
    };
  });

  // Verify all tracked fields, including unwritten fields that a concurrent
  // edit or workflow post-function may have changed.
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
    if (expected != null && present && digestsEquivalent(fieldId, actual, expected)) continue;
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

  // Canonical digests treat restored copies as originals. Also check media
  // pointers so text cannot pass verification while referencing a deleted file.
  for (const entry of await brokenImages({ raw, issueId, byId, readIdentity })) {
    if (unmatched.some(u => u.fieldId === entry.fieldId)) continue;
    unmatched.push(entry);
    const written = verified.find(d => d.fieldId === entry.fieldId && d.verified);
    if (written) Object.assign(written, { outcome: OUTCOME.FAILED, verified: false, reason: entry.reason });
  }

  return { detail: verified, unmatched };
}

async function brokenImages({ raw, issueId, byId, readIdentity }) {
  const tracked = Object.fromEntries(Object.entries(raw ?? {}).filter(([fieldId]) => byId.has(fieldId)));
  if (!Object.values(tracked).some(v => v && typeof v === 'object' && v.type === 'doc')) return [];
  const live = new Set((Array.isArray(raw?.attachment) ? raw.attachment : []).map(a => String(a?.id ?? '')));
  let record = null;
  try {
    record = (await readIdentity([issueId])).get(Number(issueId)) ?? null;
  } catch (e) {
    // The digests above still stand; this extra check is skipped, not faked.
    console.error('restore: could not read restored copies to check rich-text images', e);
    return [];
  }
  const seen = new Set();
  return danglingMediaPointers(tracked, record, live).filter(d => !seen.has(d.fieldId) && seen.add(d.fieldId))
    .map(d => ({ fieldId: d.fieldId, fieldName: byId.get(d.fieldId)?.field_name ?? d.fieldId, expected: null, actual: null,
      reason: 'This text shows a file that is no longer on the work item, so its image does not display.' }));
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
