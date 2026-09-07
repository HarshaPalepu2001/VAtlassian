/**
 * RECORD EXPORT — 21 CFR 11.10(b).
 *
 * "The ability to generate accurate and complete copies of records in both
 * human readable and electronic form suitable for inspection, review, and
 * copying by the agency."
 *
 * This is the first thing an inspector asks for and it is the provision this
 * app scored worst on: the sealed-export design existed only as columns in
 * va_chain_segment behind a job that was three empty functions. An export is
 * not the archival pipeline, though — it is the far simpler thing the clause
 * actually names, and it does not need one: produce, on demand, a complete and
 * verifiable copy of the records in scope.
 *
 * BOTH FORMS FROM ONE SOURCE. The clause asks for human readable AND
 * electronic. Rendering them from the same object rather than assembling each
 * separately is the whole point: two builders would eventually disagree, and an
 * inspector holding a readable copy that does not match the electronic one is a
 * data integrity finding rather than a formatting bug.
 *
 * IT CARRIES ITS OWN PROOF. Every signature ships with the content hash it
 * attested to, and every audit entry with its prev_hash and entry_hash. The
 * recipient can therefore re-walk the chain themselves without our code and
 * without our word for it. A copy that can only be checked by the system that
 * produced it is not evidence — it is a claim.
 *
 * AND IT SAYS WHAT IT COULD NOT INCLUDE. `completeness` reports whether the
 * requested range was returned in full or truncated by a limit. An export that
 * silently returns the first N records looks identical to a complete one, and
 * "complete" is a word the clause actually uses.
 *
 * PURE. Assembly and rendering here; resolvers/admin.js supplies the rows.
 */
import { canonical, sha256Hex } from './hash.js';

export const EXPORT_FORMAT_VERSION = 2;

/**
 * Assemble the export document.
 *
 * `truncated` must be passed honestly by the caller: it is the difference
 * between "these are all the records" and "these are some of them".
 */
export function buildExport({
  signatures = [],
  approvals = signatures,
  baselines = [],
  auditEntries = [],
  scope = {},
  generatedAt,
  generatedBy,
  chainVerification = null,
  truncated = false
}) {
  const document = {
    formatVersion: EXPORT_FORMAT_VERSION,
    generatedAt,
    generatedBy,
    scope: {
      projectId: scope.projectId ?? null,
      fromMs: scope.fromMs ?? null,
      toMs: scope.toMs ?? null,
      description: describeScope(scope)
    },
    completeness: {
      truncated,
      signatureCount: approvals.length,
      approvalCount: approvals.length,
      baselineCount: baselines.length,
      auditEntryCount: auditEntries.length,
      // Stated rather than implied. An inspector reading "complete: false"
      // knows to ask for the rest; one reading a silently short list does not.
      note: truncated
        ? 'This export hit a size limit and does NOT contain every record in the requested scope. Narrow the range and export again.'
        : 'This export contains every record in the requested scope.'
    },
    chainVerification: chainVerification
      ? {
          verified: chainVerification.ok === true,
          checked: chainVerification.checked ?? null,
          brokenAt: chainVerification.brokenAt ?? null,
          reason: chainVerification.reason ?? null
        }
      : { verified: null, note: 'Chain not verified as part of this export.' },
    approvals: approvals.map(normaliseSignature),
    signatures: approvals.map(normaliseSignature), // compatibility for existing export consumers
    baselines: baselines.map(normaliseBaseline),
    auditEntries: auditEntries.map(normaliseAuditEntry)
  };

  // The hash covers the document WITHOUT this field, so a recipient can
  // recompute it by removing it — the usual self-reference problem, solved the
  // usual way and stated so nobody has to guess the convention.
  const sha256 = sha256Hex(canonical(document));
  return { document, sha256 };
}

function describeScope(scope) {
  const parts = [];
  parts.push(scope.projectId ? `Project ${scope.projectId}` : 'All projects');
  if (scope.fromMs) parts.push(`from ${new Date(scope.fromMs).toISOString()}`);
  if (scope.toMs) parts.push(`to ${new Date(scope.toMs).toISOString()}`);
  return parts.join(' ');
}

/**
 * One signature, in the shape 11.50 asks a signed record to show: who, when,
 * and what the signature meant — plus what it was bound to.
 */
function normaliseSignature(row) {
  const signedAt = row.signed_at ?? row.created_at ?? row.decided_at ?? null;
  return {
    approvalId: row.approval_id ?? null,
    issueId: row.issue_id ?? null,
    issueKey: row.issue_key ?? null,
    projectId: row.project_id ?? null,
    // 11.50(a): printed name, date/time, meaning.
    printedName: row.printed_name ?? row.actor_name ?? null,
    signedAt,
    signedAtIso: signedAt != null ? new Date(Number(signedAt)).toISOString() : null,
    meaning: row.meaning ?? null,
    signerRole: row.signer_role ?? null,
    accountId: row.account_id ?? row.actor_account_id ?? null,
    assuranceLevel: row.assurance_level ?? null,
    assuranceDescription: describeAssurance(row.assurance_level),
    providerId: row.provider_id ?? null,
    providerRef: row.provider_ref ?? null,
    providerEvidence: safeParse(row.provider_evidence),
    evidenceHash: row.evidence_hash ?? null,
    decision: row.decision ?? null,
    note: row.note ?? null,
    transition: {
      fromStatusId: row.from_status_id ?? null,
      toStatusId: row.to_status_id ?? null,
      transitionId: row.transition_id ?? null
    },
    // 11.70: what this signature is linked to, and how the link is checkable.
    contentHash: row.content_hash ?? null,
    recordVersion: row.record_version ?? null,
    state: row.state ?? null,
    consumedAt: row.consumed_at ?? null,
    consumedAtIso: row.consumed_at ? new Date(Number(row.consumed_at)).toISOString() : null
  };
}

/** One ledger entry, with both hashes so the chain can be re-walked offline. */
function normaliseAuditEntry(row) {
  return {
    seq: row.seq ?? null,
    approvalId: row.approval_id ?? null,
    occurredAt: row.occurred_at ?? null,
    occurredAtIso: row.occurred_at ? new Date(Number(row.occurred_at)).toISOString() : null,
    actorAccountId: row.actor_account_id ?? null,
    eventType: row.event_type ?? null,
    issueId: row.issue_id ?? null,
    payload: safeParse(row.payload),
    prevHash: row.prev_hash ?? null,
    entryHash: row.entry_hash ?? null
  };
}

function safeParse(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return { unparsed: String(value) }; }
}

/**
 * The human-readable form.
 *
 * Plain text on purpose. It has to survive being printed, pasted into a finding
 * response, and read on a terminal by someone who will not install anything to
 * see it — which rules out a format that needs a viewer to be trustworthy.
 */
export function renderHuman({ document, sha256 }) {
  const lines = [];
  const rule = '='.repeat(72);

  lines.push(rule);
  lines.push('ELECTRONIC SIGNATURE RECORD EXPORT');
  lines.push('VAtlassian — approval and baseline records');
  lines.push(rule);
  lines.push(`Generated:      ${new Date(document.generatedAt).toISOString()}`);
  lines.push(`Generated by:   ${document.generatedBy}`);
  lines.push(`Scope:          ${document.scope.description}`);
  lines.push(`Signatures:     ${document.completeness.signatureCount}`);
  lines.push(`Baselines:      ${document.completeness.baselineCount}`);
  lines.push(`Audit entries:  ${document.completeness.auditEntryCount}`);
  lines.push(`Complete:       ${document.completeness.truncated ? 'NO — TRUNCATED' : 'yes'}`);
  if (document.completeness.truncated) lines.push(`  ${document.completeness.note}`);

  const cv = document.chainVerification;
  lines.push(`Audit chain:    ${cv.verified === true ? 'VERIFIED' : cv.verified === false ? `BROKEN at entry ${cv.brokenAt} (${cv.reason})` : 'not verified in this export'}`);
  lines.push(`Export SHA-256: ${sha256}`);
  lines.push('');

  lines.push(rule);
  lines.push('SIGNATURES');
  lines.push(rule);
  if (document.signatures.length === 0) lines.push('(none in scope)');
  for (const s of document.signatures) {
    lines.push('');
    lines.push(`Work item:      ${s.issueKey ?? s.issueId}`);
    lines.push(`Signed by:      ${s.printedName}  (${s.accountId})`);
    lines.push(`Date and time:  ${s.signedAtIso}`);
    lines.push(`Meaning:        ${s.meaning}`);
    lines.push(`Assurance:      ${s.assuranceLevel ?? "unknown"} — ${s.assuranceDescription}`);
    lines.push(`Signer role:    ${s.signerRole}`);
    lines.push(`Transition:     status ${s.transition.fromStatusId} -> ${s.transition.toStatusId}`);
    lines.push(`State:          ${s.state}${s.consumedAtIso ? ` (consumed ${s.consumedAtIso})` : ''}`);
    lines.push(`Content hash:   ${s.contentHash}  (record version ${s.recordVersion})`);
  }

  lines.push('');
  lines.push(rule);
  lines.push('BASELINES');
  for (const b of document.baselines) {
    lines.push(`Work item: ${b.issueKey ?? b.issueId}  version=${b.version}  baseline=${b.baselineId}`);
    lines.push(`Approval: ${b.approvalId}  assurance=${b.assuranceLevel ?? 'unknown'} — ${b.assuranceDescription}`);
    lines.push(`Content hash: ${b.contentHash}  fidelity=${b.fidelity}`);
  }
  lines.push(rule);
  lines.push('AUDIT TRAIL');
  lines.push('Hash-chained. Each entry links to the one before it by prev_hash.');
  lines.push(rule);
  if (document.auditEntries.length === 0) lines.push('(none in scope)');
  for (const e of document.auditEntries) {
    lines.push(`#${e.seq}  ${e.occurredAtIso}  ${e.eventType}  actor=${e.actorAccountId}${e.issueId ? `  item=${e.issueId}` : ''}`);
    lines.push(`      prev=${e.prevHash}`);
    lines.push(`      this=${e.entryHash}`);
  }

  lines.push('');
  lines.push(rule);
  lines.push('END OF EXPORT');
  lines.push(`SHA-256 of the electronic form: ${sha256}`);
  lines.push(rule);
  return lines.join('\n');
}

/** The electronic form: the document as canonical JSON, byte-for-byte what the
 *  SHA-256 above was computed over, so a recipient can verify it directly. */
export function renderElectronic({ document }) {
  return canonical(document);
}

/** No credential claim is inferred for a record lacking assurance metadata. */
export function describeAssurance(level) {
  return {
    NATIVE_TRANSITION: 'Approved through an authenticated Jira workflow transition.',
    JSM_APPROVAL: 'Approved through a Jira Service Management approval.',
    ESIGNATURE: 'Electronic signature confirmed using a one-time authenticator code.',
    BIOMETRIC: 'Biometric assurance is reserved and is not configured in this release.'
  }[level] ?? 'Assurance was not recorded.';
}

function normaliseBaseline(row) {
  return {
    baselineId: row.baseline_id ?? null,
    issueId: row.issue_id ?? null,
    issueKey: row.issue_key ?? null,
    version: row.version ?? null,
    approvalId: row.approval_id ?? null,
    assuranceLevel: row.assurance_level ?? null,
    assuranceDescription: describeAssurance(row.assurance_level),
    contentHash: row.content_hash ?? null,
    fieldDigests: safeParse(row.field_digests),
    fidelity: row.fidelity ?? null,
    capturedAt: row.captured_at ?? null,
    state: row.state ?? null
  };
}
