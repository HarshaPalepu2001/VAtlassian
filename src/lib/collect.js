import api, { route } from '@forge/api';
import { observe, OUTCOME, REVIEW_STATE } from './interception.js';
import { fetchChangelog, lastTouchByField, highestChangelogId, SOURCE } from './changelog.js';
import { classify, maxMateriality, MATERIALITY, shouldQueue } from './materiality.js';
import { summarise } from './valuestore.js';
import { normaliseField } from './content.js';
import { controlledFields, projectConfig, reviewStatusIds } from '../db/configStore.js';
import { scopeFromIssue } from './trackedFields.js';
import { activeBaseline, readAllValues } from '../db/baselineStore.js';
import { recordDrift, existingChangelogKeys } from '../db/driftStore.js';
import { getReview, applyObservation, touch, refreshHeader } from '../db/itemStateStore.js';
import { suppressedFields } from '../db/restoreStore.js';
import { voidOthers } from '../db/approvalStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';
import { recordObservation } from '../db/observationStore.js';
import { DETECTED_VIA } from './detectedVia.js';
export { DETECTED_VIA };
export { discoverActiveRootsByAncestor, affectedTreeRoots, collectTree, collectAffectedTrees } from './treeCollect.js';

/**
 * The drift collector.
 *
 * ONE CODE PATH FOR THE EVENT AND THE SWEEP, and it is the reason drift
 * detection is trustworthy: whatever the reconcile job would conclude, the
 * trigger concludes too, because they are the same function. Two
 * implementations of "has this changed" would eventually disagree, and the
 * disagreement would look like flapping drift that nobody could reproduce.
 *
 * THE PAYLOAD IS A WAKE-UP ONLY. Nothing here trusts the event's changelog for
 * VALUES — it varies by field, is sometimes absent, and is reportedly absent
 * entirely in team-managed projects. The issue is re-read and hashes are
 * compared, which makes this idempotent under redelivery. The changelog is
 * consulted afterwards, for ATTRIBUTION, which is the one thing it is exact
 * about.
 */

/**
 * Examine one work item and record whatever changed.
 *
 * @param issueId
 * @param issueKey
 * @param detectedVia
 * @param actorAccountId  from the event, when there is one. Used only as a
 *                        fallback where the changelog cannot attribute a field.
 * @param now
 *
 * NEVER THROWS. A trigger that throws is retried by the platform, and a
 * permanently failing item would be retried forever. Errors are logged and
 * reported in the return value so the caller can count them.
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

  // A decision or restore is in flight. observe() would return BUSY anyway, but
  // returning here avoids reading the issue at all — and during a restore that
  const isStaleLock = review.last_checked_at != null && now != null && (Number(now) - Number(review.last_checked_at) > 60000);
  if ((review.state === REVIEW_STATE.DECIDING || review.state === REVIEW_STATE.RESTORING) && !isStaleLock) {
    return { outcome: OUTCOME.BUSY };
  }

  // The issue AND its edit screen. The screen is the scope basis — capture.js
  // took this baseline over the screen-scoped set, so measuring drift over a
  // wider one compares the approved state against fields it never recorded.
  const lookupKey = issueKey ?? review.issue_key;
  const issue = await readIssue(lookupKey);
  if (!issue) return { outcome: 'UNREADABLE' };

  const key = issue.key;
  const projectId = Number(issue.fields.project.id);
  const issueTypeId = String(issue.fields.issuetype.id);
  const currentStatusId = String(issue.fields.status?.id ?? '');

  // readJiraFields() is gone from this path deliberately. It was fetched only to
  // be expanded into "every field Jira has" — a full field-catalogue read on
  // every issue update, to produce a tracked set nobody asked for.
  const [declared, config, reviewStatuses, baseline] = await Promise.all([
    controlledFields({ projectId, issueTypeId }),
    projectConfig(projectId),
    reviewStatusIds(projectId),
    activeBaseline(issueId)
  ]);

  // ONE DEFINITION OF SCOPE, shared with capture.js and resolvers/panel.js.
  // These three used to hold three copies of this filter, which is how the set
  // a reviewer's signature covered and the set drift was measured over came to
  // disagree. See scopeFromIssue() for why an unknown scope widens rather than
  // narrows.
  const { fields } = scopeFromIssue({
    declared, issueFields: issue.fields
  });

  // DRIFT IS MEASURED OVER THE DECLARED SET, NOT OVER EVERY FIELD JIRA HAS.
  //
  // This built its field list from the whole Jira field catalogue, so a sweep
  // over ONE work item inserted 306 drift rows and took 142 seconds — most of
  // which was iterating the 280 unchanging custom fields to verify that
  // baseline[null] === issue[null].
  //
  // The declared set is now the only authority.
  
  if (!config.enabled) return { outcome: 'DISABLED' };

  // Nothing declared means nothing to compare. Distinct from NOT_CONTROLLED,
  // which means this item's fields were checked and none had changed.
  if (fields.length === 0) return { outcome: 'NO_TRACKED_FIELDS' };
  if (!baseline) return { outcome: 'ERROR', error: 'BASELINE_UNREADABLE' };

  const result = observe({
    prior: review,
    baselineDigests: baseline ? safeParse(baseline.field_digests) : null,
    issueFields: issue.fields,
    controlledFields: fields,
    reviewStatusIds: reviewStatuses,
    currentStatusId,
    now
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
      // The overwhelmingly common case — an event fired for a comment, a
      // worklog, a sprint move. Touch the timestamp and stop.
      await touch(issueId, now);
      return { outcome: OUTCOME.NO_CHANGE };

    case OUTCOME.BASELINE_DISARMED:
      await applyObservation({
        issueId,
        expectedVersion: review.version,
        review: result.review,
        counters: { driftCount: 0, driftedFieldCount: 0, maxMateriality: null }
      });
      await tryAppend({
        actorAccountId: actorAccountId ?? 'system',
        eventType: EVENT.BASELINE_DISARMED,
        issueId,
        payload: { reason: 'RE_ENTERED_REVIEW', statusId: currentStatusId, baselineVersion: review.baseline_version }
      });
      return { outcome: OUTCOME.BASELINE_DISARMED };

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
        issueFields: issue.fields
      });

    default:
      return { outcome: result.outcome };
  }
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

  // ── Attribution ──────────────────────────────────────────────────────────
  //
  // The changelog is read since the BASELINE, not since the last check, because
  // a field may have been touched several times and the reviewer needs the
  // whole sequence — "raised, lowered by automation, raised again" is a
  // different story from "raised".
  const since = baseline?.transition_at ?? review.last_checked_at ?? 0;
  const { entries, failed } = await fetchChangelog(
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

    // CLASSIFIED BEFORE THE DEDUPE SKIP, because this field HAS drifted whether
    // or not a row gets written for it. The counters below are the comparison's
    // answer; the rows are its evidence trail.
    driftedNow.push(fieldId);
    if (shouldQueue(materiality, config.queueThreshold)) derivedMaterialities.push(materiality);

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
      actor_account_id: attribution?.authorId ?? actorAccountId ?? null,
      actor_name: attribution?.authorName ?? null,
      occurred_at: attribution?.at ?? now,
      changelog_id: changelogId,
      detected_via: detectedVia,
      source: isOurs ? SOURCE.BASELINE : (attribution?.source ?? SOURCE.UNKNOWN),
      materiality
    });

    if (didInsert) {
      inserted++;
      if (shouldQueue(materiality, config.queueThreshold)) materialities.push(materiality);
    }
  }

  // ── Update the queue row ─────────────────────────────────────────────────
  //
  // THE COUNTER IS THE COMPARISON'S ANSWER, NOT THE ROW COUNT.
  //
  // This read driftSummary(), which counts undecided va_drift ROWS — so any
  // field whose row was skipped understated it. A row is skipped whenever the
  // dedupe key (issue_id, changelog_id, field_id) already exists, and Jira does
  // not give every change an attributable changelog entry: a link edit arrives
  // as `"field":"Link"` with no fieldId at all. VJIRA-17 sat at drift_count 0
  // with content that had plainly moved, and no sweep could ever fix it,
  // because every later pass skipped the same row and recounted the same zero.
  //
  // `driftedNow` is what the digest comparison actually found. The rows remain
  // the evidence — who changed what, when — but they no longer decide how much
  // drift there is. lib/interception.js's driftedFields() is the one authority,
  // and this makes the stored counter agree with it by construction, which is
  // what the My approvals queue and the collector both read.
  const queueable = driftedNow.length > 0;

  const nextReview = {
    ...result.review,
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
      // 404 is normal — the item was deleted between the event and this read.
      if (res.status !== 404) console.error('collect: issue read failed', issueKey, res.status);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error('collect: issue read threw', issueKey, e);
    return null;
  }
}

/**
 * The issue's edit screen. Returns null rather than throwing — scopeFromIssue()
 * falls back to the issue's own field set, which is wider and therefore safe.
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
