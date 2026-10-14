import { totpRuntime } from '../lib/approval/totpRuntime.js';
import { affectedRows, toBinaryParam } from '../lib/db.js';

export async function enrollmentRuntime() {
  const deps = await totpRuntime();
  return {...deps,
    administrators: async () => {
      const ids = ((await deps.query(`SELECT account_id FROM va_admin WHERE state = 'ACTIVE' ORDER BY created_at`)).data ?? [])
        .map(r => r.account_id);
      const users = await (await import('../lib/directory.js')).lookupUsers(ids);
      return ids.map(accountId => ({accountId, displayName:users.get(accountId)?.displayName ?? null}));
    },
    grant: async accountId => (await deps.query(`SELECT TO_BASE64(grant_id) AS grant_id, expires_at, redeemed_at
      FROM va_credential_reset_grant WHERE account_id = ? AND redeemed_at IS NULL ORDER BY issued_at DESC LIMIT 1`,[accountId])).data[0] ?? null,
    redeem: async (grant,now) => affectedRows(await deps.query(`UPDATE va_credential_reset_grant SET redeemed_at = ?
      WHERE grant_id = FROM_BASE64(?) AND redeemed_at IS NULL AND expires_at > ?`,[now,grant.grant_id,now])) === 1,
    write: async (accountId,previous,stored,now) => {
      const params = [toBinaryParam(stored.ciphertext),toBinaryParam(stored.iv),toBinaryParam(stored.tag),
        stored.keyVersion,stored.algo,stored.digits,stored.period_seconds,now];
      if (!previous) {
        const result = await deps.query(`INSERT INTO va_credential
          (secret_ciphertext,secret_iv,secret_tag,key_version,algo,digits,period_seconds,enrolled_at,account_id,state)
          VALUES (FROM_BASE64(?),FROM_BASE64(?),FROM_BASE64(?),?,?,?,?,?,?,'PENDING_CONFIRM')`,[...params,accountId]);
        return affectedRows(result) === 1;
      }
      // Never DELETE+INSERT: a confirmation racing setup cannot be overwritten.
      return affectedRows(await deps.query(`UPDATE va_credential SET secret_ciphertext=FROM_BASE64(?),
        secret_iv=FROM_BASE64(?),secret_tag=FROM_BASE64(?),key_version=?,algo=?,digits=?,period_seconds=?,enrolled_at=?,
        state='PENDING_CONFIRM',confirmed_at=NULL,last_used_step=NULL,failed_attempts=0,locked_at=NULL,
        last_verified_at=NULL,verification_count=0,version=version+1
        WHERE account_id=? AND version=? AND state=?`,[...params,accountId,previous.version,previous.state])) === 1;
    }
  };
}
