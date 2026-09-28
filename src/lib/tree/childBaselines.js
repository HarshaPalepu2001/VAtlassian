import { logicalNodeId } from './model.js';

/**
 * A CHILD'S OWN BASELINE, SEEN FROM ITS PARENT'S TREE.
 *
 * Since 2026-09-24 every child a parent's capture reaches gets its own baseline
 * (db/childBaselineStore.js). From then on the child's content is judged and
 * decided in the child, against that baseline; the parent's stored node is
 * only the structure it was signed with.
 *
 * A child's ACTIVE baseline is its own record, not the parent's, when it is
 * the latest recorded one: written by this very parent capture, or captured
 * at or after it (the child's own controlled transition or drift decision).
 * A child baselined only BEFORE the parent's capture, as every child of a tree
 * captured before per-child baselines existed, keeps today's behaviour: its
 * content is measured against the parent's stored node.
 */
export function ownsItsContent(childBaseline, parentBaseline) {
  if (!childBaseline || !parentBaseline) return false;
  const by = childBaseline.captured_by_baseline_id;
  if (by && parentBaseline.baseline_id && Buffer.from(by).equals(Buffer.from(parentBaseline.baseline_id))) return true;
  // A parent version that re-recorded only its own link (jobs/linkWorker.js)
  // copied its child nodes from the version before; they are as old as that
  // capture, so the children own their content exactly as they did then.
  const nodesCapturedAt = parentBaseline.nodes_captured_at ?? parentBaseline.captured_at;
  return Number(childBaseline.captured_at ?? 0) >= Number(nodesCapturedAt ?? Infinity);
}

const nodeIssueId = node => Number(node.currentIssueId ?? node.originalIssueId);

/**
 * Map logicalNodeId -> the child's own active baseline, for every non-root
 * node of a parent's baseline tree that owns its content. One read.
 */
export async function ownedChildBaselines({ parentBaseline, baselineTree, activeBaselines }) {
  const children = (baselineTree?.nodes ?? []).filter(node => node.parentLogicalNodeId != null);
  if (!children.length) return new Map();
  const byIssue = await activeBaselines(children.map(nodeIssueId));
  const owned = new Map();
  for (const node of children) {
    const own = byIssue.get(nodeIssueId(node)) ?? byIssue.get(String(nodeIssueId(node)));
    if (ownsItsContent(own, parentBaseline)) owned.set(node.logicalNodeId, own);
  }
  return owned;
}

function parseDigests(text) {
  if (text && typeof text === 'object') return text;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && Object.keys(parsed).length ? parsed : null;
  } catch { return null; }
}

const sameDigests = (a, b) => {
  const keys = Object.keys(a ?? {});
  return keys.length === Object.keys(b ?? {}).length && keys.every(key => a[key] === b?.[key]);
};

/**
 * The child's approved digests and retained values, from its own baseline, or
 * null. `stored` is the parent's node for the child: when the child's own
 * record has exactly its digests (the child baseline this very capture wrote,
 * the common case) its values are the parent's too, and are not read again.
 */
async function ownRecord(child, issueId, stored, { readAllValues, readBaselineTree }) {
  if (!child.tree_hash) {
    const digests = parseDigests(child.field_digests);
    if (!digests) return null;
    if (stored.node.digests && sameDigests(digests, stored.node.digests)) return { digests, values: stored.values };
    return { digests, values: await readAllValues(issueId, child.version) };
  }
  // The child's own tree baseline (its own capture, with children of its own):
  // its record is that tree's root node.
  const own = await readBaselineTree(child.baseline_id);
  const root = own.nodes.find(node => node.parentLogicalNodeId == null)
    ?? own.nodes.find(node => node.logicalNodeId === logicalNodeId(issueId));
  if (!root?.digests) return null;
  return { digests: root.digests, values: own.values?.[root.logicalNodeId] ?? {} };
}

/**
 * THE TREE A PARENT DECISION RETURNS TO: the parent's baseline tree, with each
 * child that owns its content replaced by that child's own latest baseline.
 *
 * Rejecting the parent restores every issue to ITS OWN latest recorded
 * baseline, and the parent's review shows each child against exactly that
 * (spec 2026-09-24 §4.5, §4.7). Building it once, here, is what keeps the
 * review diff, the restore plan, the queued worker and the post-restore
 * verification comparing against the same thing. Structure (parents, order)
 * stays the parent's: only content comes from the child.
 */
export async function withChildBaselines({ parentBaseline, baselineTree, activeBaselines, readAllValues, readBaselineTree }) {
  const owned = await ownedChildBaselines({ parentBaseline, baselineTree, activeBaselines });
  if (!owned.size) return baselineTree;
  const values = { ...(baselineTree.values ?? {}) };
  const records = await Promise.all([...owned].map(async ([id, child]) => {
    const node = baselineTree.nodes.find(n => n.logicalNodeId === id);
    return [id, child, await ownRecord(child, nodeIssueId(node), { node, values: values[id] ?? {} },
      { readAllValues, readBaselineTree })];
  }));
  const byId = new Map(records.filter(([, , record]) => record).map(([id, child, record]) => [id, { child, record }]));
  const nodes = baselineTree.nodes.map(node => {
    const own = byId.get(node.logicalNodeId);
    if (!own) return node;
    values[node.logicalNodeId] = own.record.values;
    const replaced = {
      ...node,
      fieldDigests: JSON.stringify(own.record.digests),
      ownBaseline: {
        version: Number(own.child.version),
        baselineId: Buffer.from(own.child.baseline_id).toString('hex'),
        capturedByParent: own.child.captured_by_baseline_id != null
      }
    };
    Object.defineProperties(replaced, {
      parentLogicalId: { value: node.parentLogicalNodeId ?? null, enumerable: false },
      digests: { value: own.record.digests, enumerable: false }
    });
    return replaced;
  });
  return { ...baselineTree, nodes, values };
}
