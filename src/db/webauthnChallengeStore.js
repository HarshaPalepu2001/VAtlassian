import { affectedRows, executeQuery, fromBinaryColumn, limitClause, toBinaryParam } from '../lib/db.js';
import { WEBAUTHN_CHALLENGE_TTL_MS } from '../lib/webauthn.js';
import { newId, throwing } from './store.js';

const CHALLENGE_COLUMNS = `
  TO_BASE64(challenge_id) AS challenge_id, account_id, purpose, challenge,
  binding_hash, issue_id, TO_BASE64(approval_challenge_id) AS approval_challenge_id,
  rp_id, created_at, expires_at, consumed_at
`;

function decode(row) {
  if (!row) return null;
  return {
    ...row,
    challenge_id: fromBinaryColumn(row.challenge_id),
    approval_challenge_id: fromBinaryColumn(row.approval_challenge_id)
  };
}

export async function issueWebAuthnChallenge({
  accountId,
  purpose,
  challenge,
  bindingHash = null,
  issueId = null,
  approvalChallengeId = null,
  rpId,
  now,
  ttlMs = WEBAUTHN_CHALLENGE_TTL_MS
}) {
  const challengeId = newId();
  await throwing(
    `INSERT INTO va_webauthn_challenge
     (challenge_id, account_id, purpose, challenge, binding_hash, issue_id, approval_challenge_id,
      rp_id, created_at, expires_at, consumed_at)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, FROM_BASE64(?), ?, ?, ?, NULL)`,
    [
      toBinaryParam(challengeId),
      accountId,
      purpose,
      challenge,
      bindingHash,
      issueId,
      approvalChallengeId == null ? null : toBinaryParam(approvalChallengeId),
      rpId,
      now,
      now + ttlMs
    ]
  );
  return { challengeId, expiresAt: now + ttlMs };
}

export async function webAuthnChallengeById({ challengeId, accountId }) {
  const rows = await throwing(
    `SELECT ${CHALLENGE_COLUMNS} FROM va_webauthn_challenge
     WHERE challenge_id = FROM_BASE64(?) AND account_id = ? LIMIT ${limitClause(1)}`,
    [toBinaryParam(challengeId), accountId]
  );
  return rows.length > 0 ? decode(rows[0]) : null;
}

export async function consumeWebAuthnChallenge({ challengeId, accountId, now }) {
  const result = await executeQuery(
    `UPDATE va_webauthn_challenge SET consumed_at = ?
     WHERE challenge_id = FROM_BASE64(?) AND account_id = ?
       AND consumed_at IS NULL AND expires_at > ?`,
    [now, toBinaryParam(challengeId), accountId, now]
  );
  return { consumed: (affectedRows(result) ?? 0) === 1 };
}
