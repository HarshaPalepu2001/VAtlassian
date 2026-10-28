import { validScope } from './adminRuntime.js';

export function fieldScope(payload = {}) {
  const issueTypeId = String(payload.issueTypeId ?? '*');
  if (!validScope(payload.projectId, issueTypeId)) throw new Error('Choose a valid project and issue type.');
  return { projectId: Number(payload.projectId), issueTypeId };
}

export async function fieldCatalogue(deps, scope) {
  const [rows, fields] = await Promise.all([
    deps.declaredFieldRows(scope), deps.readScopeFields(scope.projectId, scope.issueTypeId)
  ]);
  if (!Array.isArray(fields) || !fields.length) throw new Error('Jira field catalogue is unavailable. Nothing was saved.');
  const candidates = deps.withAlwaysControlled(deps.candidateFields(fields, rows));
  return { rows, byId: new Map(candidates.map(f => [f.field_id, f])) };
}

export function fieldRow(deps, scope, payload, catalogue, accountId) {
  const id = String(payload.fieldId ?? '');
  const field = catalogue.byId.get(id);
  if (!field) throw new Error(`Field ${id || '(missing)'} is not available for baselining.`);
  const previous = catalogue.rows.find(r => r.field_id === id && String(r.issue_type_id) === scope.issueTypeId);
  const state = payload.state ?? 'ACTIVE';
  if (!['ACTIVE', 'EXCLUDED'].includes(state)) throw new Error('Field state must be ACTIVE or EXCLUDED.');
  if (state !== 'ACTIVE' && deps.ALWAYS_CONTROLLED_FIELDS.some(f => f.field_id === id)) throw new Error('This field is always controlled and cannot be excluded.');
  if (payload.storeValues !== undefined && typeof payload.storeValues !== 'boolean') throw new Error('storeValues must be a boolean.');
  if (payload.writable !== undefined && payload.writable !== null && typeof payload.writable !== 'boolean') throw new Error('writable must be a boolean or null.');
  const materiality = payload.materiality ?? previous?.materiality ?? deps.DEFAULT_LADDER[id] ?? deps.DEFAULT_MATERIALITY;
  if (!['COSMETIC', 'MINOR', 'MAJOR', 'CRITICAL'].includes(materiality)) throw new Error('Unknown materiality.');
  return { cf_id: null, project_id: scope.projectId, issue_type_id: scope.issueTypeId,
    field_id: id, field_name: field.field_name, field_kind: field.field_kind, schema_type: field.schema_type ?? null,
    store_values: payload.storeValues ?? Boolean(Number(previous?.store_values ?? 0)),
    writable: payload.writable ?? previous?.writable ?? null, materiality, state,
    created_at: Date.now(), created_by: accountId };
}

// Save-time and runtime configuration reads share the same schema.
export { validateConfig, stripRetiredConfig } from '../lib/configValidation.js';
