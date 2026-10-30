import { logicalNodeId } from './model.js';
import { baselineLinkPolicy } from '../linkPolicy.js';

/**
 * Use a child's active baseline for its content if this parent capture wrote
 * it or it was captured at or after the parent. The parent's stored node
 * continues to define structure.
 *
 * A baseline older than the parent capture does not replace that stored node.
 * This preserves comparison for trees captured before per-child baselines
 * were introduced on 2026-09-24.
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
export async function ownedChildBaselines({ parentBaseline, baselineTree, activeBaselines, governorOf = () => parentBaseline }) {
  const children = (baselineTree?.nodes ?? []).filter(node => node.parentLogicalNodeId != null);
  if (!children.length) return new Map();
  const byIssue = await activeBaselines(children.map(nodeIssueId));
  const owned = new Map();
  for (const node of children) {
    const own = byIssue.get(nodeIssueId(node)) ?? byIssue.get(String(nodeIssueId(node)));
    if (ownsItsContent(own, governorOf(node) ?? parentBaseline)) owned.set(node.logicalNodeId, own);
  }
  return owned;
}

const parentIdOf = node => node.parentLogicalNodeId ?? node.parentLogicalId ?? null;

/** Every node below `nodeId` in `tree` (not the node itself). */
function descendantsOf(tree, nodeId) {
  const below = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const node of tree.nodes) {
      const parent = parentIdOf(node);
      if (!below.has(node.logicalNodeId) && (parent === nodeId || below.has(parent))) {
        below.add(node.logicalNodeId);
        grew = true;
      }
    }
  }
  return below;
}

function depthOf(tree, nodeId) {
  const byId = new Map(tree.nodes.map(node => [node.logicalNodeId, node]));
  let depth = 0;
  for (let node = byId.get(nodeId); node && parentIdOf(node) != null && depth < 64; node = byId.get(parentIdOf(node))) depth += 1;
  return depth;
}

/**
 * Replace a child's branch with its own tree baseline if it is newer than
 * the parent's capture. This includes the child's approved structural changes
 * so a parent rejection cannot delete or detach them.
 *
 * Process shallowest branches first. Within a replaced branch, a grandchild's
 * baseline takes precedence only if newer than that branch's capture.
 * See the live regression from 2026-10-12 involving VAT-72, VAT-74 and VAT-76.
 */
async function graftOwnedBranches({ parentBaseline, baselineTree, activeBaselines, readBaselineTree }) {
  let tree = baselineTree;
  const governor = new Map();
  const governorOf = node => governor.get(node.logicalNodeId) ?? parentBaseline;
  const grafted = new Set();
  for (let pass = 0; pass < 32; pass += 1) {
    const owned = await ownedChildBaselines({ parentBaseline, baselineTree: tree, activeBaselines, governorOf });
    const next = [...owned].filter(([id, child]) => child.tree_hash && !grafted.has(id))
      .sort(([a], [b]) => depthOf(tree, a) - depthOf(tree, b))[0];
    if (!next || typeof readBaselineTree !== 'function') break;
    const [nodeId, child] = next;
    grafted.add(nodeId);
    const own = await readBaselineTree(child.baseline_id);
    const ownRoot = own?.nodes?.find(node => parentIdOf(node) == null);
    if (!ownRoot) continue;
    const below = descendantsOf(tree, nodeId);
    const branch = own.nodes.filter(node => node !== ownRoot)
      .map(node => Object.create(Object.getPrototypeOf(node), { ...Object.getOwnPropertyDescriptors(node),
        linkPolicy: { value: node.linkPolicy ?? baselineLinkPolicy(child), enumerable: true, configurable: true, writable: true } }));
    const values = { ...(tree.values ?? {}) };
    for (const id of below) delete values[id];
    for (const node of branch) {
      values[node.logicalNodeId] = own.values?.[node.logicalNodeId] ?? {};
      governor.set(node.logicalNodeId, child);
    }
    governor.set(nodeId, governorOf({ logicalNodeId: nodeId }));
    tree = { ...tree, nodes: [...tree.nodes.filter(node => !below.has(node.logicalNodeId)), ...branch], values };
  }
  return { tree, governorOf };
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
 * Build the parent's target tree using each child's own latest applicable
 * baseline. Share it across review, planning, queued execution and verification.
 * Structure follows the parent's capture except where a child has since signed
 * its own tree. See graftOwnedBranches and spec 2026-09-24 sections 4.5 and 4.7.
 */
export async function withChildBaselines({ parentBaseline, baselineTree: signedTree, activeBaselines, readAllValues, readBaselineTree }) {
  const { tree: baselineTree, governorOf } = await graftOwnedBranches({ parentBaseline, baselineTree: signedTree,
    activeBaselines, readBaselineTree });
  const owned = await ownedChildBaselines({ parentBaseline, baselineTree, activeBaselines, governorOf });
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
      linkPolicy: baselineLinkPolicy(own.child),
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
