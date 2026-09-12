import api, { route } from '@forge/api';
import { OUTCOME, REVIEW_STATE } from './interception.js';
import { controlledFields } from '../db/configStore.js';
import { getReview } from '../db/itemStateStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';
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

  const cFields = await controlledFields();
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

  // REPLACE, NEVER APPEND. The whole tree was just re-diffed against the
  // signed baseline, so this call's rows ARE the tree's current drift set.
  // Writing anything less than the full replacement would leave a stale row
  // from an already-fixed node sitting next to fresh ones from a moved one —
  // exactly the double interpretation this collector exists to prevent.
  await replaceTreeDrift(review.baseline_id, driftRows);

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

  return { outcome: OUTCOME.DRIFT_RECORDED, kinds: changes.map(c => c.kind), inserted: changes.length };
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
