import { fieldScope, fieldCatalogue } from './fieldsValidation.js';
import { runAdmin } from './adminRuntime.js';
const ACTIVE_STATE = 'ACTIVE';

export async function classifyFieldsForBaseline(req, overrides) {
 return runAdmin(req, async (deps) => {
  const { context, payload } = req;
  const { projectConfig, declaredFieldRows, readScopeFields, withAlwaysControlled, candidateFields, ALWAYS_CONTROLLED_FIELDS, classifyFields, CLASSIFICATION } = deps;
  const { projectId, issueTypeId } = fieldScope(payload);
  if (!Number.isFinite(projectId)) return { ok: false, error: 'NO_PROJECT' };
  const [allRows, jiraFields, config] = await Promise.all([
    declaredFieldRows({ projectId, issueTypeId }),
    readScopeFields(projectId, issueTypeId),
    projectConfig(projectId)
  ]);
  if (jiraFields.length === 0) {
    return {
      ok: false,
      error: 'CATALOGUE_UNAVAILABLE',
      message: "Jira's field list could not be read just now. Try again shortly."
    };
  }
  const candidates = withAlwaysControlled(candidateFields(jiraFields, allRows));
  const byId = new Map(candidates.map((f) => [f.field_id, f]));
  const stateByField = new Map(allRows.map((f) => [f.field_id, f.state]));
  const alwaysIds = new Set(ALWAYS_CONTROLLED_FIELDS.map((f) => f.field_id));
  const model = config.ai?.models?.light ?? 'claude-haiku-4-5-20251001';
  const result = await classifyFields({
    fields: candidates,
    model,
    aiEnabled: config.ai?.enabled !== false,
    maxCompletionTokens: config.ai?.maxCompletionTokens
  });
  return {
    ok: true,
    degraded: result.degraded,
    degradedReason: result.degradedReason ?? null,
    model: result.model,
    fields: result.classifications.map((c) => {
      const candidate = byId.get(c.fieldId);
      return {
        fieldId: c.fieldId,
        fieldName: candidate?.field_name ?? c.fieldId,
        fieldKind: candidate?.field_kind ?? 'TEXT',
        schemaType: candidate?.schema_type ?? null,
        decision: alwaysIds.has(c.fieldId) ? CLASSIFICATION.GXP : c.decision,
        rationale: c.rationale,
        pinned: alwaysIds.has(c.fieldId),
        currentState: stateByField.get(c.fieldId) ?? 'UNRULED'
      };
    })
  };
 }, overrides, 'fields');
}

export async function saveControlledFieldsBaseline(req, overrides) {
 return runAdmin(req, async (deps) => {
  const { context, payload } = req;
  const { DEFAULT_LADDER, DEFAULT_MATERIALITY, CLASSIFICATION, partitionForBaseline, buildBaselineAuditPayload, upsertControlledField, tryAppend, EVENT } = deps;
  const accountId = context.accountId;
  const { projectId, issueTypeId } = fieldScope(payload);
  if (!Number.isFinite(projectId)) {
    return { ok: false, error: 'NO_PROJECT', message: 'No project was selected, so nothing was saved.' };
  }
  const submitted = [
    ...(Array.isArray(payload?.trackedFields) ? payload.trackedFields : [])
      .map((f) => ({ ...f, decision: CLASSIFICATION.GXP })),
    ...(Array.isArray(payload?.excludedFields) ? payload.excludedFields : [])
      .map((f) => ({ ...f, decision: CLASSIFICATION.NON_GXP }))
  ];
  if (submitted.length === 0) {
    return { ok: false, error: 'NOTHING_SUBMITTED', message: 'No fields were reviewed, so nothing was saved.' };
  }
  const catalogue = await fieldCatalogue(deps, { projectId, issueTypeId });
  for (const f of submitted) {
    if (!catalogue.byId.has(f.fieldId)) throw new Error(`Field ${f.fieldId} is not available for baselining.`);
    if (f.storeValues !== undefined && typeof f.storeValues !== 'boolean') throw new Error('storeValues must be a boolean.');
  }
  const fieldsById = catalogue.byId;
  const retentionById = new Map(submitted.map(f => [f.fieldId, f.storeValues]));
  const storeValuesFor = id => retentionById.get(id) ?? Boolean(Number(catalogue.rows.find(r => r.field_id === id && String(r.issue_type_id) === issueTypeId)?.store_values ?? 0));
  const { tracked, excluded } = partitionForBaseline(submitted, fieldsById);
  const now = Date.now();
  const auditPayload = buildBaselineAuditPayload({
    projectId, issueTypeId, tracked, excluded, now
  });
  await tryAppend({
    actorAccountId: accountId,
    eventType: EVENT.CONTROLLED_FIELDS_BASELINED,
    issueId: null,
    payload: auditPayload
  });
  for (const f of tracked) {
    await upsertControlledField({
      cf_id: null,
      project_id: projectId,
      issue_type_id: issueTypeId,
      field_id: f.fieldId,
      field_name: f.fieldName,
      field_kind: f.fieldKind,
      schema_type: f.schemaType,
      store_values: storeValuesFor(f.fieldId),
      writable: null,
      materiality: String(DEFAULT_LADDER[f.fieldId] ?? DEFAULT_MATERIALITY),
      state: ACTIVE_STATE,
      created_at: now,
      created_by: accountId
    });
  }
  for (const f of excluded) {
    await upsertControlledField({
      cf_id: null,
      project_id: projectId,
      issue_type_id: issueTypeId,
      field_id: f.fieldId,
      field_name: f.fieldName,
      field_kind: f.fieldKind,
      schema_type: f.schemaType,
      store_values: storeValuesFor(f.fieldId),
      writable: null,
      materiality: String(DEFAULT_MATERIALITY),
      state: 'EXCLUDED',
      created_at: now,
      created_by: accountId
    });
  }
  return {
    ok: true,
    tracked: tracked.length,
    excluded: excluded.length,
    note: `Baseline saved: ${tracked.length} field${tracked.length === 1 ? '' : 's'} tracked as GxP-controlled, `
      + `${excluded.length} excluded.`
  };
 }, overrides, 'fields');
}
