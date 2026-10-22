/**
 * WHAT AN APPROVAL CONTENT HASH WAS COMPUTED OVER.
 *
 * Two hashes that disagree say nothing about why. This is the small, secret-free
 * description both sides log (the approval when it is signed, the validator when
 * it recomputes): tree or flat, which scope the tracked fields came from, which
 * field ids they were, and how the issue's attachments read (the rich-text flag
 * removes a file from the hash). Logged only; never stored or audited.
 */
export function hashBasis({ mode, scopeSource = null, scopeIssueTypeId = null, fields = [], issue = null, linkPolicy = null }) {
  const attachments = Array.isArray(issue?.fields?.attachment) ? issue.fields.attachment : [];
  return {
    mode,
    ...(normaliseLinkPolicy(linkPolicy).version === 2 ? { linkPolicy: 2, linkPolicyHash: linkPolicyHash(linkPolicy) } : {}),
    scopeSource,
    scopeIssueTypeId: scopeIssueTypeId == null ? null : String(scopeIssueTypeId),
    fieldIds: fields.map(field => String(field.field_id)).sort(),
    attachments: attachments.map(a => ({ id: String(a?.id ?? ''), isRichText: Boolean(a?.isRichText),
      hasMediaId: Boolean(a?.mediaId) }))
  };
}
import { normaliseLinkPolicy, linkPolicyHash } from './linkPolicy.js';
