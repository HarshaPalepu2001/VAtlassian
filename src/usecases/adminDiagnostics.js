import { runAdmin, query } from './adminRuntime.js';

export async function debugDump(req, overrides) {
  return runAdmin(req, async deps => {
    const statements = {
      controlled_transitions: "SELECT project_id, issue_type_id, from_status_id, to_status_id, required_role, meaning, required_assurance, capture_baseline, block_on_drift, state FROM va_controlled_transition LIMIT 200",
      eligibility: 'SELECT account_id, issue_type_id, role, state, granted_by, project_id FROM va_eligibility LIMIT 200',
      admins: 'SELECT account_id, state, seeded_by FROM va_admin LIMIT 200',
      credentials: 'SELECT account_id, state, algo, digits, period_seconds FROM va_credential LIMIT 200'
    };
    const rows = await Promise.all(Object.entries(statements).map(async ([key, sql]) => [key, (await query(deps, sql)).data ?? []]));
    return { ...Object.fromEntries(rows), limitPerTable: 200 };
  }, overrides);
}

export async function listContentChanges(req, overrides) {
  return runAdmin(req, async deps => {
    const projectId = req.payload?.projectId;
    if (projectId != null && !/^[1-9]\d*$/.test(String(projectId))) throw new Error('Invalid project.');
    const result = await query(deps, `SELECT TO_BASE64(drift_id) AS drift_id, issue_id, field_id,
      field_name, materiality, occurred_at, actor_account_id, actor_name, from_repr, to_repr FROM va_drift
      WHERE approval_id IS NULL ${projectId == null ? '' : 'AND project_id = ?'} ORDER BY occurred_at DESC LIMIT 201`, projectId == null ? [] : [projectId]);
    const rows = result.data ?? [];
    return { changes: rows.slice(0, 200).map(r => ({ ...r, driftId: r.drift_id, issueId: String(r.issue_id), fieldId: r.field_id, fieldName: r.field_name, occurredAt: r.occurred_at, actorName: r.actor_name })), hasMore: rows.length > 200 };
  }, overrides);
}

export async function storage(req, overrides) {
  return runAdmin(req, async deps => ({ storage: await deps.storageReport() }), overrides, 'fields');
}

export async function listCredentials(req, overrides) {
  return runAdmin(req, async deps => {
    const rows = (await query(deps, `SELECT account_id, state, enrolled_at, confirmed_at, locked_at,
      last_verified_at, verification_count FROM va_credential ORDER BY enrolled_at DESC LIMIT 201`)).data ?? [];
    const users = await deps.lookupUsers(rows.slice(0, 200).map(r => r.account_id));
    return { credentials: rows.slice(0, 200).map(r => ({ accountId: r.account_id,
      displayName: users.get(r.account_id)?.displayName ?? r.account_id, state: r.state,
      enrolledAt: r.enrolled_at, confirmedAt: r.confirmed_at, lockedAt: r.locked_at,
      lastVerifiedAt: r.last_verified_at, verificationCount: r.verification_count })), hasMore: rows.length > 200 };
  }, overrides);
}

export async function reconcileDirectory(req, overrides) {
  return runAdmin(req, async deps => {
    const run = deps.reconcileDirectory ?? (await import('../jobs/directoryReconcile.js')).run;
    return run();
  }, overrides);
}
