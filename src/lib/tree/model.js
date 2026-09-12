import { canonical, sha256Hex } from '../hash.js';

export const TREE_LIMIT = 500;
export const logicalNodeId = issueId => sha256Hex(canonical({ originalIssueId: String(issueId) }));
