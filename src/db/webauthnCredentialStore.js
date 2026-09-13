import { affectedRows, executeQuery, fromBinaryColumn, limitClause, toBinaryParam } from '../lib/db.js';
import { newId, throwing } from './store.js';

export const WEBAUTHN_CREDENTIAL_STATE = Object.freeze({ ACTIVE: 'ACTIVE', REVOKED: 'REVOKED' });

const CREDENTIAL_COLUMNS = `
  TO_BASE64(credential_row_id) AS credential_row_id, account_id, credential_id, public_key, sign_count,
  rp_id, origin, aaguid, transports, backup_eligible, backup_state,
  device_label, state, enrolled_at, last_used_at
`;

function decode(row) {
  if (!row) return null;
  return {
    ...row,
    credential_row_id: fromBinaryColumn(row.credential_row_id),
    sign_count: Number(row.sign_count ?? 0),
    backup_eligible: Boolean(Number(row.backup_eligible)),
    backup_state: Boolean(Number(row.backup_state)),
    last_used_at: row.last_used_at == null ? null : Number(row.last_used_at),
    enrolled_at: Number(row.enrolled_at)
  };
}

export async function credentialsFor(accountId, { limit = 20 } = {}) {
  const rows = await throwing(
    `SELECT ${CREDENTIAL_COLUMNS} FROM va_webauthn_credential
     WHERE account_id = ? AND state = ?
     ORDER BY enrolled_at DESC LIMIT ${limitClause(limit)}`,
    [accountId, WEBAUTHN_CREDENTIAL_STATE.ACTIVE]
  );
  return rows.map(decode);
}

export async function credentialFor({ accountId, credentialId }) {
  const rows = await throwing(
    `SELECT ${CREDENTIAL_COLUMNS} FROM va_webauthn_credential
     WHERE account_id = ? AND credential_id = ? AND state = ? LIMIT ${limitClause(1)}`,
    [accountId, credentialId, WEBAUTHN_CREDENTIAL_STATE.ACTIVE]
  );
  return rows.length > 0 ? decode(rows[0]) : null;
}

export async function enrolCredential({
  accountId,
  credentialId,
  publicKey,
  signCount = 0,
  rpId,
  origin,
  aaguid = null,
  transports = null,
  backupEligible = false,
  backupState = false,
  deviceLabel = null,
  now
}) {
  const credentialRowId = newId();
  await throwing(
    `INSERT INTO va_webauthn_credential
     (credential_row_id, account_id, credential_id, public_key, sign_count, rp_id, origin,
      aaguid, transports, backup_eligible, backup_state, device_label, state, enrolled_at, last_used_at)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      toBinaryParam(credentialRowId),
      accountId,
      credentialId,
      publicKey,
      signCount,
      rpId,
      String(origin).slice(0, 512),
      aaguid,
      transports == null ? null : String(transports).slice(0, 128),
      backupEligible ? 1 : 0,
      backupState ? 1 : 0,
      deviceLabel == null ? null : String(deviceLabel).slice(0, 128),
      WEBAUTHN_CREDENTIAL_STATE.ACTIVE,
      now
    ]
  );
  return { credentialRowId };
}

export async function touchCredential({ credentialRowId, signCount, now }) {
  const result = await executeQuery(
    `UPDATE va_webauthn_credential SET sign_count = ?, last_used_at = ?
     WHERE credential_row_id = FROM_BASE64(?) AND sign_count < ?`,
    [signCount, now, toBinaryParam(credentialRowId), signCount]
  );
  if ((affectedRows(result) ?? 0) === 0) {
    await executeQuery(
      `UPDATE va_webauthn_credential SET last_used_at = ? WHERE credential_row_id = FROM_BASE64(?)`,
      [now, toBinaryParam(credentialRowId)]
    );
  }
}
