import { vaultedCopies } from '../../db/vaultStore.js';
import { isReadableCopy } from '../vaultLocation.js';

/**
 * WHAT A REJECTION WILL DO TO FILES, SAID BEFORE IT IS SIGNED.
 *
 * Deleting an added file is permanent, and a reviewer cannot authorise a
 * deletion they were not shown, so every such file is named with its work
 * item. A removed file comes back only if the vault holds a copy of it; one it
 * never received (vaulting failed, or the vault was not set up yet) cannot be
 * restored, and the reviewer is told that too, before signing rather than
 * after.
 *
 * The vault check here is only whether a copy was recorded. Whether its bytes
 * still match their hash is established by the restore itself, which refuses a
 * copy that does not (./attachments.js).
 *
 * @param reviewFields  the review diff's fields (a single issue's diff, or a
 *                      tree's grouped review), already filtered to what the
 *                      viewer may see
 * @param issue         { issueId, issueKey } for fields that carry no group
 * @param removedNodes  work items a tree rejection recreates: [{ issueId,
 *                      issueKey, files }], each file re-uploaded to the copy
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
