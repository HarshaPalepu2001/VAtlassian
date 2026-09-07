import { executeQuery, toBinaryParam, fromBinaryColumn } from '../lib/db.js';
import { newId, throwing } from './store.js';

export async function writeChallenge(challenge) {
  const challengeId = challenge.challenge_id ?? newId();
  await throwing(
    `INSERT INTO va_challenge (challenge_id, tenant_id, issue_id, signer_account_id, decision, meaning, baseline_id, candidate_hash, transition_id, operation_plan_hash, nonce, state, created_at, expires_at)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?)`,
    [
      toBinaryParam(challengeId), challenge.tenant_id, challenge.issue_id, challenge.signer_account_id,
      challenge.decision, challenge.meaning, toBinaryParam(challenge.baseline_id),
      challenge.candidate_hash, challenge.transition_id ?? null, challenge.operation_plan_hash ?? null,
      challenge.nonce, challenge.state ?? 'PENDING', challenge.created_at, challenge.expires_at
    ]
  );
  return challengeId;
}

export async function getChallenge(challengeId) {
  const rows = await throwing(
    `SELECT TO_BASE64(challenge_id) AS challenge_id, tenant_id, issue_id, signer_account_id,
            decision, meaning, TO_BASE64(baseline_id) AS baseline_id, candidate_hash, transition_id,
            operation_plan_hash, nonce, state, created_at, expires_at
     FROM va_challenge WHERE challenge_id = FROM_BASE64(?)`,
    [toBinaryParam(challengeId)]
  );
  if (!rows || rows.length === 0) return null;
  return {
    ...rows[0],
    challenge_id: fromBinaryColumn(rows[0].challenge_id),
    baseline_id: fromBinaryColumn(rows[0].baseline_id)
  };
}

export async function markChallengeConsumed(challengeId) {
  await executeQuery(
    `UPDATE va_challenge SET state = 'CONSUMED' WHERE challenge_id = FROM_BASE64(?) AND state = 'PENDING'`,
    [toBinaryParam(challengeId)]
  );
}
