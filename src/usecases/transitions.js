import { transitionInput } from './transitionsValidation.js';
import { runAdmin, query, validId, audit } from './adminRuntime.js';
const ACTIVE = 'ACTIVE';
const REVOKED = 'REVOKED';

export async function listControlledTransitions(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, fromBinaryColumn, lookupProjects, lookupIssueTypes, lookupStatuses, lookupUsers } = deps;
    const result = await executeQuery(
    `SELECT TO_BASE64(ct_id) AS ct_id, project_id, issue_type_id, from_status_id, to_status_id,
            required_role, meaning, reject_to_status_id, required_assurance, capture_baseline, block_on_drift, require_decision, transition_id, state, created_at, created_by
     FROM va_controlled_transition WHERE state = ? ORDER BY created_at DESC`,
    [ACTIVE]
  );
  if (!result.result) return { success: false, error: 'Failed to list controlled transitions' };
  const rows = result.data ?? [];
  const [projects, issueTypes, statuses, users] = await Promise.all([
    lookupProjects(),
    lookupIssueTypes(),
    lookupStatuses(),
    lookupUsers(rows.map((r) => r.created_by))
  ]);
  const statusName = (id) => (id == null ? null : (id === '*' ? 'Any status' : statuses.get(String(id))?.name ?? null));
  return {
    success: true,
    transitions: rows.map((row) => {
      const project = projects.get(String(row.project_id));
      return {
        ctId: fromBinaryColumn(row.ct_id).toString('hex'),
        projectId: String(row.project_id), issueTypeId: row.issue_type_id,
        fromStatusId: row.from_status_id, toStatusId: row.to_status_id,
        rejectToStatusId: row.reject_to_status_id, transitionId: row.transition_id,
        requiredAssurance: row.required_assurance,
        captureBaseline: Boolean(Number(row.capture_baseline)), blockOnDrift: Boolean(Number(row.block_on_drift)),
        requireDecision: Boolean(Number(row.require_decision)),
        projectKey: project?.key ?? null,
        projectName: project?.name ?? null,
        issueTypeName: row.issue_type_id === '*' ? 'All work item types' : issueTypes.get(String(row.issue_type_id))?.name ?? null,
        fromStatusName: statusName(row.from_status_id),
        toStatusName: statusName(row.to_status_id),
        rejectConfigured: row.reject_to_status_id != null,
        rejectToStatusName: statusName(row.reject_to_status_id),
        requiredRole: row.required_role,
        meaning: row.meaning,
        createdAt: row.created_at,
        createdByName: users.get(row.created_by)?.displayName ?? null
      };
    })
  };
  }, overrides, 'transitions');
}

export async function createControlledTransition(req, overrides) {
  return runAdmin(req, async deps => {
    const input = transitionInput(req.payload);
    const id = deps.newId();
    await audit(deps, req.context.accountId, deps.EVENT.CONTROLLED_TRANSITION_CHANGED, { action: 'CREATE_REQUESTED', ctId: id.toString('hex'), ...input });
    await query(deps, `INSERT INTO va_controlled_transition
      (ct_id, project_id, issue_type_id, from_status_id, to_status_id, required_role, meaning,
       reject_to_status_id, transition_id, required_assurance, capture_baseline, block_on_drift, require_decision, state, created_at, created_by)
      VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [deps.toBinaryParam(id), ...edgeParams(input), Date.now(), req.context.accountId]);
    return { success: true, ctId: id.toString('hex') };
  }, overrides);
}

function edgeParams(input) {
  return [input.projectId, input.issueTypeId, input.fromStatusId, input.toStatusId, input.requiredRole,
    input.meaning, input.rejectToStatusId, input.transitionId, input.requiredAssurance,
    input.captureBaseline ? 1 : 0, input.blockOnDrift ? 1 : 0, input.requireDecision ? 1 : 0];
}

export async function updateControlledTransition(req, overrides) {
  return runAdmin(req, async deps => {
    if (!validId(req.payload?.ctId)) throw new Error('A valid ctId is required.');
    const input = transitionInput(req.payload);
    const id = deps.toBinaryParam(Buffer.from(req.payload.ctId, 'hex'));
    const existing = (await query(deps, "SELECT state FROM va_controlled_transition WHERE ct_id = FROM_BASE64(?) AND state = 'ACTIVE'", [id])).data;
    if (!existing?.length) throw new Error('Active controlled transition not found.');
    await audit(deps, req.context.accountId, deps.EVENT.CONTROLLED_TRANSITION_CHANGED, { action: 'UPDATE_REQUESTED', ctId: req.payload.ctId, ...input });
    await query(deps, `UPDATE va_controlled_transition SET project_id = ?, issue_type_id = ?, from_status_id = ?, to_status_id = ?,
      required_role = ?, meaning = ?, reject_to_status_id = ?, transition_id = ?, required_assurance = ?, capture_baseline = ?,
      block_on_drift = ?, require_decision = ? WHERE ct_id = FROM_BASE64(?) AND state = 'ACTIVE'`, [...edgeParams(input), id]);
    return { success: true, ctId: req.payload.ctId };
  }, overrides);
}

export async function revokeControlledTransition(req, overrides) {
  return runAdmin(req, async deps => {
    const ctId = req.payload?.ctId;
    if (!validId(ctId)) throw new Error('A valid ctId is required.');
    await audit(deps, req.context.accountId, deps.EVENT.CONTROLLED_TRANSITION_CHANGED, { action: 'REVOKE_REQUESTED', ctId });
    await query(deps, "UPDATE va_controlled_transition SET state = 'REVOKED' WHERE ct_id = FROM_BASE64(?)",
      [deps.toBinaryParam(Buffer.from(ctId, 'hex'))]);
    return { success: true };
  }, overrides);
}
