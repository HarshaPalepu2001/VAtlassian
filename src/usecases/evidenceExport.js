import { runAdmin, query, audit } from './adminRuntime.js';

function exportScope(payload = {}) {
  const { projectId = null, fromMs = null, toMs = null } = payload;
  if (projectId !== null && !/^[1-9]\d*$/.test(String(projectId))) throw new Error('Invalid project scope.');
  if ([fromMs, toMs].some(v => v !== null && (!Number.isSafeInteger(Number(v)) || Number(v) < 0))) throw new Error('Invalid export time range.');
  if (fromMs !== null && toMs !== null && Number(fromMs) > Number(toMs)) throw new Error('Export start must precede its end.');
  return { projectId, fromMs: fromMs === null ? null : Number(fromMs), toMs: toMs === null ? null : Number(toMs) };
}

export async function exportRecords(req, overrides) {
  return runAdmin(req, async deps => {
    const scope = exportScope(req.payload);
    const maxRows = 500;
    const params = [];
    const condition = (column, projectColumn = 'project_id') => {
      const where = [];
      if (scope.projectId !== null) { where.push(`${projectColumn} = ?`); params.push(scope.projectId); }
      if (scope.fromMs !== null) { where.push(`${column} >= ?`); params.push(scope.fromMs); }
      if (scope.toMs !== null) { where.push(`${column} <= ?`); params.push(scope.toMs); }
      return where.length ? where.join(' AND ') : '1 = 1';
    };
    const approvalWhere = condition('created_at');
    const approvals = (await query(deps, `SELECT TO_BASE64(approval_id) AS approval_id,
      issue_id, issue_key, project_id, transition_id, from_status_id, to_status_id, account_id, printed_name,
      signer_role, meaning, content_hash, state, created_at, signed_at, consumed_at, decision,
      assurance_level, provider_id, provider_ref, provider_evidence, evidence_hash, baseline_version,
      covers_from_hash, covers_to_hash, note FROM va_approval WHERE ${approvalWhere}
      ORDER BY created_at, approval_id LIMIT ${maxRows + 1}`, [...params])).data ?? [];
    params.length = 0;
    const baselineWhere = condition('captured_at');
    const baselines = (await query(deps, `SELECT TO_BASE64(baseline_id) AS baseline_id, TO_BASE64(approval_id) AS approval_id,
      issue_id, project_id, issue_type_id, version, state, content_hash, field_digests, transition_id,
      from_status_id, to_status_id, approved_by, approved_name, transition_at, captured_at,
      fidelity, field_count, value_bytes, assurance_level FROM va_baseline WHERE ${baselineWhere}
      ORDER BY captured_at, baseline_id LIMIT ${maxRows + 1}`, [...params])).data ?? [];
    params.length = 0;
    // Project issue history includes rows surviving only as drift/item-state.
    // Configuration events are included site-wide so control changes are never omitted.
    let auditWhere = '1 = 1';
    if (scope.projectId !== null) {
      auditWhere = `(a.issue_id IS NULL OR a.issue_id IN (
        SELECT issue_id FROM va_approval WHERE project_id = ? UNION SELECT issue_id FROM va_baseline WHERE project_id = ?
        UNION SELECT issue_id FROM va_item_state WHERE project_id = ?))`;
      params.push(scope.projectId, scope.projectId, scope.projectId);
    }
    if (scope.fromMs !== null) { auditWhere += ' AND a.occurred_at >= ?'; params.push(scope.fromMs); }
    if (scope.toMs !== null) { auditWhere += ' AND a.occurred_at <= ?'; params.push(scope.toMs); }
    const entries = (await query(deps, `SELECT a.seq, TO_BASE64(a.event_id) AS event_id,
      TO_BASE64(a.approval_id) AS approval_id, a.occurred_at, a.actor_account_id, a.event_type,
      a.issue_id, a.payload, a.prev_hash, a.entry_hash FROM va_audit a WHERE ${auditWhere}
      ORDER BY a.seq LIMIT ${maxRows + 1}`, params)).data ?? [];
    let chainVerification;
    try { chainVerification = await deps.verifyChain(deps.auditStore); }
    catch { chainVerification = { ok: false, reason: 'VERIFICATION_UNAVAILABLE' }; }
    const truncated = [approvals, baselines, entries].some(rows => rows.length > maxRows);
    const selected = { approvals: approvals.slice(0, maxRows), baselines: baselines.slice(0, maxRows), auditEntries: entries.slice(0, maxRows) };
    const built = deps.buildExport({ ...selected, scope, generatedAt: Date.now(), generatedBy: req.context.accountId, chainVerification, truncated });
    const humanReadable = deps.renderHuman(built);
    const electronic = deps.renderElectronic(built);
    if (Buffer.byteLength(humanReadable) + Buffer.byteLength(electronic) > 3 * 1024 * 1024) throw new Error('Export exceeds the response size limit. Narrow the date range or project scope.');
    await audit(deps, req.context.accountId, deps.EVENT.RECORDS_EXPORTED, {
      scope, approvalCount: selected.approvals.length, baselineCount: selected.baselines.length,
      auditEntryCount: selected.auditEntries.length, truncated, exportSha256: built.sha256,
      retainedValueCoverage: false
    });
    return { success: true, sha256: built.sha256, truncated, chainVerified: chainVerification.ok === true,
      humanReadable, electronic, retainedValuesIncluded: false };
  }, overrides, 'evidenceExport');
}
