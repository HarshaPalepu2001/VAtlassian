import { FailClosed } from '../errors.js';

/**
 * EVERY NODE IS TRACKED WITH ITS OWN FIELDS.
 *
 * Decided 2026-09-24: a baseline tracks exactly the Controlled Fields page rows
 * for its own project and issue type, the parent and each child alike. A tree
 * therefore needs one field list per distinct (project, issue type) among its
 * nodes, known only once the tree has been read.
 *
 * `fieldsFor(node)` accepts a read node (`node.fields.project.id`) or a planned
 * or stored one (`node.projectId`), so capture, the collector, the panel and
 * restore all answer "which fields does this node track" the same way.
 */
export const scopeKey = (projectId, issueTypeId) => `${Number(projectId)}:${String(issueTypeId)}`;

export function nodeScope(node) {
  return {
    projectId: Number(node?.fields?.project?.id ?? node?.projectId),
    issueTypeId: String(node?.fields?.issuetype?.id ?? node?.issueTypeId ?? '')
  };
}

/**
 * Read a tree with every node's own fields.
 *
 * Reads once with the root's fields. The root's scope is seeded with
 * `rootFields`, so a tree whose nodes all share the root's scope costs no
 * extra lookup and no second read, exactly as before. Only when some node's
 * scope tracks a field not yet read is the tree read again, with the union.
 */
export async function readTreeWithNodeFields({ readStableTree, readTree, rootIssueKey, rootFields, loadFields,
  extraFieldIds = [] }) {
  const baseIds = [...new Set([...rootFields.map(f => f.field_id), ...extraFieldIds, 'project', 'issuetype'])];
  let { tree } = await readStableTree({ readTree, rootIssueKey, fieldIds: baseIds });
  const byScope = new Map();
  const root = tree.nodes.find(node => String(node.key) === String(rootIssueKey)) ?? tree.nodes[0];
  if (root) {
    const { projectId, issueTypeId } = nodeScope(root);
    byScope.set(scopeKey(projectId, issueTypeId), rootFields);
  }
  for (const node of tree.nodes) {
    const scope = nodeScope(node);
    const key = scopeKey(scope.projectId, scope.issueTypeId);
    if (!byScope.has(key)) byScope.set(key, await loadFields(scope) ?? []);
  }
  const neededIds = () => [...new Set([...byScope.values()].flat().map(f => f.field_id))];
  const readIds = [...new Set([...baseIds, ...neededIds()])];
  if (readIds.length > baseIds.length) {
    ({ tree } = await readStableTree({ readTree, rootIssueKey, fieldIds: readIds }));
    // A node that appeared between the two reads may bring a scope of its own.
    // Its fields must already have been read, or its content is unmeasured.
    for (const node of tree.nodes) {
      const scope = nodeScope(node);
      const key = scopeKey(scope.projectId, scope.issueTypeId);
      if (!byScope.has(key)) byScope.set(key, await loadFields(scope) ?? []);
    }
    if (neededIds().some(id => !readIds.includes(id))) throw new FailClosed('TREE_CHANGED_DURING_CAPTURE');
  }
  const fieldsFor = node => {
    const { projectId, issueTypeId } = nodeScope(node);
    return byScope.get(scopeKey(projectId, issueTypeId)) ?? [];
  };
  return { tree, fieldsFor };
}

/** Field ids a set of nodes tracks between them: what a verification read must fetch. */
export function unionFieldIds(nodes, fieldsFor) {
  return [...new Set((nodes ?? []).flatMap(node => fieldsFor(node).map(f => String(f.field_id))))];
}
