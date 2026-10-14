import api, { route } from '@forge/api';
import { OUTCOME, REVIEW_STATE, isStaleLock } from './interception.js';
import { controlledFields } from '../db/configStore.js';
import { getReview, applyObservation, touch } from '../db/itemStateStore.js';
import { voidOthers } from '../db/approvalStore.js';
import { tryAppend } from '../db/store.js';
import { EVENT } from './ledger.js';
import { activeRootsForNode, readBaselineTree } from '../db/baselineTreeStore.js';
import { replaceTreeDrift, readTreeDrift } from '../db/treeDriftStore.js';
import { sha256Hex } from './hash.js';
import { createTreeReader } from './tree/jira.js';
import { readStableTree } from './tree/stableRead.js';
import { planTreeCapture } from './tree/capturePlan.js';
import { diffTree } from './tree/diff.js';
import { readTreeWithNodeFields } from './tree/nodeFields.js';
import { logicalNodeId } from './tree/model.js';
import { ownedChildBaselines } from './tree/childBaselines.js';
import { activeBaseline, activeBaselines } from '../db/baselineStore.js';
import { eventTime } from '../triggers/retry.js';
import { DETECTED_VIA } from './detectedVia.js';
import { recordScopeMove } from './scopeMove.js';

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
  actorAccountId = null, eventId = null, eventAt = null, now = Date.now(), scopeFollowed = false }) {
  const review = await getReview(rootIssueId);
  if (!review || review.baseline_id == null) {
    return { outcome: OUTCOME.NO_BASELINE };
  }

  if ((review.state === REVIEW_STATE.DECIDING || review.state === REVIEW_STATE.RESTORING) && !isStaleLock(review, now)) {
    return { outcome: OUTCOME.BUSY };
  }

  // The baseline was captured for this exact project/type scope. Reusing the
  // scope from its queue index keeps tree drift on the same tracked field set;
  // an unscoped lookup silently misses custom fields and makes edits invisible.
  const cFields = await controlledFields({
    projectId: Number(review.project_id),
    issueTypeId: String(review.issue_type_id)
  });
  const reader = createTreeReader({ api, route });
  let currentTree, fieldsFor;
  try {
    ({ tree: currentTree, fieldsFor } = await readTreeWithNodeFields({ readStableTree,
      readTree: reader.read.bind(reader), rootIssueKey, rootFields: cFields }));
  } catch (e) {
    return { outcome: 'ERROR', error: e.message };
  }

  // MOVED TO ANOTHER PROJECT OR ISSUE TYPE. The item now follows the
  // destination's configuration (lib/scopeMove.js). The tree was just read with
  // the OLD scope's fields, so once the move is recorded, measure again under
  // the new scope. Once only: scopeFollowed stops a second hop.
  const rootNow = currentTree.nodes.find(node => String(node.id) === String(rootIssueId));
  const toProjectId = Number(rootNow?.fields?.project?.id);
  const toIssueTypeId = rootNow?.fields?.issuetype?.id == null ? null : String(rootNow.fields.issuetype.id);
  if (!scopeFollowed && toProjectId && toIssueTypeId
      && (toProjectId !== Number(review.project_id) || toIssueTypeId !== String(review.issue_type_id))) {
    const destination = await controlledFields({ projectId: toProjectId, issueTypeId: toIssueTypeId });
    if (await recordScopeMove({ issueId: rootIssueId, review, projectId: toProjectId, issueTypeId: toIssueTypeId,
      actorAccountId, destinationFieldCount: destination.length })) {
      return collectTree({ rootIssueId, rootIssueKey, detectedVia, actorAccountId, eventId, eventAt, now, scopeFollowed: true });
    }
  }

  const baselineTree = await readBaselineTree(review.baseline_id);
  const plannedCurrentTree = planTreeCapture({ rootIssueId, nodes: currentTree.nodes, controlledFields: cFields, fieldsFor });

  const measured = diffTree({ baselineTree, currentTree: plannedCurrentTree, controlledFields: cFields,
    scopeFor: fieldsFor }).changes;

  // A CHILD'S CONTENT IS THE CHILD'S DRIFT, NOT ITS PARENT'S. A child that
  // carries its own latest baseline is held and decided in the child
  // (lib/collect.js, the validator, its own panel), so a change to its fields
  // is not parent drift. Otherwise the child's own approved change would leave
  // the parent drifted, forever, against the child content it once captured.
  // The parent keeps its own fields and its structure: nodes added, removed or
  // moved. A child with no baseline of its own (a tree captured before child
  // baselines existed) is measured against the parent's node, as before.
  const rootLogicalNodeId = logicalNodeId(rootIssueId);
  const owned = measured.some(c => c.kind === 'FIELD_CHANGED' && c.logicalNodeId !== rootLogicalNodeId)
    ? await ownedChildBaselines({ parentBaseline: await activeBaseline(Number(rootIssueId)), baselineTree, activeBaselines })
    : new Map();
  const changes = measured.filter(c => c.kind !== 'FIELD_CHANGED' || c.logicalNodeId === rootLogicalNodeId
    || !owned.has(c.logicalNodeId));

  // Advancing the check time is what moves the sweep on: dueTreeRoots takes
  // the least recently checked first, so a clean tree left unstamped is picked
  // again every hour and the trees behind it are never reached.
  if (changes.length === 0) {
    await touch(rootIssueId, now);
    return { outcome: OUTCOME.NO_CHANGE };
  }

  // Each row carries what it saw: a digest over the changed field ids and their
  // current values (or the old and new parent, for a move). That is what lets a
  // re-read tell "the same drift, still undecided" from "changed again".
  const currentNodes = new Map(plannedCurrentTree.nodes.map(node => [node.logicalNodeId, node]));
  const driftRows = changes.map(c => {
    const fields = c.kind === 'FIELD_CHANGED' ? [...(c.fields ?? [])].sort() : null;
    const digests = currentNodes.get(c.logicalNodeId)?.digests ?? {};
    return {
      logicalNodeId: c.logicalNodeId,
      fieldId: c.kind,
      fieldName: c.kind === 'NODE_MOVED' ? `${c.from ?? ''}>${c.to ?? ''}` : null,
      baselineDigest: null,
      currentDigest: fields ? sha256Hex(JSON.stringify(fields.map(f => [f, digests[f] ?? null]))) : null,
      materiality: 'MAJOR',
      detectedAt: now
    };
  });

  // THE SAME DRIFT, READ AGAIN. The hourly sweep re-reads every drifted tree;
  // when what it finds is exactly what is already recorded and still awaiting a
  // decision, nothing happened. Recording it again reset "waiting since" to now,
  // wrote a ledger row per tree per hour, and voided pending approvals.
  if (review.state === REVIEW_STATE.DRIFTED
      && sameDrift(await readTreeDrift(review.baseline_id).catch(() => null), driftRows)) {
    await touch(rootIssueId, now);
    return { outcome: OUTCOME.NO_CHANGE, unchangedDrift: true };
  }

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
    recall: null };
}

/**
 * Fan a single node event out to every governed root it could affect, and run
 * the aggregate collector once per root.
 */
export async function collectAffectedTrees(event, deps = { affectedTreeRoots, collectTree }) {
  const identity = eventIdentity(event);
  const roots = await deps.affectedTreeRoots(identity);
  const trees = Promise.all(roots.map(root => deps.collectTree({
    rootIssueId: root.rootIssueId,
    rootIssueKey: root.rootIssueKey,
    detectedVia: DETECTED_VIA.EVENT,
    eventId: event?.eventId ?? event?.id ?? '',
    eventAt: eventTime(event),
    now: Date.now()
  })));
  // THE ISSUE ITSELF, WHEN IT HAS A SINGLE-ISSUE BASELINE OF ITS OWN. A child
  // baselined by its parent's capture carries exactly that, and the tree
  // collectors above measure only parents: its own content is its own drift,
  // measured by the single-issue collector like any flat baseline.
  const own = deps.collect && deps.ownFlatBaseline && identity.issueId != null
    && await deps.ownFlatBaseline(Number(identity.issueId))
    ? deps.collect({ issueId: Number(identity.issueId), issueKey: identity.issueKey,
      detectedVia: DETECTED_VIA.EVENT, eventId: event?.eventId ?? event?.id ?? '', eventAt: eventTime(event),
      now: Date.now() })
    : null;
  const results = await trees;
  return own ? [...results, await own] : results;
}

/** Whether this issue's standing baseline is a single-issue (flat) one. */
export async function ownFlatBaseline(issueId, read = activeBaseline) {
  const baseline = await read(issueId);
  return Boolean(baseline && !baseline.tree_hash);
}

const driftKey = row => [row.logicalNodeId, row.fieldId, row.fieldName ?? '', row.currentDigest ?? ''].join('|');

/** Is the recorded drift set exactly this one? Unreadable rows are never a match. */
function sameDrift(recorded, rows) {
  if (!Array.isArray(recorded) || recorded.length !== rows.length) return false;
  const seen = new Set(recorded.map(driftKey));
  return rows.every(row => seen.has(driftKey(row)));
}
