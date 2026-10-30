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
import { testManagementExclusion } from '../testmgmt/treeExclusion.js';
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
 * Re-read the whole governed tree when any node is created, updated or
 * deleted. A node-only comparison can miss removed siblings or newly attached
 * children. Use one aggregate result for the tree.
 */

/**
 * Find an active governed root through the Jira parent chain when a new
 * node has not yet been recorded in any baseline's node index.
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
 * Look up captured nodes in the active-root index first. If no index entry
 * exists, walk the current native parent chain to locate the governing root
 * for a node created after capture.
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
 * Re-read the complete tree and replace its drift set against the active
 * signed baseline. Events trigger this read but supply no trusted content.
 * Repeated and out-of-order events therefore converge on the same result.
 * Write nothing if the root has no ACTIVE baseline.
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
  const reader = createTreeReader({ api, route, exclude: testManagementExclusion });
  let currentTree, fieldsFor;
  try {
    ({ tree: currentTree, fieldsFor } = await readTreeWithNodeFields({ readStableTree,
      readTree: reader.read.bind(reader), rootIssueKey, rootFields: cFields }));
  } catch (e) {
    return { outcome: 'ERROR', error: e.message };
  }

  // After a scope move, re-read using the destination's configuration.
  // The current tree used the old scope. scopeFollowed permits only one retry.
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
  const policyFor = treeLinkPolicyResolver(baselineTree);
  currentTree.nodes = await hydrateLinkPolicyNodes(currentTree.nodes, policyFor);
  const plannedCurrentTree = planTreeCapture({ rootIssueId, nodes: currentTree.nodes, controlledFields: cFields, fieldsFor, policyFor });

  const measured = diffTree({ baselineTree, currentTree: plannedCurrentTree, controlledFields: cFields,
    scopeFor: fieldsFor }).changes;

  // Children with their own latest baseline have their content measured and
  // decided independently. Parent drift includes its own fields and structural
  // changes. Compare older children without their own baseline against the
  // parent's stored node.
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

  // If the drift set is unchanged and awaiting a decision, preserve its waiting
  // time, ledger history and pending approvals instead of recording it again.
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

  // Replace the entire recorded drift set with this full comparison.
  // Appending would leave stale rows for changes that no longer exist.
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
  // Use the single-issue collector for this item's own flat baseline,
  // including child baselines written by parent captures.
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
import { hydrateLinkPolicyNodes, treeLinkPolicyResolver } from './linkPolicy.js';
