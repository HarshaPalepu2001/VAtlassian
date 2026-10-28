import { linkStateUnknown } from '../../src/lib/restore/linkConflicts.js';
import { explainRefusals } from '../../src/lib/tree/restoreVerifier.js';
import { logicalNodeId } from '../../src/lib/tree/model.js';

export const safeVerificationGuidance = 'Jira accepted the restore but this tracked field does not hold its approved value. '
  + 'A screen configuration, a field validator or a workflow post-function may be overriding it.';
export const opaquePrivateText = 'confidential payroll threshold for the restricted acquisition';

/** Real worker refusal shaping, with numeric-only and unstructured private data. */
export function opaqueRestoreEvidence(issueKey = 'T-10', issueId = 10) {
  const nodeId = logicalNodeId(issueId);
  const refused = [
    { logicalNodeId: nodeId, issueKey, kind: 'RESTORE_LINKS', error: linkStateUnknown('99') },
    { logicalNodeId: nodeId, issueKey, kind: 'RESTORE_FIELDS', error: { message: opaquePrivateText,
      detail: opaquePrivateText, nested: { detail: opaquePrivateText } } }
  ];
  const unmatched = explainRefusals([
    { logicalNodeId: nodeId, issueKey, kind: 'FIELD_CHANGED', fieldId: 'issuelinks', fieldName: 'Issue links', reason: safeVerificationGuidance }
  ], [refused[0]]).concat(explainRefusals([
    { logicalNodeId: nodeId, issueKey, kind: 'FIELD_CHANGED', fieldId: 'description', fieldName: 'Description', reason: safeVerificationGuidance }
  ], [refused[1]]), [
    { logicalNodeId: nodeId, issueKey, kind: 'FIELD_CHANGED', fieldId: 'summary', fieldName: 'Summary', reason: safeVerificationGuidance },
    { logicalNodeId: nodeId, issueKey, kind: 'FIELD_CHANGED', fieldId: 'labels', fieldName: 'Labels',
      reason: opaquePrivateText, actual: { error: { detail: opaquePrivateText, message: opaquePrivateText } } }
  ]);
  return [{ unmatched, refused }];
}

export function assertOpaqueEvidenceHidden(assert, result) {
  assert.doesNotMatch(JSON.stringify(result), /Left the link to 99|99 is approved|confidential payroll threshold|restricted acquisition/);
}
