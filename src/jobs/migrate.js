import { executeDDL, executeQuery } from '../lib/db.js';
import { MIGRATIONS } from '../db/migrations.js';

/** Fresh-app DDL is idempotent. Persist completion only after a successful DDL
 * statement, and stop on either failure so later entries cannot outrun it.
 * Tracking uses the consolidated config table, bootstrapped with v001.
 */
export async function run({ ddl = executeDDL, query = executeQuery, migrations = MIGRATIONS, now = Date.now } = {}) {
  const bootstrap = migrations.find(m => m.id === 'v001_config');
  if (!bootstrap) throw new Error('Missing config bootstrap migration');
  const ready = await ddl(bootstrap.sql);
  if (!ready.result) return {ok:false, applied:0, failedAt:bootstrap.id};
  const ledger = await query("SELECT cfg_key FROM va_config WHERE cfg_key LIKE 'schema.%'");
  if (!ledger.result) return {ok:false, applied:0, reason:'MIGRATION_LEDGER_UNREADABLE'};
  const done = new Set((ledger.data ?? []).map(r => r.cfg_key.slice('schema.'.length)));
  let applied = 0;
  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    if (migration === bootstrap) {
      if (!ready.result) return {ok:false, applied, failedAt:migration.id};
    } else {
      const statements = migration.sql
        .split(';')
        .map(s => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        const isDml = /^\s*(DELETE|INSERT|UPDATE)\b/i.test(stmt);
        const res = isDml ? await query(stmt) : await ddl(stmt);
        if (!res?.result) return {ok:false, applied, failedAt:migration.id};
      }
    }
    const recorded = await query(
      `INSERT INTO va_config (cfg_key,cfg_value,updated_at,updated_by) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)`,
      [`schema.${migration.id}`, 'applied', now(), 'system:migrate']
    );
    if (!recorded.result) return {ok:false, applied, failedAt:migration.id, reason:'MIGRATION_RECORD_FAILED'};
    applied++;
  }
  return {ok:true, applied};
}
export const handler = run;
