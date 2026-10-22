import { project } from '../content.js';
import { planTreeCapture } from '../tree/capturePlan.js';
import { baselineLinkPolicy, normaliseLinkPolicy, resolveNewLinkPolicy,
  hydrateLinkPolicyIssue, hydrateLinkPolicyNodes, treeLinkPolicyResolver } from '../linkPolicy.js';

/** Review evidence stays in the standing domain; the new signature freezes its own domain. */
export async function prepareApprovalLinkPolicy(prepared, { decision, linkPolicy,
  resolve = resolveNewLinkPolicy, readIssue } = {}) {
  const selected = linkPolicy === undefined
    ? decision === 'APPROVE' ? await resolve(prepared.issue) : baselineLinkPolicy(prepared.baseline)
    : normaliseLinkPolicy(linkPolicy);
  const policyFor = decision === 'MIXED'
    ? treeLinkPolicyResolver(prepared.baselineTree, selected) : () => selected;
  const issue = await hydrateLinkPolicyIssue(prepared.issue, selected, readIssue);
  const projection = project(issue.fields, prepared.fields, { issue, linkPolicy: selected });
  let contentHash = projection.contentHash;
  if (prepared.tree) {
    const nodes = await hydrateLinkPolicyNodes(prepared.tree.nodes, policyFor, readIssue);
    contentHash = planTreeCapture({ rootIssueId: issue.id, nodes,
      controlledFields: prepared.fields, fieldsFor: prepared.fieldsFor, linkPolicy: selected, policyFor }).treeHash;
  }
  return { ...prepared, issue, linkPolicy: selected, linkPolicyFor: policyFor,
    contentHash, digests: projection.digests };
}
