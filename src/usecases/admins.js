import { runAdmin, query, audit } from './adminRuntime.js';

export async function check(req, overrides) {
  return runAdmin(req, async deps => {
    const rows = (await query(deps, 'SELECT account_id, state FROM va_admin')).data;
    if (!Array.isArray(rows)) throw new Error('Administrator roster could not be read.');
    return { isAdmin: rows.some(r => r.account_id === req.context.accountId && r.state === 'ACTIVE'), needsBootstrap: rows.length === 0 };
  }, overrides, '', { bootstrap: true });
}

export async function bootstrap(req, overrides) {
  return runAdmin(req, async deps => {
    if (!await deps.isJiraAdmin()) throw new Error('Only a Jira administrator can bootstrap VAtlassian.');
    const rows = (await query(deps, 'SELECT account_id FROM va_admin')).data;
    if (!Array.isArray(rows) || rows.length) throw new Error('System is already bootstrapped.');
    const accountId = req.context.accountId;
    // The config PK chooses one bootstrap owner under concurrent requests. The
    // same owner can retry after an interrupted audit or insert; others cannot.
    await query(deps, `INSERT INTO va_config (cfg_key, cfg_value, updated_at, updated_by)
      VALUES ('admin.bootstrapOwner', ?, ?, ?) ON DUPLICATE KEY UPDATE cfg_key = cfg_key`,
    [accountId, Date.now(), accountId]);
    const owner = (await query(deps, "SELECT cfg_value FROM va_config WHERE cfg_key = 'admin.bootstrapOwner'")).data?.[0];
    if (owner?.cfg_value !== accountId) throw new Error('Bootstrap is already claimed by another Jira administrator.');
    await audit(deps, accountId, deps.EVENT.ADMIN_SEEDED, { via: 'BOOTSTRAP', targetAccountId: accountId });
    await query(deps, 'INSERT INTO va_admin (account_id, state, seeded_by, created_at) VALUES (?, ?, ?, ?)',
      [accountId, 'ACTIVE', 'BOOTSTRAP', Date.now()]);
    return { success: true };
  }, overrides, '', { bootstrap: true });
}

export async function runMigrations(req, overrides) {
  return runAdmin(req, async deps => {
    if (!await deps.isJiraAdmin()) throw new Error('Only a Jira administrator can run migrations.');
    const run = deps.runMigrations ?? (await import('../jobs/migrate.js')).run;
    const result = await run();
    if (result?.ok === false || result?.success === false) throw new Error(`Migration stopped${result.failedAt ? ` at ${result.failedAt}` : ''}: ${result.reason ?? 'database operation failed'}. Retry after resolving the error.`);
    return { ...result, success: true, message: `${result?.applied ?? 0} pending migrations applied.` };
  }, overrides, '', { bootstrap: true });
}

export async function listAdmins(req, overrides) {
  return runAdmin(req, async deps => {
    const rows = (await query(deps, 'SELECT account_id, state, seeded_by, created_at FROM va_admin ORDER BY created_at')).data ?? [];
    const users = await deps.lookupUsers(rows.flatMap(r => [r.account_id, r.seeded_by]));
    return { admins: rows.map(r => ({ accountId: r.account_id, state: r.state, createdAt: r.created_at,
      displayName: users.get(r.account_id)?.displayName ?? null,
      canRevoke: r.state === 'ACTIVE' && r.account_id !== req.context.accountId && r.seeded_by !== 'BOOTSTRAP',
      revokeReason: r.account_id === req.context.accountId ? 'Your account' : r.seeded_by === 'BOOTSTRAP' ? 'Recovery custodian' : null,
      seededByName: users.get(r.seeded_by)?.displayName ?? r.seeded_by })) };
  }, overrides);
}

export async function grantAdmin(req, overrides) {
  return runAdmin(req, async deps => {
    const target = req.payload?.targetAccountId;
    if (typeof target !== 'string' || !target.trim() || target.length > 128) throw new Error('Choose an administrator.');
    const users = await deps.lookupUsers([target]);
    if (!users.has(target) || users.get(target).active === false) throw new Error('Choose an active Jira user.');
    await audit(deps, req.context.accountId, deps.EVENT.ADMIN_SEEDED, { via: 'ADMIN', targetAccountId: target });
    await query(deps, `INSERT INTO va_admin (account_id, state, seeded_by, created_at) VALUES (?, 'ACTIVE', ?, ?)
      ON DUPLICATE KEY UPDATE state = 'ACTIVE', seeded_by = IF(seeded_by = 'BOOTSTRAP', seeded_by, VALUES(seeded_by))`, [target, req.context.accountId, Date.now()]);
    return { success: true };
  }, overrides);
}

export async function revokeAdmin(req, overrides) {
  return runAdmin(req, async deps => {
    const target = req.payload?.targetAccountId;
    if (!target || target === req.context.accountId) throw new Error('Administrators cannot revoke themselves.');
    // A caller stays active, so concurrent self-service cannot remove the last
    // administrator. Also forbid revoking the bootstrap custodian, keeping one
    // stable recovery principal without relying on a non-atomic count check.
    const row = (await query(deps, 'SELECT account_id, seeded_by FROM va_admin WHERE account_id = ? AND state = ?', [target, 'ACTIVE'])).data?.[0];
    if (!row) throw new Error('Active administrator not found.');
    if (row.seeded_by === 'BOOTSTRAP') throw new Error('The bootstrap administrator is the recovery custodian and cannot be revoked.');
    await audit(deps, req.context.accountId, deps.EVENT.CONFIG_CHANGED, { scope: 'admins', action: 'REVOKED', targetAccountId: target });
    await query(deps, "UPDATE va_admin SET state = 'REVOKED' WHERE account_id = ? AND seeded_by <> 'BOOTSTRAP'", [target]);
    return { success: true };
  }, overrides);
}
