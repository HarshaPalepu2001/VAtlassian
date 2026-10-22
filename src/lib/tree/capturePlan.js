import { FailClosed } from '../errors.js';
import { project } from '../content.js';
import { canonical, sha256Hex } from '../hash.js';
import { logicalNodeId, TREE_LIMIT } from './model.js';
import { normaliseLinkPolicy } from '../linkPolicy.js';

function withPlanningAliases(node, digests) {
  // Existing in-memory tree diff consumers use these names. Keeping the
  // aliases non-enumerable prevents transient planning data from being stored.
  Object.defineProperties(node, {
    parentLogicalId: { value: node.parentLogicalNodeId, enumerable: false },
    digests: { value: digests, enumerable: false }
  });
  return node;
}

/**
 * `fieldsFor(node)` names the fields that node tracks: its own project and
 * issue type's Controlled Fields (./nodeFields.js). Without it every node uses
 * `controlledFields`, exactly as before per-node tracking.
 */
export function planTreeCapture({ rootIssueId, nodes, controlledFields, fieldsFor = () => controlledFields,
  linkPolicy, policyFor = () => linkPolicy }) {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new FailClosed('MISSING_ROOT');
  if (nodes.length > TREE_LIMIT) throw new FailClosed('TREE_LIMIT_EXCEEDED');

  const planned = nodes.map(node => {
    if (node?.id == null || !node.fields) throw new FailClosed('MISSING_ROOT');
    const own = fieldsFor(node) ?? [];
    const projection = project(node.fields, own, { linkPolicy: policyFor(node), issue: node });
    if (Object.keys(projection.raw).length !== own.length) {
      throw new FailClosed('BASELINE_VALUES_REQUIRED');
    }
    return {
      source: node,
      ownCount: own.length,
      logicalNodeId: logicalNodeId(node.id),
      parentLogicalNodeId: node.fields.parent?.id == null ? null : logicalNodeId(node.fields.parent.id),
      ...projection
    };
  }).sort((a, b) => String(a.source.id).localeCompare(String(b.source.id), undefined, { numeric: true }));

  const byLogicalId = new Map();
  for (const node of planned) {
    if (byLogicalId.has(node.logicalNodeId)) throw new FailClosed('DUPLICATE_NODE');
    byLogicalId.set(node.logicalNodeId, node);
  }

  const rootLogicalNodeId = logicalNodeId(rootIssueId);
  if (!byLogicalId.has(rootLogicalNodeId)) throw new FailClosed('MISSING_ROOT');

  let edgeCount = 0;
  for (const node of planned) {
    if (node.logicalNodeId !== rootLogicalNodeId && !node.parentLogicalNodeId) {
      throw new FailClosed('MISSING_PARENT');
    }
    if (node.parentLogicalNodeId) {
      if (!byLogicalId.has(node.parentLogicalNodeId)) throw new FailClosed('MISSING_PARENT');
      edgeCount += 1;
    }
  }

  for (const node of planned) {
    let current = node;
    const path = new Set();
    while (current) {
      if (path.has(current.logicalNodeId)) throw new FailClosed('CYCLE_DETECTED');
      path.add(current.logicalNodeId);
      current = current.parentLogicalNodeId ? byLogicalId.get(current.parentLogicalNodeId) : null;
    }
  }

  const durableNodes = planned.map((node, nodeOrder) => withPlanningAliases({
    logicalNodeId: node.logicalNodeId,
    originalIssueId: Number(node.source.id),
    currentIssueId: Number(node.source.id),
    issueKey: String(node.source.key ?? node.source.id),
    parentLogicalNodeId: node.parentLogicalNodeId,
    projectId: Number(node.source.fields.project?.id ?? 0),
    issueTypeId: String(node.source.fields.issuetype?.id ?? ''),
    contentHash: node.contentHash,
    fieldDigests: JSON.stringify(node.digests),
    nodeOrder
    ,...(normaliseLinkPolicy(policyFor(node.source)).version === 2 || normaliseLinkPolicy(linkPolicy).version === 2
      ? { linkPolicy: normaliseLinkPolicy(policyFor(node.source)) } : {})
  }, node.digests));
  const values = Object.fromEntries(planned.map(node => [node.logicalNodeId, node.raw]));
  const treeHash = sha256Hex(canonical(durableNodes.map(node => ({
    id: node.logicalNodeId,
    parent: node.parentLogicalNodeId,
    hash: node.contentHash
  }))));
  return {
    treeHash,
    nodeCount: durableNodes.length,
    edgeCount,
    totalFieldCount: planned.reduce((count, node) => count + node.ownCount, 0),
    nodes: durableNodes,
    values
  };
}
