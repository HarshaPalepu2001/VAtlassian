import { fieldScope } from './fieldsValidation.js';
import { runAdmin } from './adminRuntime.js';
const ACTIVE_STATE = 'ACTIVE';

export async function fieldSetup(req, overrides) {
 return runAdmin(req, async (deps) => {
  const { context, payload } = req;
  const { declaredFieldRows, readScopeFields, storageReport, withAlwaysControlled, candidateFields, ALWAYS_CONTROLLED_FIELDS, DEFAULT_LADDER, DEFAULT_MATERIALITY } = deps;
  const { projectId, issueTypeId } = fieldScope(payload);
  if (!projectId || !issueTypeId) return { ok: false, error: 'NO_SCOPE' };
  const [allRows, jiraFields, storage] = await Promise.all([
    declaredFieldRows({ projectId, issueTypeId }),
    readScopeFields(projectId, issueTypeId),
    storageReport()
  ]);
  const declared = allRows.filter((f) => f.state === ACTIVE_STATE);
  const controlled = withAlwaysControlled(declared);
  const controlledIds = new Set(controlled.map((f) => f.field_id));
  const excludedIds = new Set(
    allRows.filter((f) => f.state !== ACTIVE_STATE).map((f) => f.field_id)
  );
  const addable = candidateFields(jiraFields, allRows);
  const unadopted = addable
    .filter((f) => !controlledIds.has(f.field_id) && !excludedIds.has(f.field_id))
    .map((f) => ({
      fieldId: f.field_id,
      fieldName: f.field_name,
      suggestedKind: f.field_kind,
      suggestedMateriality: DEFAULT_LADDER[f.field_id] ?? DEFAULT_MATERIALITY,
      schemaType: f.schema_type ?? null,
      recommended: Object.prototype.hasOwnProperty.call(DEFAULT_LADDER, f.field_id)
    }));
  return {
    ok: true,
    controlled: controlled.map((f) => ({
      ...f,
      pinned: ALWAYS_CONTROLLED_FIELDS.some(p => p.field_id === f.field_id),
      declared: allRows.some(r => r.field_id === f.field_id && String(r.issue_type_id) === issueTypeId),
      restorable: f.writable !== false
    })),
    trackedCount: controlled.length,
    excluded: allRows
      .filter((f) => f.state !== ACTIVE_STATE)
      .map((f) => ({
        fieldId: f.field_id,
        fieldName: f.field_name,
        suggestedKind: f.field_kind,
        schemaType: f.schema_type ?? null
      })),
    available: unadopted,
    coverage: {
      tracked: controlled.length,
      excluded: excludedIds.size,
      unadopted: unadopted.length,
      neverTrackable: Math.max(0, jiraFields.length - addable.length)
    },
    storage
  };
 }, overrides, 'fields');
}

export async function syncFields(req, overrides) {
 return runAdmin(req, async (deps) => {
  const { context, payload } = req;
  const { syncTrackedFields } = deps;
  const accountId = context.accountId;
  const scope = fieldScope(payload);
  return syncTrackedFields({
    ...scope,
    accountId
  });
 }, overrides, 'fields');
}
