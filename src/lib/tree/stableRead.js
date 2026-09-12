export class FailClosed extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function relationshipHash(tree) {
  // simple hash of nodes and their parent ids
  return JSON.stringify(tree.nodes.map(n => ({
    id: n.id,
    parentId: n.fields?.parent?.id || null
  })).sort((a, b) => (a.id || '').localeCompare(b.id || '')));
}

export async function readStableTree({ readTree, rootIssueKey, fieldIds, maxAttempts = 3 }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const first = await readTree(rootIssueKey, fieldIds);
    const second = await readTree(rootIssueKey, ['parent']);
    if (relationshipHash(first) === relationshipHash(second)) return { tree: first, attempts: attempt };
  }
  throw new FailClosed('TREE_CHANGED_DURING_CAPTURE');
}
