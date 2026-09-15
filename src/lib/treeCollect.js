import api, { route } from '@forge/api';
import { OUTCOME, REVIEW_STATE } from './interception.js';
import { controlledFields } from '../db/configStore.js';
import { getReview, applyObservation } from '../db/itemStateStore.js';
import { activeBaseline } from '../db/baselineStore.js';
import { voidOthers } from '../db/approvalStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';
import { baselinePolicy } from './baselinePolicy.js';
import { recallToReview } from './restore/recall.js';
import { activeRootsForNode, readBaselineTree } from '../db/baselineTreeStore.js';
import { replaceTreeDrift } from '../db/treeDriftStore.js';
import { createTreeReader } from './tree/jira.js';
import { readStableTree } from './tree/stableRead.js';
import { planTreeCapture } from './tree/capturePlan.js';
import { diffTree } from './tree/diff.js';
import { eventTime } from '../triggers/retry.js';
import { DETECTED_VIA } from './detectedVia.js';

/**
 * Aggregate tree drift.
 *
 * A node event (create/update/delete) firing on ANY issue inside a governed
 * tree wakes the WHOLE tree's collector, never just the node that fired.
 * Measuring the touched node in isolation cannot see a removed sibling or a
 * newly attached child, and a second, root-only reading of the same event
 * would produce a second, independently-arrived-at verdict about the same
 * tree — which is exactly the kind of disagreement one aggregate diff exists
 * to make impossible.
 */

/**
 * Walk the native Jira parent chain until an already-indexed active governed
 * root is found.
 *
 * Used only when the node itself is not yet in any baseline's node index —
 * i.e. it was created after its tree was captured, so no baseline row names
 * it yet.
 */
export async function discoverActiveRootsByAncestor({ issueId, issueKey, parentIssueId }) {
  let currentId = parentIssueId;
  const visited = new Set([String(issueId)]);
  if (currentId) visited.add(String(currentId));

  while (currentId) {
    const roots = await activeRootsForNode(Number(currentId));
    if (roots.length > 0) return roots;

    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${currentId}?fields=parent`);
    if (res.status >= 300) break;
    const data = await res.json();
    const parentId = data.fields?.parent?.id;
    if (!parentId || visited.has(String(parentId))) break;
    currentId = parentId;
    visited.add(String(currentId));
  }
  return [];
}

/**
 * Every active governed root a node event could affect.
 *
 * INDEXED FIRST: a node already captured in some baseline's node index
 * answers from that index alone — this covers updates and deletions of
 * anything the baseline already knows about, including the root itself.
 *
 * ANCESTOR WALK SECOND, and only when the index came back empty. That is the
 * signature of a node created after its tree was baselined: the current
 * native parent chain is the only way left to find which governed root (if
 * any) it now belongs under.
 */
export async function affectedTreeRoots({ issueId, issueKey, parentIssueId }) {
  const indexed = await activeRootsForNode(Number(issueId));
  if (indexed.length) return indexed;
  return discoverActiveRootsByAncestor
    ? discoverActiveRootsByAncestor({ issueId, issueKey, parentIssueId })
    : [];
}

/** Pull the identity a tree lookup needs out of a raw Forge issue event. */
function eventIdentity(event) {
  return {
    issueId: event?.issue?.id,
    issueKey: event?.issue?.key,
    parentIssueId: event?.issue?.fields?.parent?.id ?? null,
    eventType: event?.eventType ?? event?.type ?? null
  };
}

/**
 * Recompute one governed tree end to end and replace its drift set.
 *
 * THE PAYLOAD IS A WAKE-UP ONLY, exactly like collect() in lib/collect.js:
 * the tree is re-read in full and diffed against the signed baseline, never
 * trusted from the event that woke it. That is what makes repeated and
 * out-of-order child events converge on the same result instead of racing to
 * append conflicting readings.
 *
 * NO BASELINE, NOTHING WRITTEN. A root that was never captured, or whose
 * capture never reached ACTIVE, has nothing to compare against — recording
 * "drift" against a baseline that does not exist would be inventing
 * evidence, not reporting it.
 */
export async function collectTree({ rootIssueId, rootIssueKey, detectedVia = DETECTED_VIA.EVENT,
  actorAccountId = null, eventId = null, eventAt = null, now = Date.now() }) {
  const review = await getReview(rootIssueId);
  if (!review || review.baseline_id == null) {
    return { outcome: OUTCOME.NO_BASELINE };
  }

  const isStaleLock = review.last_checked_at != null && now != null && (Number(now) - Number(review.last_checked_at) > 60000);
  if ((review.state === REVIEW_STATE.DECIDING || review.state === REVIEW_STATE.RESTORING) && !isStaleLock) {
    return { outcome: OUTCOME.BUSY };
  }

  // The baseline was captured for this exact project/type scope. Reusing the
  // scope from its queue index keeps tree drift on the same tracked field set;
  // an unscoped lookup silently misses custom fields and makes edits invisible.
  const cFields = await controlledFields({
    projectId: Number(review.project_id),
    issueTypeId: String(review.issue_type_id)
  });
  const fieldIds = cFields.map(f => f.field_id);

  const reader = createTreeReader({ api, route });
  let currentTree;
  try {
    const res = await readStableTree({ readTree: reader.read.bind(reader), rootIssueKey, fieldIds });
    currentTree = res.tree;
  } catch (e) {
    return { outcome: 'ERROR', error: e.message };
  }

  const baselineTree = await readBaselineTree(review.baseline_id);
  const currentStatusId = String(currentTree.nodes?.[0]?.fields?.status?.id ?? '');
  const plannedCurrentTree = planTreeCapture({ rootIssueId, nodes: currentTree.nodes, controlledFields: cFields });

  const { changes } = diffTree({ baselineTree, currentTree: plannedCurrentTree, controlledFields: cFields });

  if (changes.length === 0) return { outcome: OUTCOME.NO_CHANGE };

  const driftRows = changes.map(c => ({
    logicalNodeId: c.logicalNodeId,
    fieldId: c.kind,
    fieldName: null,
    baselineDigest: null,
    currentDigest: null,
    materiality: 'MAJOR',
    detectedAt: now
  }));

  // The durable queue counters use the same reviewer-facing unit as the diff:
  // one changed field, or one structural tree change when no field list exists.
  // The tree drift table remains one row per changed node/category for durable
  // reconciliation, but the panel must not compare that node count with a
  // field-level detail list.
  const reviewChangeCount = changes.reduce((count, change) => count
    + (change.kind === 'FIELD_CHANGED' ? Math.max(1, change.fields?.length ?? 0) : 1), 0);

  // REPLACE, NEVER APPEND. The whole tree was just re-diffed against the
  // signed baseline, so this call's rows ARE the tree's current drift set.
  // Writing anything less than the full replacement would leave a stale row
  // from an already-fixed node sitting next to fresh ones from a moved one —
  // exactly the double interpretation this collector exists to prevent.
  await replaceTreeDrift(review.baseline_id, driftRows);

  // The tree drift table is the detailed evidence; va_item_state is the
  // queue/glance index. Both must move together or the panel says BASELINED
  // while the tree already has a real difference. The CAS keeps concurrent
  // Jira update deliveries from losing the state transition.
  const applied = await applyObservation({
    issueId: rootIssueId,
    expectedVersion: review.version,
    review: {
      ...review,
      state: REVIEW_STATE.DRIFTED,
      last_drift_at: now,
      last_drift_by: actorAccountId ?? null,
      last_checked_at: now
    },
    counters: {
      driftCount: reviewChangeCount,
      driftedFieldCount: reviewChangeCount,
      maxMateriality: 'MAJOR'
    }
  });
  if (!applied?.updated) return { outcome: 'ERROR', error: 'CONCURRENT_OBSERVATION' };

  // Any approval for the prior signed content is now unusable. Voiding it is
  // deliberately best effort: the drift row and DRIFTED queue state are the
  // authoritative evidence, and a retry must not duplicate them.
  try {
    await voidOthers({ issueId: rootIssueId });
  } catch {
    console.error('tree: could not void stale decisions', JSON.stringify({ issueKey: rootIssueKey }));
  }

  // Put the item back behind the exact review status recorded by its latest
  // active baseline. This is the same recall contract as flat-field drift:
  // reject restores that baseline, approve cuts a new snapshot.
  let recall = null;
  try {
    const baseline = await activeBaseline(rootIssueId);
    const policy = baselinePolicy(baseline);
    recall = await recallToReview({
      issueId: rootIssueId,
      issueKey: rootIssueKey,
      projectId: Number(review.project_id),
      issueTypeId: String(review.issue_type_id),
      currentStatusId,
      baselineId: baselineIdHex(policy.baselineId),
      baselineVersion: policy.version,
      reviewStatusId: policy.reviewStatusId,
      driftCount: reviewChangeCount,
      now
    });
  } catch {
    // The drift evidence remains valid if automatic recall cannot run. The
    // item stays DRIFTED and the administrator can resolve the workflow route.
    console.error('tree: drift recall failed', JSON.stringify({ issueKey: rootIssueKey }));
  }

  await tryAppend({
    actorAccountId: actorAccountId ?? 'system',
    eventType: detectedVia === DETECTED_VIA.EVENT ? EVENT.DRIFT_DETECTED : EVENT.DRIFT_RECONCILED,
    issueId: rootIssueId,
    payload: {
      scope: 'TREE',
      kinds: changes.map(c => c.kind),
      nodeCount: changes.length,
      baselineVersion: review.baseline_version,
      eventId,
      eventAt,
      detectedVia
    }
  });

  return { outcome: OUTCOME.DRIFT_RECORDED, kinds: changes.map(c => c.kind), inserted: changes.length,
    recall: recall?.action ?? null };
}

function baselineIdHex(value) {
  return Buffer.isBuffer(value) ? value.toString('hex') : String(value ?? '');
}

/**
 * Fan a single node event out to every governed root it could affect, and run
 * the aggregate collector once per root.
 */
export async function collectAffectedTrees(event, deps = { affectedTreeRoots, collectTree }) {
  const roots = await deps.affectedTreeRoots(eventIdentity(event));
  return Promise.all(roots.map(root => deps.collectTree({
    rootIssueId: root.rootIssueId,
    rootIssueKey: root.rootIssueKey,
    detectedVia: DETECTED_VIA.EVENT,
    eventId: event?.eventId ?? event?.id ?? '',
    eventAt: eventTime(event),
    now: Date.now()
  })));
}
