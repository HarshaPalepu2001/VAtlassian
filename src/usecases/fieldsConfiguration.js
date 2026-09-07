import { runAdmin } from './adminRuntime.js';
import { fieldScope, fieldCatalogue, fieldRow, validateConfig } from './fieldsValidation.js';

export async function saveField(req, overrides) {
  return runAdmin(req, async deps => {
    const scope = fieldScope(req.payload);
    const catalogue = await fieldCatalogue(deps, scope);
    const row = fieldRow(deps, scope, req.payload, catalogue, req.context.accountId);
    await deps.tryAppend({ actorAccountId: req.context.accountId, eventType: deps.EVENT.CONFIG_CHANGED,
      payload: { scope: 'trackedFields', ...scope, fieldId: row.field_id, state: row.state, storeValues: row.store_values, action: 'SAVE_REQUESTED' } });
    const id = await deps.upsertControlledField(row);
    return { ok: true, cfId: Buffer.isBuffer(id) ? id.toString('base64') : id,
      note: `${row.field_name} is ${row.state === 'ACTIVE' ? 'tracked' : 'excluded'} from the next baseline onward. Existing evidence is retained.` };
  }, overrides, 'fields');
}

export async function trackField(req, overrides) {
  return saveField({ ...req, payload: { ...req.payload, state: 'ACTIVE' } }, overrides);
}

export async function deleteField(req, overrides) {
  // Removing a row can make a sync adopt it again. Persist an explicit exclusion.
  return saveField({ ...req, payload: { ...req.payload, state: 'EXCLUDED' } }, overrides);
}

export async function setRetention(req, overrides) {
  return runAdmin(req, async deps => {
    const scope = fieldScope(req.payload);
    const { fieldId, storeValues } = req.payload ?? {};
    if (typeof storeValues !== 'boolean') throw new Error('storeValues must be a boolean.');
    const rows = await deps.declaredFieldRows(scope);
    if (!rows.some(r => r.field_id === fieldId && String(r.issue_type_id) === scope.issueTypeId)) throw new Error('Configure this field in the selected scope first.');
    await deps.tryAppend({ actorAccountId: req.context.accountId, eventType: deps.EVENT.FIELD_RETENTION_CHANGED,
      payload: { ...scope, fieldId, storeValues, action: 'CHANGE_REQUESTED' } });
    if (!await deps.setFieldRetention({ ...scope, fieldId, storeValues })) throw new Error('Failed to save field retention.');
    return { ok: true, note: storeValues
      ? 'Field contents will be retained from the next approval. Existing baselines are unaffected.'
      : 'Future approvals will retain only the digest. Existing values remain subject to the evidence retention policy.' };
  }, overrides, 'fields');
}

export async function saveConfig(req, overrides) {
  return runAdmin(req, async deps => {
    const payload = req.payload ?? {};
    const key = payload.projectId == null ? 'site' : `project:${fieldScope({ ...payload, issueTypeId: '*' }).projectId}`;
    const config = validateConfig(payload.config ?? {});
    await deps.tryAppend({ actorAccountId: req.context.accountId, eventType: deps.EVENT.CONFIG_CHANGED,
      payload: { scope: key, keys: Object.keys(config), action: 'SAVE_REQUESTED', config } });
    await deps.setConfig(key, config, req.context.accountId, Date.now());
    return { ok: true };
  }, overrides, 'fields');
}

export async function getConfig(req, overrides) {
  return runAdmin(req, async deps => {
    const projectId = req.payload?.projectId;
    if (projectId != null) fieldScope({ projectId });
    return { config: await deps.projectConfig(projectId ?? null) };
  }, overrides, 'fields');
}
