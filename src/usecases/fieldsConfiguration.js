import { runAdmin } from './adminRuntime.js';
import { fieldScope, fieldCatalogue, fieldRow, validateConfig, stripRetiredConfig } from './fieldsValidation.js';

/** listGatedTransitions() already decodes capture_baseline to a real boolean
 *  (configStore.js normalizes Forge SQL's 0/1 with `!!Number(...)`), so a
 *  plain truthy check here is correct. */
export async function assertRetentionRemovable(deps, scope) {
  const gates = await deps.listGatedTransitions(scope.projectId);
  const scopeCoversGate = gate => scope.issueTypeId === '*'
    || String(gate.issue_type_id) === scope.issueTypeId
    || String(gate.issue_type_id) === '*';
  if (gates.some(g => g.state === 'ACTIVE' && scopeCoversGate(g) && g.capture_baseline)) {
    throw new Error('Retention cannot be disabled because a capture-baseline policy is active.');
  }
}

export async function saveField(req, overrides) {
  return runAdmin(req, async deps => {
    const scope = fieldScope(req.payload);
    const catalogue = await fieldCatalogue(deps, scope);
    const row = fieldRow(deps, scope, req.payload, catalogue, req.context.accountId);
    if (row.store_values === false) await assertRetentionRemovable(deps, scope);
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
    if (storeValues === false) await assertRetentionRemovable(deps, scope);
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
    const rawPid = payload.projectId;
    const pid = (rawPid != null && rawPid !== '' && rawPid !== 'site')
      ? String(fieldScope({ ...payload, issueTypeId: '*' }).projectId)
      : null;
    const key = pid ? `project:${pid}` : 'site';
    const patch = validateConfig(payload.config ?? {});
    const current = await deps.readConfigRecord(key);
    if (Object.hasOwn(payload, 'expectedRevision') && payload.expectedRevision !== current.revision) {
      throw new Error('Settings changed since you loaded this page. Reload and review the latest values before saving.');
    }
    const merge = (base, over) => Object.fromEntries(Object.entries({ ...base, ...over }).map(([k, v]) =>
      [k, over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) ? merge(base?.[k] ?? {}, over[k]) : v]));
    // Retired keys are dropped from the stored side before the merge: a value
    // written before a key was retired must not make every later save fail.
    const config = validateConfig(merge(stripRetiredConfig(current.config), patch));
    if (config.policy?.mode === 'STRICT') {
      if (await deps.hasUnresolvedDrift(pid)) {
        throw new Error('Cannot enable STRICT mode: there is unresolved drift. Approve or reject all pending drift first.');
      }
      throw new Error('STRICT mode is not supported. Approval is enforced by configured Jira workflow validators; content changes are detected after they occur.');
    }
    await deps.tryAppend({ actorAccountId: req.context.accountId, eventType: deps.EVENT.CONFIG_CHANGED,
      payload: { scope: key, keys: Object.keys(config), action: 'SAVE_REQUESTED', config } });
    if (!await deps.setConfigIfCurrent(key, config, req.context.accountId, Date.now(), current.revision)) {
      throw new Error('Settings changed during this save. Reload and review the latest values before trying again.');
    }
    return { ok: true };
  }, overrides, 'fields');
}

export async function getConfig(req, overrides) {
  return runAdmin(req, async deps => {
    const rawPid = req.payload?.projectId;
    const pid = (rawPid != null && rawPid !== '' && rawPid !== 'site')
      ? String(fieldScope({ projectId: rawPid }).projectId)
      : null;
    const key = pid ? `project:${pid}` : 'site';
    const record = await deps.readConfigRecord(key);
    if (pid != null) await deps.readConfigRecord('site');
    // Stripped on read as well as on write, so the page never renders a
    // control for a setting no module reads.
    return { config: stripRetiredConfig(await deps.projectConfig(pid)), revision: record.revision };
  }, overrides, 'fields');
}
