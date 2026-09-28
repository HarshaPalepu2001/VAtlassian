import * as store from './store.js';
import { executeQuery, toBinaryParam, isUnknownColumn } from '../lib/db.js';
import { writeBaseline, currentVersion } from './baselineStore.js';
import { beginTreeBaseline, writeTreeCapture, verifyTreeCapture, publishTreeBaseline } from './baselineTreeStore.js';

/**
 * A BASELINE VERSION THAT RE-RECORDS ONE LINK, ON ANOTHER ISSUE'S APPROVAL.
 *
 * jobs/linkWorker.js writes these when an approval on one issue decided a link
 * this issue shares (lib/approval/linkPropagation.js). The new version is this
 * issue's standing record with only its links changed:
 *   - its frozen control policy is its own, copied from the version before, so
 *     its next decision replays exactly the rules it was governed by;
 *   - its approval, signer and assurance are the deciding approval's, which is
 *     what authenticates the change;
 *   - it is published like any capture (CAPTURING, verified, then ACTIVE with
 *     the older version SUPERSEDED), so no earlier signed version is edited.
 */

const MAX_VERSION_ATTEMPTS = 3;

async function withNextVersion(issueId, attempt) {
  let version = (await currentVersion(issueId)) + 1;
  for (let i = 1; ; i += 1) {
    try {
      return await attempt(version);
    } catch (error) {
      if (!store.isDuplicateKey(error) || i >= MAX_VERSION_ATTEMPTS) throw error;
      version = (await currentVersion(issueId)) + 1;
    }
  }
}

function rowFor(source, approval, now, version) {
  return {
    issue_id: Number(source.issue_id),
    project_id: Number(source.project_id),
    issue_type_id: String(source.issue_type_id),
    version,
    transition_id: source.transition_id ?? null,
    from_status_id: source.from_status_id ?? null,
    to_status_id: source.to_status_id ?? null,
    required_role: source.required_role ?? null,
    required_assurance: source.required_assurance ?? null,
    controlled_fields_hash: source.controlled_fields_hash ?? null,
    approved_by: approval.accountId,
    approved_name: approval.displayName,
    assurance_level: approval.assuranceLevel,
    approval_id: approval.approvalId,
    transition_at: now,
    captured_at: now,
    fidelity: source.fidelity ?? 'EXACT'
  };
}

/** A single-issue record: values and digests already derived. */
export async function writeDerivedFlat({ source, values, digests, contentHash, approval, now }) {
  let written;
  await withNextVersion(Number(source.issue_id), async version => {
    const baseline = { ...rowFor(source, approval, now, version), content_hash: contentHash,
      field_digests: JSON.stringify(digests), field_count: Object.keys(digests).length };
    written = { ...(await writeBaseline({ baseline, raw: values })), version };
  });
  return written;
}

/**
 * A tree record: the derived nodes and values (only the root's links differ).
 * Its children were read at the source version's capture, and it says so, so
 * they keep owning their content (../lib/tree/childBaselines.js).
 */
export async function writeDerivedTree({ source, derived, approval, now, query = store.throwing, write = executeQuery }) {
  const fieldCount = derived.nodes.reduce((n, node) => n + Object.keys(derived.values?.[node.logicalNodeId] ?? {}).length, 0);
  let reserved;
  await withNextVersion(Number(source.issue_id), async version => {
    const baseline = { ...rowFor(source, approval, now, version), content_hash: derived.treeHash,
      field_digests: '{}', field_count: fieldCount, tree_hash: derived.treeHash };
    reserved = await beginTreeBaseline({ baseline, query });
  });
  await writeTreeCapture({ baselineId: reserved.baselineId, treeHash: derived.treeHash,
    nodes: derived.nodes, values: derived.values, query });
  await verifyTreeCapture({ baselineId: reserved.baselineId, expectedNodeCount: derived.nodes.length,
    expectedFieldCount: fieldCount, expectedTreeHash: derived.treeHash, query });
  const nodesCapturedAt = Number(source.nodes_captured_at ?? source.captured_at);
  try {
    await query(`UPDATE va_baseline SET nodes_captured_at = ? WHERE baseline_id = FROM_BASE64(?) AND state = 'CAPTURING'`,
      [nodesCapturedAt, toBinaryParam(reserved.baselineId)]);
  } catch (error) {
    // Before v068 lands: without the column its children would stop owning
    // their content, so a tree with children is not published. A lone root has
    // none to lose.
    if (!isUnknownColumn(error) || derived.nodes.length > 1) throw error;
  }
  await publishTreeBaseline({ baselineId: reserved.baselineId, issueId: Number(source.issue_id),
    version: Number(reserved.version), query, write });
  return { baselineId: reserved.baselineId, version: Number(reserved.version) };
}
