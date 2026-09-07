import { getEncryptionKey } from '../../usecases/credentialKey.js';

export async function totpRuntime() {
  const [{ executeQuery, fromBinaryColumn, affectedRows }, { append }, { auditStore, newId }] = await Promise.all([
    import('../db.js'), import('../ledger.js'), import('../../db/store.js')
  ]);
  const query = async (sql, params) => {
    const result = await executeQuery(sql, params);
    if (!result.result) throw new Error('Credential storage unavailable');
    return result;
  };
  const update = async (sql, params) => affectedRows(await query(sql, params)) === 1;
  const audit = (event) => append(auditStore, { eventId: newId(), ...event });
  return {
    now: Date.now,
    key: (version) => { if (version !== 1) throw new Error('Unsupported credential key version'); return getEncryptionKey(); },
    audit,
    query,
    read: async (accountId) => {
      const result = await query(`SELECT account_id, TO_BASE64(secret_ciphertext) AS secret_ciphertext,
        TO_BASE64(secret_iv) AS secret_iv, TO_BASE64(secret_tag) AS secret_tag,
        key_version, algo, digits, period_seconds, state, failed_attempts, locked_at, enrolled_at,
        confirmed_at, last_used_step, version, last_verified_at, verification_count
        FROM va_credential WHERE account_id = ?`, [accountId]);
      const row = result.data[0];
      return row ? { ...row, ciphertext: fromBinaryColumn(row.secret_ciphertext), iv: fromBinaryColumn(row.secret_iv), tag: fromBinaryColumn(row.secret_tag) } : null;
    },
    fail: (accountId, row, failure, now) => update(`UPDATE va_credential SET failed_attempts = ?, state = ?,
      locked_at = ?, version = version + 1 WHERE account_id = ? AND version = ? AND state = ?`,
    [failure.attempts, failure.locked ? 'LOCKED' : row.state, failure.locked ? now : null, accountId, row.version, row.state]),
    consume: (accountId, row, step, now) => update(`UPDATE va_credential SET last_used_step = ?, failed_attempts = 0,
      version = version + 1, last_verified_at = ?, verification_count = verification_count + 1
      WHERE account_id = ? AND version = ? AND state = ? AND (last_used_step IS NULL OR last_used_step < ?)`,
    [step, now, accountId, row.version, row.state, step]),
    activate: (accountId, row, now) => update(`UPDATE va_credential SET state = 'ACTIVE', confirmed_at = ?, version = version + 1
      WHERE account_id = ? AND version = ? AND state = 'PENDING_CONFIRM'`, [now, accountId, Number(row.version) + 1]),
    alert: async (details) => {
      const [{ credentialLockedAlert }, { enqueue }] = await Promise.all([import('../alerts.js'), import('../../db/alertStore.js')]);
      await enqueue(credentialLockedAlert(details));
    }
  };
}
