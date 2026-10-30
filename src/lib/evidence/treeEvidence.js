import { versionEvidence, linkRows, trackedLinks, linkedIssueIds, CAUSE, RULE_SOURCE } from './versionEvidence.js';

/**
 * Record Jira's node security levels for va_baseline_node using
 * db/evidenceStore.js recordNodeSecurity. This function is pure.
 *
 * Jira returns security: null for no level and omits security when the app
 * cannot see it. Omitted levels and levels without a readable id become
 * UNKNOWN, which the deleted-node rule treats as hidden. Null records nothing.
 * See spec section 8.1 and rollout step 4, section 9.5.
 */
export function nodeSecurityLevels(nodes) {
  return (nodes ?? []).flatMap(node => {
    const fields = node?.fields ?? {};
    if (Object.hasOwn(fields, 'security') && fields.security === null) return [];
    const id = Object.hasOwn(fields, 'security') ? fields.security?.id : null;
    return [{ issueId: Number(node?.id), securityLevelId: id == null ? 'UNKNOWN' : String(id) }];
  });
}

/**
 * Build evidence for the parent's version and every child version before
 * publication. Child rules are inherited from the parent capture.
 * A retry creates new child ids, so rewrite evidence for those new versions.
 * See docs/specs/2026-10-03-baseline-evidence-model-design.md sections 4 and 5.4.
 *
 * activeBaselines is the only read. It resolves versions for tracked links.
 */
export async function treeCaptureEvidence({ rootIssueId, parentBaselineId, parentVersion, rootDigests, controlledFields,
  children, nodeOf, fieldsFor, ruleScope, cause, policy, approval, transitionAt, signedAt, controlledFieldsHash,
  activeBaselines, linkPolicyFor = () => null }) {
  const rootSource = nodeOf(rootIssueId);
  const linksFor = (node, fields) => trackedLinks(fields, node?.fields, { issue: node, linkPolicy: linkPolicyFor(node) });
  const rootLinks = linksFor(rootSource, controlledFields);
  const childLinks = children.map(child => linksFor(nodeOf(child.issue_id), fieldsFor(nodeOf(child.issue_id))));
  const linked = linkedIssueIds([...(rootLinks ?? []), ...childLinks.flatMap(links => links ?? [])]);
  const otherVersions = linked.length ? await activeBaselines(linked) : new Map();
  const approvers = [{ role: policy?.required_role, assurance: policy?.required_assurance }];
  const signer = { approvalId: approval.approvalId, signerAccountId: approval.accountId, signerName: approval.displayName,
    role: policy?.required_role, assurance: approval.assuranceLevel, transitionId: policy?.transition_id ?? null,
    fromStatusId: policy?.from_status_id ?? null, toStatusId: policy?.to_status_id ?? null, transitionAt, signedAt };
  return [
    { baselineId: parentBaselineId, cause, links: linkRows({ links: rootLinks, otherVersions }),
      evidence: versionEvidence({ fields: controlledFields, digests: rootDigests,
        rule: { ...ruleScope, transitionId: policy?.transition_id ?? null, approvers, controlledFieldsHash },
        signature: { ...signer, cause, statusAtCapture: rootSource?.fields?.status?.id ?? null } }) },
    ...children.map((child, index) => ({ baselineId: child.baseline_id, cause: CAUSE.PARENT_CAPTURE,
      links: linkRows({ links: childLinks[index], otherVersions }),
      evidence: versionEvidence({ fields: fieldsFor(nodeOf(child.issue_id)), digests: child.field_digests,
        rule: { source: RULE_SOURCE.INHERITED, projectId: ruleScope.projectId, issueTypeId: ruleScope.issueTypeId,
          transitionId: policy?.transition_id ?? null, approvers, controlledFieldsHash: child.controlled_fields_hash,
          imposedByBaselineId: parentBaselineId, imposedByVersion: Number(parentVersion) },
        signature: { ...signer, cause: CAUSE.PARENT_CAPTURE, causeBaselineId: parentBaselineId,
          statusAtCapture: nodeOf(child.issue_id)?.fields?.status?.id ?? null } }) }))
  ];
}
