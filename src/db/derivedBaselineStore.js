import * as store from './store.js';
import { executeQuery, toBinaryParam, isUnknownColumn } from '../lib/db.js';
import { writeBaseline, currentVersion, activeBaselines } from './baselineStore.js';
import { beginTreeBaseline, writeTreeCapture, verifyTreeCapture, publishTreeBaseline } from './baselineTreeStore.js';
import { readVersionEvidence, writeVersionEvidence, copyNodePins } from './evidenceStore.js';
import { derivedEvidence, linkRows, linkedIssueIds, CAUSE, UNRECORDED_ROLE, parseDigests } from '../lib/evidence/versionEvidence.js';
import { FailClosed } from '../lib/errors.js';

/**
 * Record a link in a new baseline version under the other issue's approval.
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
    ...(source.link_policy ? { link_policy: source.link_policy } : {}),
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

/**
 * Link-record evidence includes the source version's signed definitions and
 * rules with the derived digests, the deciding approval as a LINK_RECORD
 * signature, and the links it now records. A source whose policy was never
 * recorded gives only the signature, and its record publishes without the
 * evidence gate (`required: false`), exactly as recorded as the source was.
 */
async function linkRecordEvidence({ source, digests, links, approval, now }, { readEvidence, activeBaselines: versions }) {
  const signed = await readEvidence(source.baseline_id);
  const others = linkedIssueIds(links);
  const otherVersions = others.length ? await versions(others) : new Map();
  const evidence = derivedEvidence({ source: signed, digests, signature: {
    approvalId: approval.approvalId, signerAccountId: approval.accountId, signerName: approval.displayName,
    role: approval.signerRole ?? UNRECORDED_ROLE, assurance: approval.assuranceLevel, cause: CAUSE.LINK_RECORD,
    transitionId: source.transition_id ?? null, fromStatusId: source.from_status_id ?? null,
    toStatusId: source.to_status_id ?? null, transitionAt: now, statusAtCapture: null, signedAt: now,
    fieldsCovered: ['issuelinks'] } });
  return { evidence: { fields: evidence.fields, rules: evidence.rules, signatures: evidence.signatures },
    links: linkRows({ links, otherVersions }), cause: CAUSE.LINK_RECORD, required: evidence.recorded };
}

/** A single-issue record: values and digests already derived. */
export async function writeDerivedFlat({ source, values, digests, contentHash, approval, now },
  deps = {}) {
  const d = { readEvidence: readVersionEvidence, activeBaselines, write: writeBaseline,
    nextVersion: attempt => withNextVersion(Number(source.issue_id), attempt), ...deps };
  const evidence = await linkRecordEvidence({ source, digests, links: values?.issuelinks ?? [], approval, now }, d);
  let written;
  await d.nextVersion(async version => {
    const baseline = { ...rowFor(source, approval, now, version), content_hash: contentHash,
      field_digests: JSON.stringify(digests), field_count: Object.keys(digests).length };
    written = { ...(await d.write({ baseline, raw: values, evidence })), version };
  });
  return written;
}

/**
 * A tree record: the derived nodes and values (only the root's links differ).
 * Its children were read at the source version's capture, and it says so, so
 * they keep owning their content (../lib/tree/childBaselines.js).
 */
export async function writeDerivedTree({ source, derived, approval, now, query = store.throwing, write = executeQuery },
  deps = {}) {
  const d = { readEvidence: readVersionEvidence, activeBaselines, writeEvidence: writeVersionEvidence,
    copyPins: copyNodePins, nextVersion: attempt => withNextVersion(Number(source.issue_id), attempt), ...deps };
  // The evidence is worked out before any row is reserved: a schema that is
  // not there yet, or a source that cannot be derived from, refuses here and
  // leaves nothing half-written behind to wait for the retry.
  const root = derived.nodes.find(node => node.parentLogicalNodeId == null);
  if (!root) throw new FailClosed('CAPTURE_INCOMPLETE');
  const evidence = await linkRecordEvidence({ source, digests: parseDigests(root.fieldDigests),
    links: derived.values?.[root.logicalNodeId]?.issuelinks ?? [], approval, now }, d);
  const fieldCount = derived.nodes.reduce((n, node) => n + Object.keys(derived.values?.[node.logicalNodeId] ?? {}).length, 0);
  let reserved;
  await d.nextVersion(async version => {
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
  await d.copyPins({ fromBaselineId: source.baseline_id, toBaselineId: reserved.baselineId, query });
  await d.writeEvidence({ query, entries: [{ baselineId: reserved.baselineId, evidence: evidence.evidence,
    links: evidence.links, cause: evidence.cause }] });
  await publishTreeBaseline({ baselineId: reserved.baselineId, issueId: Number(source.issue_id),
    version: Number(reserved.version), requireEvidence: evidence.required, query, write });
  return { baselineId: reserved.baselineId, version: Number(reserved.version) };
}
