import { executeQuery } from '../lib/db.js';
import { ELIGIBILITY_PREDICATE, eligibilityParams, rowAuthorises } from '../lib/eligibility.js';
import { FailClosed } from '../lib/errors.js';
import { TM_ASSURANCE } from './chain.js';
import crypto from 'node:crypto';

/**
 * ONE SIGNING STEP, WITH THE SAME CONTROLS AS EVERY OTHER VAtlassian SIGNATURE.
 *
 * Owner decision 4: the role, the assurance level, a signature bound to the
 * content hash and usable exactly once, and an audit entry. Here that is:
 *   - eligibility: the same va_eligibility predicate the gate uses;
 *   - assurance: the signer's authenticator code (lib/approval/totpVerification.js);
 *   - content: the caller recomputes the hash on the server and compares it
 *     with the hash the signer was shown; any difference is CONTENT_CHANGED;
 *   - once: tm_signature's primary key is (kind, subject, step);
 *   - audit: an entry in the va_audit hash chain. If it cannot be written the
 *     signature row is removed again and the step reports LEDGER_UNAVAILABLE:
 *     an unrecorded signature must not take effect (lib/ledger.js).
 */

/**
 * Does this person hold the role for this subject? A chain's subject is
 * anchored on a Jira work item (the Test for a version, the Test Execution for
 * a run), so its work type is the grant's issue type, under the same
 * predicate as every other VAtlassian signature: a grant for that type, or
 * for every type ('*').
 */
export async function isEligibleFor({ accountId, projectId, issueTypeId, role }) {
  if (!issueTypeId) throw new Error('isEligibleFor: the subject\'s work type is required');
  const result = await executeQuery(`SELECT 1 AS ok FROM va_eligibility WHERE ${ELIGIBILITY_PREDICATE} LIMIT 1`,
    eligibilityParams({ accountId, issueTypeId: String(issueTypeId), role, state: 'ACTIVE', projectId }));
  if (!result.result) throw new FailClosed('SERVICE_UNAVAILABLE');
  return result.data.length > 0;
}

/**
 * Who holds each role for this subject, judged row by row with the in-memory
 * twin of isEligibleFor's predicate (lib/eligibility.js#rowAuthorises), so a
 * chain the preflight passes is one its holders can actually sign.
 */
export async function roleHolders({ projectId, issueTypeId, roles }) {
  const unique = [...new Set(roles)];
  if (!unique.length) return {};
  if (!issueTypeId) throw new Error('roleHolders: the subject\'s work type is required');
  const marks = unique.map(() => '?').join(', ');
  const result = await executeQuery(`SELECT account_id, role, issue_type_id, project_id, state FROM va_eligibility
    WHERE state = 'ACTIVE' AND role IN (${marks}) AND (project_id = ? OR project_id IS NULL)`, [...unique, String(projectId)]);
  if (!result.result) throw new FailClosed('SERVICE_UNAVAILABLE');
  return holdersFrom(result.data, { projectId, issueTypeId, roles: unique });
}

/** Role → distinct account ids, from eligibility rows, by rowAuthorises. */
export function holdersFrom(rows, { projectId, issueTypeId, roles }) {
  const holders = Object.fromEntries(roles.map(r => [r, []]));
  for (const row of rows ?? []) {
    const list = holders[row.role];
    if (!list || list.includes(row.account_id)) continue;
    if (rowAuthorises(row, { projectId, issueTypeId: String(issueTypeId), role: row.role })) list.push(row.account_id);
  }
  return holders;
}

/**
 * Verify the code, then record the signature and its audit entry.
 * Returns { ok: true, signature } or { ok: false, reason, message }.
 *
 * deps: verifyTotp, insertSignature, deleteSignature, audit, now
 */
export async function recordSignature({ kind, subjectId, stepIndex, step, signer, decision, reason = null,
  contentHash, code, issueId, payload }, deps) {
  const verified = await deps.verifyTotp(signer.accountId, code, { issueId, purpose: `TM_${kind}` });
  if (!verified.ok) return { ok: false, reason: verified.reason, message: verified.error };
  const signature = {
    kind, subjectId, stepIndex, accountId: signer.accountId, printedName: signer.displayName,
    role: step.role, label: step.label, meaning: decision === 'REJECT' ? `Rejected: ${step.label}` : step.meaning,
    decision, reason, contentHash, assuranceLevel: TM_ASSURANCE, signedAt: deps.now(), state: 'PENDING',
    auditEventId: crypto.randomBytes(16).toString('hex')
  };
  if (!await deps.insertSignature(signature)) return { ok: false, reason: 'ALREADY_SIGNED' };
  let proof;
  try {
    proof = await deps.audit({ eventId: Buffer.from(signature.auditEventId, 'hex'),
      eventType: decision === 'SIGN' ? 'TM_SIGNED' : decision === 'REJECT' ? 'TM_REJECTED' : 'TM_NOT_EXECUTED',
      actorAccountId: signer.accountId, issueId: Number(issueId),
      payload: { kind, subjectId, stepIndex, label: step.label, role: step.role, meaning: signature.meaning,
        printedName: signer.displayName, contentHash, assuranceLevel: TM_ASSURANCE, reason, ...payload } });
  } catch {
    // A failed compensation remains PENDING and blocks the slot. It never
    // becomes a signature merely because deleting it failed too.
    await deps.deleteSignature({ kind, subjectId, stepIndex, auditEventId: signature.auditEventId }).catch(() => {});
    return { ok: false, reason: 'LEDGER_UNAVAILABLE' };
  }
  const activated = await deps.activateSignature({ kind, subjectId, stepIndex, auditEventId: signature.auditEventId, proof });
  if (!activated) throw new FailClosed('SIGNATURE_PENDING');
  return { ok: true, signature: { ...signature, state: 'ACTIVE', auditSeq: proof.seq, auditHash: proof.entryHash } };
}
