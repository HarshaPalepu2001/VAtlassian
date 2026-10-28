import { transitionInput, verifyControlledTransition } from './transitionsValidation.js';
import { runAdmin, query, validId, audit } from './adminRuntime.js';
import { createHash } from 'node:crypto';
import { affectedRows } from '../lib/db.js';
const ACTIVE = 'ACTIVE';
const REVOKED = 'REVOKED';
const EDIT_COLUMNS = ['project_id', 'issue_type_id', 'from_status_id', 'to_status_id', 'required_role',
  'meaning', 'reject_to_status_id', 'transition_id', 'required_assurance', 'capture_baseline', 'require_decision'];
function editRevision(row) {
  return createHash('sha256').update(JSON.stringify(EDIT_COLUMNS.map(k => row[k] == null ? null : String(row[k])))).digest('hex');
}

export async function listControlledTransitions(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, fromBinaryColumn, lookupProjects, lookupIssueTypes, lookupStatuses, lookupUsers } = deps;
    const result = await executeQuery(
    `SELECT TO_BASE64(ct_id) AS ct_id, project_id, issue_type_id, from_status_id, to_status_id,
            required_role, meaning, reject_to_status_id, required_assurance, capture_baseline, require_decision, transition_id, state, created_at, created_by
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
        revision: editRevision(row),
        projectId: String(row.project_id), issueTypeId: row.issue_type_id,
        fromStatusId: row.from_status_id, toStatusId: row.to_status_id,
        rejectToStatusId: row.reject_to_status_id, transitionId: row.transition_id,
        requiredAssurance: row.required_assurance,
        captureBaseline: Boolean(Number(row.capture_baseline)),
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
    // The picker's earlier read is a display convenience, never the authority.
    // Re-read the live transition and re-derive every fact this row will
    // claim before it can be persisted.
    await verifyControlledTransition(input, deps);
    if (input.captureBaseline) {
      const rows = await deps.declaredFieldRows({ projectId: input.projectId, issueTypeId: input.issueTypeId });
      if (rows.some(r => r.state !== 'EXCLUDED' && (r.store_values === 0 || r.store_values === false || r.store_values === '0'))) {
        throw new Error('This project has fields with retention disabled. Enable retention for all tracked fields before creating a capture-baseline policy.');
      }
    }
    const id = deps.newId();
    await audit(deps, req.context.accountId, deps.EVENT.CONTROLLED_TRANSITION_CHANGED, { action: 'CREATE_REQUESTED', ctId: id.toString('hex'), ...input });
    await query(deps, `INSERT INTO va_controlled_transition
      (ct_id, project_id, issue_type_id, from_status_id, to_status_id, required_role, meaning,
       reject_to_status_id, transition_id, required_assurance, capture_baseline, require_decision, state, created_at, created_by)
      VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      [deps.toBinaryParam(id), ...edgeParams(input), Date.now(), req.context.accountId]);
    let note;
    if (input.captureBaseline) {
      const provisionVault = deps.provisionVault ?? (await import('../lib/vaultProvision.js')).provisionVault;
      const provisioned = await provisionVault(Number(input.projectId)).catch(error => {
        console.error('createControlledTransition: vault provisioning threw unexpectedly', error);
        return { errors: [{ step: 'provisionVault', error: String(error?.message ?? error) }] };
      });
      if (provisioned.errors?.length) {
        note = 'Rule saved. Attachment vaulting could not be fully provisioned yet and will retry automatically every hour.';
      }
    }
    return { success: true, ctId: id.toString('hex'), ...(note ? { note } : {}) };
  }, overrides);
}

function edgeParams(input) {
  return [input.projectId, input.issueTypeId, input.fromStatusId, input.toStatusId, input.requiredRole,
    input.meaning, input.rejectToStatusId, input.transitionId, input.requiredAssurance,
    input.captureBaseline ? 1 : 0, input.requireDecision ? 1 : 0];
}

export async function updateControlledTransition(req, overrides) {
  return runAdmin(req, async deps => {
    if (!validId(req.payload?.ctId)) throw new Error('A valid ctId is required.');
    const input = transitionInput(req.payload);
    const id = deps.toBinaryParam(Buffer.from(req.payload.ctId, 'hex'));
    // Re-read the live transition and re-derive every fact this row will
    // claim, excluding this row itself from the no-conflicting-scope check —
    // an edit is allowed to keep governing the edge it already governs.
    await verifyControlledTransition(input, deps, { excludeCtId: id });
    if (input.captureBaseline) {
      const rows = await deps.declaredFieldRows({ projectId: input.projectId, issueTypeId: input.issueTypeId });
      if (rows.some(r => r.state !== 'EXCLUDED' && (r.store_values === 0 || r.store_values === false || r.store_values === '0'))) {
        throw new Error('This project has fields with retention disabled. Enable retention for all tracked fields before updating a capture-baseline policy.');
      }
    }
    const existing = (await query(deps, `SELECT state, ${EDIT_COLUMNS.join(', ')} FROM va_controlled_transition WHERE ct_id = FROM_BASE64(?) AND state = 'ACTIVE'`, [id])).data;
    if (!existing?.length) throw new Error('Active controlled transition not found.');
    const previous = existing[0];
    if (req.payload.expectedRevision !== undefined && req.payload.expectedRevision !== editRevision(previous)) {
      throw new Error('This rule changed since it was loaded. Reload and review it before saving.');
    }
    const values = edgeParams(input);
    if (EDIT_COLUMNS.every((k, i) => (previous[k] == null ? null : String(previous[k])) === (values[i] == null ? null : String(values[i])))) {
      return { success: true, ctId: req.payload.ctId, note: 'The rule already has these settings.' };
    }
    await audit(deps, req.context.accountId, deps.EVENT.CONTROLLED_TRANSITION_CHANGED, { action: 'UPDATE_REQUESTED', ctId: req.payload.ctId, ...input });
    const compare = req.payload.expectedRevision === undefined ? '' : EDIT_COLUMNS.map(k => ` AND ${k} <=> ?`).join('');
    const updated = await query(deps, `UPDATE va_controlled_transition SET project_id = ?, issue_type_id = ?, from_status_id = ?, to_status_id = ?,
      required_role = ?, meaning = ?, reject_to_status_id = ?, transition_id = ?, required_assurance = ?, capture_baseline = ?,
      require_decision = ? WHERE ct_id = FROM_BASE64(?) AND state = 'ACTIVE'${compare}`,
      [...values, id, ...(compare ? EDIT_COLUMNS.map(k => previous[k] ?? null) : [])]);
    if (affectedRows(updated) === 0) throw new Error('This rule changed or was revoked during the save. Reload before trying again.');
    let note;
    if (input.captureBaseline) {
      const provisionVault = deps.provisionVault ?? (await import('../lib/vaultProvision.js')).provisionVault;
      const provisioned = await provisionVault(Number(input.projectId)).catch(error => {
        console.error('updateControlledTransition: vault provisioning threw unexpectedly', error);
        return { errors: [{ step: 'provisionVault', error: String(error?.message ?? error) }] };
      });
      if (provisioned.errors?.length) {
        note = 'Rule saved. Attachment vaulting could not be fully provisioned yet and will retry automatically every hour.';
      }
    }
    return { success: true, ctId: req.payload.ctId, ...(note ? { note } : {}) };
  }, overrides);
}

export async function revokeControlledTransition(req, overrides) {
  return runAdmin(req, async deps => {
    const ctId = req.payload?.ctId;
    if (!validId(ctId)) throw new Error('A valid ctId is required.');
    const id = deps.toBinaryParam(Buffer.from(ctId, 'hex'));
    let previous;
    if (req.payload.expectedRevision !== undefined) {
      previous = (await query(deps, `SELECT ${EDIT_COLUMNS.join(', ')} FROM va_controlled_transition WHERE ct_id = FROM_BASE64(?) AND state = 'ACTIVE'`, [id])).data?.[0];
      if (!previous || editRevision(previous) !== req.payload.expectedRevision) {
        throw new Error('This rule changed or was removed since it was loaded. Reload before removing it.');
      }
    }
    await audit(deps, req.context.accountId, deps.EVENT.CONTROLLED_TRANSITION_CHANGED, { action: 'REVOKE_REQUESTED', ctId });
    const compare = previous ? EDIT_COLUMNS.map(k => ` AND ${k} <=> ?`).join('') : '';
    const result = await query(deps, `UPDATE va_controlled_transition SET state = 'REVOKED' WHERE ct_id = FROM_BASE64(?) AND state = 'ACTIVE'${compare}`,
      [id, ...(previous ? EDIT_COLUMNS.map(k => previous[k] ?? null) : [])]);
    if (affectedRows(result) !== 1) throw new Error('This rule changed or was already removed. Reload the rules.');
    return { success: true };
  }, overrides);
}
