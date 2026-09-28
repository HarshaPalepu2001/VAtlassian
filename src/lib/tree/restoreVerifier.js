import { project } from '../content.js';
import { diffTree } from './diff.js';
import { logicalNodeId } from './model.js';
import { harnessLog } from '../harnessLogger.js';
import { unionFieldIds } from './nodeFields.js';

const parentOf = node => node?.parentLogicalNodeId ?? node?.parentLogicalId ?? node?.parent ?? null;

function putIdentity(map, value, logicalId) {
  if (value != null) map.set(String(value), String(logicalId));
}

/**
 * Turn the diff's verdict into something a person can act on.
 *
 * ─── WHY THIS IS NOT COSMETIC ────────────────────────────────────────────────
 *
 * The verifier used to return `changes` as `{ kind, logicalNodeId, fields }` —
 * a sha-256 logical node id and a bare field id — and nothing logged it, the
 * panel did not render it, and the harness did not expose it. So a restore
 * reported PARTIAL and NOBODY, including the people who wrote it, could say
 * which field had refused to match. A reviewer was told "partly restored" about
 * a work item that looked completely correct on screen, and the only way to
 * find out more was to read a JSON column out of the database by hand.
 *
 * A verdict a reviewer cannot act on is not a verdict. Every unmatched entry
 * now carries the Jira key it belongs to, the field's human name, the approved
 * and observed digests, and a sentence saying what that means.
 */
function describeChange(change, { nodeKeys, fieldNames, baselineDigestsById, observedDigestsById }) {
  const issueKey = nodeKeys.get(String(change.logicalNodeId)) ?? null;
  const base = { logicalNodeId: String(change.logicalNodeId), issueKey, kind: change.kind };
  if (change.kind === 'FIELD_CHANGED') {
    const expected = baselineDigestsById.get(String(change.logicalNodeId)) ?? {};
    const actual = observedDigestsById.get(String(change.logicalNodeId)) ?? {};
    return (change.fields ?? []).map(fieldId => ({
      ...base,
      fieldId: String(fieldId),
      fieldName: fieldNames.get(String(fieldId)) ?? String(fieldId),
      expected: expected[fieldId] ?? null,
      actual: actual[fieldId] ?? null,
      reason: 'Jira accepted the restore but this tracked field does not hold its approved value. '
        + 'A screen configuration, a field validator or a workflow post-function may be overriding it.'
    }));
  }
  const reason = change.kind === 'NODE_REMOVED'
    ? 'This work item is part of the approved hierarchy and is not present, so the restore cannot be confirmed.'
    : change.kind === 'NODE_ADDED'
      ? 'This work item is not part of the approved hierarchy and is still present.'
      : 'This work item is not in its approved place in the hierarchy.';
  return [{ ...base, fieldId: null, fieldName: null, expected: change.from ?? null,
    actual: change.to ?? null, reason }];
}

export async function verifyTreeRestore({
  readStableTree, readTree, rootIssueKey, baselineTree, controlledFields, fieldsFor = () => controlledFields,
  replacements = [], expectedRootStatusId = null
}) {
  // Each node is verified over its OWN fields (./nodeFields.js), so the read
  // fetches every field any node of the approved tree tracks.
  const fieldIds = [...new Set([
    ...controlledFields.map(field => String(field.field_id)),
    ...unionFieldIds(baselineTree?.nodes, fieldsFor),
    'parent',
    'status'
  ])];
  let liveTree;
  try {
    const stable = await readStableTree({ readTree, rootIssueKey, fieldIds });
    liveTree = stable?.tree;
    if (!Array.isArray(liveTree?.nodes)) throw new Error('Stable tree read returned no nodes');
  } catch (error) {
    // Deliberately pessimistic, and now deliberately explicit: an unverifiable
    // restore reported as complete is the outcome this module exists to
    // prevent, and "we could not read it back" is a different fact from "a
    // field is wrong". Both have to be sayable.
    harnessLog('RESTORE', 'verify:readFailed', { rootIssueKey, error: error?.message }, 'ERROR');
    return { matches: false, replacements, progress: false, statusMatches: false, changes: [],
      unmatched: [{ logicalNodeId: null, issueKey: rootIssueKey, kind: 'READ_FAILED', fieldId: null,
        fieldName: null, expected: null, actual: null,
        reason: 'The hierarchy could not be read back, so nothing about this restore could be confirmed.' }] };
  }

  const realToLogical = new Map();
  for (const node of baselineTree?.nodes ?? []) {
    putIdentity(realToLogical, node.originalIssueId ?? node.id, node.logicalNodeId);
    putIdentity(realToLogical, node.currentIssueId, node.logicalNodeId);
    putIdentity(realToLogical, node.issueKey ?? node.key, node.logicalNodeId);
  }
  for (const replacement of replacements) {
    putIdentity(realToLogical, replacement.newIssueId, replacement.logicalNodeId);
    putIdentity(realToLogical, replacement.newIssueKey, replacement.logicalNodeId);
  }

  const currentNodes = liveTree.nodes.map(node => {
    const mapped = realToLogical.get(String(node.id)) ?? realToLogical.get(String(node.key));
    const currentLogicalNodeId = mapped ?? logicalNodeId(node.id);
    const parent = node.fields?.parent;
    const parentIdentity = parent?.id ?? parent?.key;
    const parentLogicalId = parent == null ? null
      : realToLogical.get(String(parentIdentity)) ?? logicalNodeId(parentIdentity);
    return {
      logicalNodeId: currentLogicalNodeId,
      parentLogicalId,
      projectId: Number(node.fields?.project?.id),
      issueTypeId: String(node.fields?.issuetype?.id ?? ''),
      digests: project(node.fields ?? {}, fieldsFor(node) ?? []).digests
    };
  });

  const diff = diffTree({ baselineTree, currentTree: { nodes: currentNodes }, controlledFields, scopeFor: fieldsFor });
  const baselineRoot = (baselineTree?.nodes ?? []).find(node => parentOf(node) == null);
  const liveRoot = baselineRoot
    ? liveTree.nodes.find(node => realToLogical.get(String(node.id)) === String(baselineRoot.logicalNodeId)
      || realToLogical.get(String(node.key)) === String(baselineRoot.logicalNodeId))
    : null;
  const statusMatches = expectedRootStatusId == null
    ? true
    : String(liveRoot?.fields?.status?.id ?? '') === String(expectedRootStatusId);
  const baselineIds = new Set((baselineTree?.nodes ?? []).map(node => String(node.logicalNodeId)));
  const mappedCount = currentNodes.filter(node => baselineIds.has(String(node.logicalNodeId))).length;

  const nodeKeys = new Map();
  for (const node of baselineTree?.nodes ?? []) {
    nodeKeys.set(String(node.logicalNodeId), node.issueKey ?? node.key ?? null);
  }
  for (const replacement of replacements) {
    nodeKeys.set(String(replacement.logicalNodeId), replacement.newIssueKey ?? replacement.newIssueId ?? null);
  }
  const fieldNames = new Map([...controlledFields, ...(baselineTree?.nodes ?? []).flatMap(node => fieldsFor(node) ?? [])]
    .map(field => [String(field.field_id), field.field_name ?? String(field.field_id)]));
  const baselineDigestsById = new Map((baselineTree?.nodes ?? []).map(node =>
    [String(node.logicalNodeId), node.digests ?? {}]));
  const observedDigestsById = new Map(currentNodes.map(node =>
    [String(node.logicalNodeId), node.digests ?? {}]));

  const unmatched = diff.changes.flatMap(change =>
    describeChange(change, { nodeKeys, fieldNames, baselineDigestsById, observedDigestsById }));
  if (!statusMatches) {
    unmatched.push({ logicalNodeId: baselineRoot ? String(baselineRoot.logicalNodeId) : null,
      issueKey: rootIssueKey, kind: 'STATUS_CHANGED', fieldId: 'status', fieldName: 'Status',
      expected: expectedRootStatusId == null ? null : String(expectedRootStatusId),
      actual: liveRoot?.fields?.status?.id == null ? null : String(liveRoot.fields.status.id),
      reason: 'The work item is no longer in the baseline review status, so restoration cannot be confirmed.' });
  }

  const matches = diff.changes.length === 0 && statusMatches;
  if (!matches) {
    // Logged at the boundary where the fact is first known, so the harness can
    // answer "why was that partial?" without anyone reading the database.
    harnessLog('RESTORE', 'verify:unmatched', { rootIssueKey, unmatchedCount: unmatched.length,
      unmatched: unmatched.slice(0, 20) }, 'WARN');
  }

  return {
    matches,
    replacements,
    progress: mappedCount > 0,
    statusMatches,
    changes: diff.changes,
    unmatched
  };
}

/**
 * A field that does not match because Jira REFUSED to write it is not a field
 * "Jira accepted but something overrode". The verifier cannot tell the two
 * apart; the executor's refusals can. This names the refusal, in Jira's words,
 * for every unmatched field a refused step was meant to write.
 */
export function explainRefusals(unmatched, refused) {
  const byNodeField = new Map();
  for (const entry of refused ?? []) {
    const detail = entry?.error?.detail ?? entry?.error?.message ?? null;
    if (!detail) continue;
    // A link conflict is the APP declining, with its own sentence; it is not
    // Jira refusing anything (../restore/linkConflicts.js).
    byNodeField.set(`${entry.logicalNodeId}:*`,
      entry?.error?.code === 'LINK_CONFLICT' ? detail : `Jira refused to write it: ${detail}`);
  }
  return (unmatched ?? []).map(entry => {
    const reason = byNodeField.get(`${entry.logicalNodeId}:*`);
    return reason && entry.kind === 'FIELD_CHANGED' ? { ...entry, reason } : entry;
  });
}
