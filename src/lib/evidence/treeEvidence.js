import { versionEvidence, linkRows, trackedLinks, linkedIssueIds, CAUSE, RULE_SOURCE } from './versionEvidence.js';

/**
 * Each node's security level as Jira gave it, for va_baseline_node
 * (db/evidenceStore.js recordNodeSecurity). Pure.
 *
 * ABSENT IS NOT "NO LEVEL". Jira gives `security: null` for a node with no
 * level, and leaves the field out when the app could not see it (tree/jira.js
 * reads it so). An unseen level is recorded as UNKNOWN, which the deleted-node
 * rule (spec §8.1, read from rollout step 4, §9.5) treats as hidden; a level
 * with no readable id is equally unseen. Only a null is no level, and records
 * nothing.
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
 * THE EVIDENCE OF EVERY VERSION A TREE CAPTURE WRITES
 * (docs/specs/2026-10-03-baseline-evidence-model-design.md §4, §5.4): the
 * parent's own, and each child's, whose rule is the parent's, inherited from
 * this capture. Written before anything publishes; publication requires it.
 * A retried capture rewrites its children under new ids; evidence left under
 * the old ids names versions that no longer exist and is never read.
 *
 * Pure but for `activeBaselines`, the one read of the versions the tracked
 * links point at.
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
