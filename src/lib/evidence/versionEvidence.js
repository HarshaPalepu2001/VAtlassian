import { canonical, sha256Hex } from '../hash.js';
import { FailClosed } from '../errors.js';
import { FIELD_KIND } from '../content.js';
import { governedLinks } from '../linkPolicy.js';

/**
 * Build one baseline version's evidence rows from capture-time fields,
 * digests, rule and signer. The stored version can then be read without
 * consulting current configuration. Refuse capture if evidence is missing.
 * See docs/specs/2026-10-03-baseline-evidence-model-design.md section 4.
 */
export const CAUSE = Object.freeze({
  OWN_TRANSITION: 'OWN_TRANSITION',
  PARENT_CAPTURE: 'PARENT_CAPTURE',
  DRIFT_DECISION: 'DRIFT_DECISION',
  MIXED_DECISION: 'MIXED_DECISION',
  LINK_RECORD: 'LINK_RECORD',
  MIGRATED: 'MIGRATED'
});
export const RULE_SOURCE = Object.freeze({ OWN: 'OWN', INHERITED: 'INHERITED' });
/** A link record queued before signer roles travelled with the job: said, not guessed. */
export const UNRECORDED_ROLE = 'UNRECORDED';

const POLICY = 'BASELINE_POLICY_INCOMPLETE';
const INCOMPLETE = 'CAPTURE_INCOMPLETE';
const hex = id => (id == null ? null : Buffer.from(id).toString('hex'));
const present = value => typeof value === 'string' ? value.trim().length > 0 : value != null;

function bool(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

function integer(value, min = 1) {
  // Must be a number or a numeric string like '-5' or '123', never null, '', false, NaN, or Infinity.
  if ((typeof value === 'number' || (typeof value === 'string' && /^-?\d+$/.test(value)))
    && Number.isSafeInteger(Number(value)) && Number(value) >= min) {
    return true;
  }
  return false;
}

export function parseDigests(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* refused below */ }
  throw new FailClosed(INCOMPLETE);
}

/** A rule's identity within a version: its source and the version that imposed it. */
export function ruleKey({ source, projectId, issueTypeId, imposedByBaselineId = null }) {
  return sha256Hex(canonical({ s: source, p: Number(projectId), t: String(issueTypeId),
    by: hex(imposedByBaselineId) })).slice(0, 32);
}

function ruleRow(rule) {
  if (!Object.values(RULE_SOURCE).includes(rule?.source)) throw new FailClosed(POLICY);
  // Cross-field: INHERITED requires both imposedByBaselineId AND imposedByVersion; OWN must have neither.
  if (rule.source === RULE_SOURCE.INHERITED) {
    if (rule.imposedByBaselineId == null || !integer(rule.imposedByVersion)) throw new FailClosed(POLICY);
  } else if (rule.source === RULE_SOURCE.OWN) {
    if (rule.imposedByBaselineId != null || rule.imposedByVersion != null) throw new FailClosed(POLICY);
  }
  if (!integer(rule.projectId) || !present(rule.issueTypeId)) throw new FailClosed(POLICY);
  if (!Array.isArray(rule.approvers)) throw new FailClosed(POLICY);
  if (!rule.approvers.length || rule.approvers.some(a => !present(a?.role) || !present(a?.assurance))) throw new FailClosed(POLICY);
  return {
    rule_key: ruleKey(rule),
    source: rule.source,
    project_id: Number(rule.projectId),
    issue_type_id: String(rule.issueTypeId),
    transition_id: rule.transitionId == null ? null : String(rule.transitionId),
    approvers: JSON.stringify(rule.approvers.map(({ role, assurance }) => ({ role: String(role), assurance: String(assurance) }))),
    controlled_fields_hash: rule.controlledFieldsHash ?? null,
    imposed_by_baseline_id: rule.imposedByBaselineId ?? null,
    imposed_by_version: rule.imposedByVersion == null ? null : Number(rule.imposedByVersion)
  };
}

function signatureRow(signature, defaultCovered) {
  const s = signature ?? {};
  if (!s.approvalId || !present(s.signerAccountId) || !present(s.role) || !present(s.assurance)
    || !Object.values(CAUSE).includes(s.cause) || !integer(s.signedAt, 0)) {
    throw new FailClosed(POLICY);
  }
  // Cross-field: PARENT_CAPTURE requires causeBaselineId.
  if (s.cause === CAUSE.PARENT_CAPTURE && s.causeBaselineId == null) throw new FailClosed(POLICY);
  // transitionAt must be a valid integer when present.
  if (s.transitionAt != null && !integer(s.transitionAt, 0)) throw new FailClosed(POLICY);
  // fieldsCovered when given must be a non-empty array of strings.
  if (s.fieldsCovered != null && (!Array.isArray(s.fieldsCovered) || !s.fieldsCovered.length
    || !s.fieldsCovered.every(f => typeof f === 'string'))) {
    throw new FailClosed(POLICY);
  }
  return {
    approval_id: s.approvalId,
    signer_account_id: String(s.signerAccountId),
    signer_name: String(s.signerName ?? s.signerAccountId),
    role: String(s.role),
    assurance: String(s.assurance),
    cause: s.cause,
    cause_baseline_id: s.causeBaselineId ?? null,
    decision_id: null,
    transition_id: s.transitionId == null ? null : String(s.transitionId),
    from_status_id: s.fromStatusId == null ? null : String(s.fromStatusId),
    to_status_id: s.toStatusId == null ? null : String(s.toStatusId),
    transition_at: s.transitionAt == null ? null : Number(s.transitionAt),
    status_at_capture: s.statusAtCapture == null ? null : String(s.statusAtCapture),
    fields_covered: JSON.stringify(s.fieldsCovered ?? defaultCovered),
    signed_at: Number(s.signedAt)
  };
}

function digestFor(byField, fieldId) {
  const digest = byField[fieldId];
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new FailClosed(INCOMPLETE);
  return digest;
}

export function versionEvidence({ fields, digests, writable = {}, rule, signature }) {
  if (!Array.isArray(fields) || fields.length === 0) throw new FailClosed(INCOMPLETE);
  const byField = parseDigests(digests);
  const ids = fields.map(field => String(field.field_id));
  if (Object.keys(byField).some(id => !ids.includes(id))) throw new FailClosed(INCOMPLETE);
  const rules = [ruleRow(rule)];
  const key = rules[0].rule_key;
  const fieldRows = fields.map(field => {
    const id = String(field.field_id);
    if (!present(field.field_kind) || !present(field.materiality)) throw new FailClosed(POLICY);
    const restorable = Object.prototype.hasOwnProperty.call(writable, id) ? bool(writable[id]) : bool(field.writable);
    return {
      field_id: id,
      label: String(field.field_name ?? id),
      label_source: 'CAPTURE',
      kind: String(field.field_kind),
      schema_type: field.schema_type ?? null,
      materiality: String(field.materiality),
      store_values: bool(field.store_values) === true,
      restorable,
      digest: digestFor(byField, id),
      required_by: JSON.stringify([key])
    };
  });
  return { fields: fieldRows, rules, signatures: [signatureRow(signature, ids)] };
}

/**
 * A version that re-records only links, on another issue's approval
 * (jobs/linkWorker.js): the signed definitions and rules of the version it
 * derives from, with the derived digests, and its own signature. A source whose
 * policy was never recorded gives only the signature: `recorded` says which.
 */
export function derivedEvidence({ source, digests, signature }) {
  const byField = parseDigests(digests);
  const fieldsLen = source?.fields?.length ?? 0;
  const rulesLen = source?.rules?.length ?? 0;
  // Fields-xor-rules is refused: either BOTH present (recorded) or BOTH absent (never recorded).
  if ((fieldsLen > 0) !== (rulesLen > 0)) throw new FailClosed(INCOMPLETE);
  const recorded = fieldsLen > 0 && rulesLen > 0;
  if (!recorded) return { recorded, fields: [], rules: [], signatures: [signatureRow(signature, Object.keys(byField))] };
  const ids = source.fields.map(field => String(field.field_id));
  if (Object.keys(byField).some(id => !ids.includes(id))) throw new FailClosed(INCOMPLETE);
  const fields = source.fields.map(field => ({
    field_id: String(field.field_id), label: field.label, label_source: field.label_source, kind: field.kind,
    schema_type: field.schema_type ?? null, materiality: field.materiality, store_values: field.store_values === true,
    restorable: field.restorable ?? null, digest: digestFor(byField, String(field.field_id)),
    required_by: JSON.stringify(field.required_by)
  }));
  const rules = source.rules.map(rule => ({ ...rule, approvers: JSON.stringify(rule.approvers) }));
  return { recorded, fields, rules, signatures: [signatureRow(signature, ids)] };
}

/** The links a version records: only when it tracks a link field. */
export function trackedLinks(fields, issueFields, linkContext = {}) {
  const field = (fields ?? []).find(f => f.field_kind === FIELD_KIND.LINKS);
  if (!field) return null;
  return governedLinks(issueFields?.[field.field_id] ?? [], linkContext);
}

export function linkedIssueIds(links) {
  if (links != null && !Array.isArray(links)) throw new FailClosed(INCOMPLETE);
  return [...new Set((links ?? [])
    .map(link => Number((link?.outwardIssue ?? link?.inwardIssue)?.id))
    .filter(Number.isSafeInteger))];
}

function versionOf(otherVersions, issueId) {
  return otherVersions.get(issueId) ?? otherVersions.get(String(issueId)) ?? null;
}

export function linkRows({ links, otherVersions = new Map() }) {
  if (links == null) return [];
  if (!Array.isArray(links)) throw new FailClosed(INCOMPLETE);
  if (!(otherVersions instanceof Map)) throw new FailClosed(INCOMPLETE);
  return links.map(link => {
    const outward = link?.outwardIssue;
    const other = outward ?? link?.inwardIssue;
    const type = link?.type?.id;
    if (!present(link?.id) || !present(type) || !integer(other?.id) || !present(other?.key)) throw new FailClosed(INCOMPLETE);
    const otherId = Number(other.id);
    const version = versionOf(otherVersions, otherId);
    if (version != null && !integer(version.version)) throw new FailClosed(INCOMPLETE);
    return {
      link_id: String(link.id),
      link_type: String(type),
      direction: outward ? 'OUTWARD' : 'INWARD',
      other_issue_id: otherId,
      other_issue_key: String(other.key),
      other_baseline_id: version?.baseline_id ?? null,
      other_baseline_version: version ? Number(version.version) : null
    };
  });
}
