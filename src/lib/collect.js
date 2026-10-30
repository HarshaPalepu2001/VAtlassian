import api, { route } from '@forge/api';
import { observe, OUTCOME, REVIEW_STATE, isStaleLock } from './interception.js';
import { fetchChangelog, lastTouchByField, highestChangelogId, SOURCE } from './changelog.js';
import { observationColumns } from './observation.js';
import { classify, maxMateriality, MATERIALITY, needsDecision } from './materiality.js';
import { summarise } from './valuestore.js';
import { normaliseField } from './content.js';
import { controlledFields, projectConfig } from '../db/configStore.js';
import { scopeFromIssue } from './trackedFields.js';
import { fieldsForItem } from './tree/nodeFields.js';
import { activeRootsForNode } from '../db/baselineTreeStore.js';
import { activeBaseline, readAllValues } from '../db/baselineStore.js';
import { recordDrift, existingChangelogKeys } from '../db/driftStore.js';
import { getReview, applyObservation, touch, refreshHeader } from '../db/itemStateStore.js';
import { suppressedFields } from '../db/restoreStore.js';
import { voidOthers } from '../db/approvalStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';
import { recordObservation } from '../db/observationStore.js';
import { DETECTED_VIA } from './detectedVia.js';
import { recordScopeMove } from './scopeMove.js';
import { canonicaliseIssue } from './attachmentIdentity.js';
import { collectTree } from './treeCollect.js';
export { DETECTED_VIA };
export { discoverActiveRootsByAncestor, affectedTreeRoots, collectTree, collectAffectedTrees, ownFlatBaseline } from './treeCollect.js';

/**
 * Collect drift through the same function for events and scheduled sweeps.
 *
 * Re-read the issue and compare hashes. Event delivery only triggers the read;
 * its changelog does not supply field values. Changelog content varies by field
 * and may be absent, including reportedly in team-managed projects. Fresh hash
 * comparisons make repeated deliveries idempotent.
 *
 * Read the changelog afterwards to attribute who changed the issue and when.
 */

/**
 * Examine one work item and record changes.
 *
 * @param issueId
 * @param issueKey
 * @param detectedVia
 * @param actorAccountId Event actor, used only when the changelog cannot attribute
 *                       a field.
 * @param now
 *
 * Log errors and return them rather than throw. Throwing would make the platform
 * redeliver a permanently failing trigger indefinitely.
 */
export async function collect({ issueId, issueKey, detectedVia = DETECTED_VIA.EVENT, actorAccountId = null,
  eventId = null, eventAt = null, now = Date.now() }) {
  try {
    return await run({ issueId, issueKey, detectedVia, actorAccountId, eventId, eventAt, now });
  } catch (e) {
    console.error('collect: failed for', issueKey ?? issueId, e);
    return { outcome: 'ERROR', error: String(e?.message ?? e) };
  }
}

async function run({ issueId, issueKey, detectedVia, actorAccountId, eventId, eventAt, now }) {
  const review = await getReview(issueId);

  // Never baselined and not tracked. Nothing to do, and importantly nothing to
  // create: an item that has not cleared review is edited freely and this app
  // has no opinion about it. Tracking begins at the first approval.
  if (!review || review.baseline_id == null) {
    return { outcome: OUTCOME.NO_BASELINE };
  }

  // A decision or restore is in progress. Return before reading Jira to avoid
  // unnecessary requests and partial restore reads. observe() also returns BUSY.
  if ((review.state === REVIEW_STATE.DECIDING || review.state === REVIEW_STATE.RESTORING) && !isStaleLock(review, now)) {
    return { outcome: OUTCOME.BUSY };
  }

  // Read the issue and edit screen. Compare the same screen-scoped fields used
  // by capture.js, not a wider set absent from the baseline.
  const lookupKey = issueKey ?? review.issue_key;
  let issue = await readIssue(lookupKey);
  if (!issue) return { outcome: 'UNREADABLE' };

  const key = issue.key;
  const projectId = Number(issue.fields.project.id);
  const issueTypeId = String(issue.fields.issuetype.id);

  // Do not fetch the whole Jira field catalogue on every update. That earlier
  // read incorrectly treated every available field as configured for tracking.
  const [declared, config, baseline] = await Promise.all([
    // Compare a child with its tree root's fields, as at capture time.
    // See lib/tree/nodeFields.js.
    fieldsForItem({ issueId, projectId, issueTypeId }, { activeRootsForNode, controlledFields }),
    projectConfig(projectId),
    activeBaseline(issueId)
  ]);

  // Route tree baselines to tree comparison. Their root nodes hold the digests;
  // field_digests on the baseline row is '{}', which observe() would report as drift.
  if (baseline?.tree_hash) {
    return collectTree({ rootIssueId: issueId, rootIssueKey: key, detectedVia, actorAccountId,
      eventId, eventAt, now });
  }

  // Share scopeFromIssue() with capture.js and resolvers/panel.js so signing and
  // drift compare the same field set. Unknown scope widens instead of narrowing.
  const { fields } = scopeFromIssue({
    declared, issueFields: issue.fields
  });

  // After recording a project/type move once, use the destination configuration.
  // declared already contains that current scope.
  await recordScopeMove({ issueId, review, projectId, issueTypeId, actorAccountId,
    destinationFieldCount: fields.length });

  // Measure only declared fields. The earlier catalogue-wide scan inserted
  // 306 drift rows for one item and took 142 seconds, mostly comparing unchanged
  // null custom fields.
  
  if (!config.enabled) return { outcome: 'DISABLED' };

  // Nothing declared means nothing to compare. Distinct from NOT_CONTROLLED,
  // which means this item's fields were checked and none had changed.
  if (fields.length === 0) return { outcome: 'NO_TRACKED_FIELDS' };
  if (!baseline) return { outcome: 'ERROR', error: 'BASELINE_UNREADABLE' };

  const linkPolicy = baselineLinkPolicy(baseline);
  issue = await hydrateLinkPolicyIssue(issue, linkPolicy);

  const result = observe({
    prior: review,
    baselineDigests: baseline ? safeParse(baseline.field_digests) : null,
    issueFields: issue.fields,
    controlledFields: fields,
    now, linkPolicy, issue
  });
  // Even an untracked-field update verifies and records the full projection.
  await recordObservation({ issueId, baseline, fields, issueFields: issue.fields,
    eventId, eventAt, actorAccountId, observedAt: now, detectedVia });

  // Keep the denormalised queue header honest. Cheap, and a stale summary on a
  // queue row is the kind of small wrongness that makes people distrust a list.
  if (issue.fields.summary !== review.summary || key !== review.issue_key) {
    await refreshHeader({
      issueId,
      issueKey: key,
      summary: issue.fields.summary ?? '',
      reviewerAccountId: review.reviewer_account_id,
      reviewerName: review.reviewer_name
    });
  }

  switch (result.outcome) {
    case OUTCOME.NOT_CONTROLLED:
    case OUTCOME.BUSY:
      return { outcome: result.outcome };

    case OUTCOME.NO_CHANGE:
      // For events that leave controlled content unchanged, including comments,
      // worklogs and sprint moves, update the timestamp and stop.
      await touch(issueId, now);
      return { outcome: OUTCOME.NO_CHANGE };

    case OUTCOME.SELF_REVERTED:
      await applyObservation({
        issueId,
        expectedVersion: review.version,
        review: result.review,
        counters: { driftCount: 0, driftedFieldCount: 0, maxMateriality: null }
      });
      await tryAppend({
        actorAccountId: actorAccountId ?? 'system',
        eventType: EVENT.DRIFT_SELF_REVERTED,
        issueId,
        payload: { fields: result.changedFields, baselineVersion: review.baseline_version }
      });
      return { outcome: OUTCOME.SELF_REVERTED, fields: result.changedFields };

    case OUTCOME.DRIFT_RECORDED:
      return recordAll({
        issueId, issueKey: key, projectId, issueTypeId,
        review, baseline, fields, config, result, detectedVia, actorAccountId, now,
        issueFields: { ...issue.fields, issuelinks: governedLinks(issue.fields.issuelinks, { linkPolicy, issue }) }
      });

    default:
      return { outcome: result.outcome };
  }
}

/**
 * Compute the provenance columns for one drift observation.
 * Extracted so collectors passing different field values can be tested.
 */
export function observationFor({ changelogId, attribution, failed, truncated, detectedVia, actorAccountId, now }) {
  return observationColumns({ changelogId, attributionAt: attribution?.at ?? null,
    historyComplete: !failed && !truncated, detectedVia, actorAccountId, now });
}

/**
 * Choose the actor recorded on a drift row.
 *
 * A matched history item makes the edit CONFIRMED and uses only that item's
 * author. If Jira omitted the author, record nobody; the event user triggered
 * the check but may not have edited the field. An unmatched change retains the
 * legacy event-user fallback, interpreted as the trigger rather than the editor.
 */
export function actorFor({ changelogId, attribution, actorAccountId }) {
  if (changelogId) {
    return { actor_account_id: attribution?.authorId ?? null, actor_name: attribution?.authorName ?? null };
  }
  return { actor_account_id: attribution?.authorId ?? actorAccountId ?? null, actor_name: attribution?.authorName ?? null };
}

/**
 * Turn an observation into attributed drift rows.
 */
async function recordAll({
  issueId, issueKey, projectId, issueTypeId, review, baseline, fields, config, result,
  detectedVia, actorAccountId, now, issueFields
}) {
  const changed = result.changedFields ?? [];
  const byId = new Map(fields.map((f) => [f.field_id, f]));

  // Read attribution since the baseline, not the last check, so the reviewer
  // can inspect every intervening field edit, including reversals.
  const since = baseline?.transition_at ?? review.last_checked_at ?? 0;
  // `truncated` matters as much as `failed`: Jira's changelog pages oldest
  // first, so a bounded read stops before the NEWEST edits, which are the ones
  // an unmatched observation would need.
  const { entries, failed, truncated } = await fetchChangelog(
    ({ startAt, maxResults }) => api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}/changelog?startAt=${startAt}&maxResults=${maxResults}`
    ),
    { sinceMs: since }
  );
  const touched = failed ? {} : lastTouchByField(entries, changed, since);

  // ── Our own writes ───────────────────────────────────────────────────────
  //
  // A restore produces a changelog entry exactly like a human edit. Without
  // this, the restoration itself is recorded as fresh drift and the reviewer's
  // own reversion lands back in their queue.
  const suppressed = await suppressedFields({
    issueId, digestsByField: result.toDigests ?? {}, now
  });

  // ── Values, for the short human rendering on a queue row ──────────────────
  const baselineValues = baseline
    ? await readAllValues(issueId, baseline.version)
    : {};

  const seen = await existingChangelogKeys(issueId, review.baseline_version);

  const materialities = [];
  // The comparison's own answer, independent of how many rows it produced.
  const driftedNow = [];
  const derivedMaterialities = [];
  let inserted = 0;

  for (const fieldId of changed) {
    const field = byId.get(fieldId);
    if (!field) continue;

    const attribution = touched[fieldId] ?? null;
    const changelogId = attribution?.changelogId ?? null;

    const isOurs = suppressed.has(fieldId);

    const before = field.store_values ? baselineValues[fieldId] : undefined;
    const after = field.store_values ? safeNormalise(field.field_kind, issueFields?.[fieldId]) : undefined;

    const materiality = isOurs
      // Our own restore is a real change to the work item and belongs in the
      // history, but it is not drift and must never queue a review.
      ? MATERIALITY.COSMETIC
      : classify(fieldId, field.materiality, before, after);

    // Classify drift before skipping duplicate evidence rows. The comparison
    // sets counts even when no new row is needed.
    driftedNow.push(fieldId);
    if (needsDecision(materiality)) derivedMaterialities.push(materiality);

    // Already recorded by the other path. The UNIQUE index would reject it
    // anyway; checking first saves a round trip on the reconcile pass, which
    // re-walks entries the events already handled by design.
    if (changelogId && seen.has(`${changelogId}:${fieldId}`)) continue;

    const { inserted: didInsert } = await recordDrift({
      issue_id: issueId,
      project_id: projectId,
      baseline_id: review.baseline_id,
      baseline_version: review.baseline_version,
      field_id: fieldId,
      field_name: field.field_name ?? fieldId,
      from_digest: result.fromDigests?.[fieldId] ?? null,
      to_digest: result.toDigests?.[fieldId] ?? null,
      from_repr: field.store_values ? summarise(before, field.field_kind) : null,
      to_repr: field.store_values ? summarise(after, field.field_kind) : null,
      ...actorFor({ changelogId, attribution, actorAccountId }),
      occurred_at: attribution?.at ?? now,
      changelog_id: changelogId,
      detected_via: detectedVia,
      source: isOurs ? SOURCE.BASELINE : (attribution?.source ?? SOURCE.UNKNOWN),
      materiality,
      ...observationFor({ changelogId, attribution, failed, truncated, detectedVia, actorAccountId, now })
    });

    if (didInsert) {
      inserted++;
      if (needsDecision(materiality)) materialities.push(materiality);
    }
  }

  // Set the queue count from driftedNow, not the number of undecided va_drift rows.
  // Rows can be skipped by the issue/changelog/field dedupe key. Link edits can
  // also arrive as "field":"Link" without fieldId. Counting rows left VJIRA-17
  // at drift_count 0 despite changed content, and later sweeps repeated that error.
  //
  // Keep the rows for attribution evidence. lib/interception.js#driftedFields
  // defines current drift for both the collector and My approvals queue.
  const queueable = driftedNow.length > 0;

  const nextReview = {
    ...result.review,
    // Waiting since the first unrecorded change, not since the latest re-read:
    // a comment on an item already awaiting a decision records nothing new.
    last_drift_at: inserted === 0 && review.state === REVIEW_STATE.DRIFTED && review.last_drift_at != null
      ? review.last_drift_at : result.review.last_drift_at,
    state: queueable ? REVIEW_STATE.DRIFTED : REVIEW_STATE.BASELINED,
    last_drift_by: materialities.length > 0 ? (actorAccountId ?? null) : review.last_drift_by,
    last_changelog_id: failed ? review.last_changelog_id : (highestChangelogId(entries) ?? review.last_changelog_id)
  };

  const applied = await applyObservation({
    issueId,
    expectedVersion: review.version,
    review: nextReview,
    counters: {
      driftCount: driftedNow.length,
      driftedFieldCount: derivedMaterialities.length,
      maxMateriality: derivedMaterialities.length > 0 ? maxMateriality(derivedMaterialities) : null
    }
  });
  if (!applied.updated) return { outcome: 'ERROR', error: 'CONCURRENT_OBSERVATION' };

  // ── Void any live approval ───────────────────────────────────────────────
  //
  // An approval describes a version of the item that no longer exists. Leaving
  // it live would let a reviewer's earlier decision authorise a transition on
  // content they never saw.
  if (queueable) {
    try {
      await voidOthers({ issueId, now });
    } catch (e) {
      console.error('collect: could not void stale decisions', e);
    }
  }

  if (inserted > 0) {
    await tryAppend({
      actorAccountId: actorAccountId ?? 'system',
      eventType: detectedVia === DETECTED_VIA.EVENT ? EVENT.DRIFT_DETECTED : EVENT.DRIFT_RECONCILED,
      issueId,
      payload: {
        fields: changed,
        inserted,
        baselineVersion: review.baseline_version,
        detectedVia
      }
    });
  }

  return {
    outcome: OUTCOME.DRIFT_RECORDED,
    inserted,
    fields: changed,
    casApplied: applied.updated,
    driftCount: driftedNow.length,
    recall: null
  };
}

async function readIssue(issueKey) {
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=*all`);
    if (!res.ok) {
      // 404 is expected if the item was deleted after the event.
      if (res.status !== 404) console.error('collect: issue read failed', issueKey, res.status);
      return null;
    }
    return await canonicaliseIssue(await res.json());
  } catch (e) {
    console.error('collect: issue read threw', issueKey, e);
    return null;
  }
}

/**
 * Read the issue's edit screen. Return null on failure so scopeFromIssue()
 * can fall back to the wider set of fields present on the issue.
 */
async function readEditmeta(issueKey) {
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/editmeta`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('collect: editmeta read failed', issueKey, e);
    return null;
  }
}

async function readJiraFields() {
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/field`);
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    console.error('collect: could not read fields', e);
    return [];
  }
}

function safeNormalise(kind, value) {
  try {
    return normaliseField(kind, value);
  } catch {
    return value ?? null;
  }
}

function safeParse(json) {
  if (json == null) return null;
  if (typeof json === 'object') return json;
  try { return JSON.parse(json); } catch { return null; }
}

// Aggregate (whole-tree) drift collection lives in ./treeCollect.js, and is
// re-exported above so `../lib/collect.js` stays the one stable import path
// for both the single-issue and aggregate-tree collectors. It is a separate
// module rather than more of this file because this file is already at the
// lib/ line ceiling test/resolver-wiring.test.js enforces.
import { baselineLinkPolicy, hydrateLinkPolicyIssue, governedLinks } from './linkPolicy.js';
