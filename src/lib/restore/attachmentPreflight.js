import { vaultedCopies } from '../../db/vaultStore.js';
import { isReadableCopy } from '../vaultLocation.js';

/**
 * Name every permanent file deletion before the reviewer signs. For removed
 * files, check whether the vault recorded a copy and name any that cannot be
 * restored. This checks availability only. attachments.js verifies copy hashes
 * before restoring bytes.
 *
 * @param reviewFields  visibility-filtered single-issue or grouped tree diff
 * @param issue         { issueId, issueKey } for fields without a group
 * @param removedNodes  recreated work items, [{ issueId, issueKey, files }]
 */
export async function attachmentRejection({ reviewFields = [], issue = {}, removedNodes = [], lookup = vaultedCopies }) {
  const file = (issueId, issueKey, a) => ({ issueId: issueId == null ? null : Number(issueId), issueKey: issueKey ?? null,
    id: String(a?.id ?? ''), filename: a?.filename || `attachment ${a?.id ?? ''}` });
  const deleteFiles = [];
  const restore = [];
  for (const field of reviewFields ?? []) {
    if (field?.kind !== 'attachments') continue;
    const issueId = field.group?.issueId ?? issue.issueId;
    const issueKey = field.group?.issueKey ?? field.issueKey ?? issue.issueKey;
    deleteFiles.push(...(field.added ?? []).map(a => file(issueId, issueKey, a)));
    restore.push(...(field.removed ?? []).map(a => file(issueId, issueKey, a)));
  }
  for (const node of removedNodes ?? []) {
    restore.push(...(node.files ?? []).map(a => file(node.issueId, node.issueKey, a)));
  }

  const byIssue = new Map();
  for (const entry of restore) {
    if (!byIssue.has(entry.issueId)) byIssue.set(entry.issueId, []);
    byIssue.get(entry.issueId).push(entry);
  }
  let vaultChecked = true;
  const restoreFiles = [];
  const unrestorableFiles = [];
  // Restorable, but the vault never learned which media file it is: text that
  // shows it cannot be pointed at the restored copy (./attachments.js).
  const mediaUnknownFiles = [];
  for (const [issueId, files] of byIssue) {
    let copies = null;
    try {
      copies = issueId == null ? new Map() : await lookup({ issueId, attachmentIds: files.map(f => f.id) });
    } catch (error) {
      console.error('attachmentRejection: vault lookup failed', error);
      vaultChecked = false;
    }
    for (const entry of files) {
      const copy = copies?.get(entry.id);
      if (copy?.storage === 'CONFLUENCE') {
        unrestorableFiles.push({ ...entry,
          reason: 'stored in Confluence, which is no longer supported' });
      } else if (copies && !isReadableCopy(copy)) {
        unrestorableFiles.push({ ...entry,
          reason: 'No copy of this file is in the vault, so a rejection cannot put it back.' });
      } else {
        restoreFiles.push(entry);
        if (copies && !copies.get(entry.id)?.media_id) mediaUnknownFiles.push(entry);
      }
    }
  }
  return { deleteFiles, restoreFiles, unrestorableFiles, mediaUnknownFiles, vaultChecked };
}

/** Removed work items' recorded files, from a parent's baseline tree and its diff. */
export function removedNodeFiles({ treeDiff, baselineTree }) {
  const removed = new Set((treeDiff?.changes ?? []).filter(change => change.kind === 'NODE_REMOVED')
    .map(change => String(change.logicalNodeId)));
  return (baselineTree?.nodes ?? []).filter(node => removed.has(String(node.logicalNodeId))).map(node => ({
    issueId: node.originalIssueId ?? node.currentIssueId ?? null,
    issueKey: node.issueKey ?? null,
    files: Array.isArray(baselineTree?.values?.[node.logicalNodeId]?.attachment)
      ? baselineTree.values[node.logicalNodeId].attachment : []
  })).filter(node => node.files.length > 0);
}
