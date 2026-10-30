/**
 * Describe the inputs used to compute an approval content hash.
 *
 * Signing and validation log the same secret-free details: tree/flat mode,
 * tracked-field scope and IDs, and attachment handling. The rich-text flag
 * excludes a file from hashing. These diagnostics are logged, not stored or audited.
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
