import { canonical, sha256Hex } from '../hash.js';

export const TREE_LIMIT = 500;

/**
 * Inlined logicalNodeId calculation:
 * Equivalent to sha256Hex(canonical({ originalIssueId: String(issueId) }))
 * but eliminates redundant wrapper object allocation, canonical sort traversal,
 * and intermediate array allocations for single-key identity hashing.
 */
export const logicalNodeId = issueId => {
  const idStr = typeof issueId === 'string' ? issueId : String(issueId);
  return sha256Hex('{"originalIssueId":' + JSON.stringify(idStr) + '}');
};
