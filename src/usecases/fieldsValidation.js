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

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Configuration must be an object.');
  const allowed = new Set(['enabled', 'reviewStatusIds', 'queueThreshold', 'visibility', 'ai', 'restore', 'notifications', 'policy']);
  if (Object.keys(config).some(k => !allowed.has(k))) throw new Error('Unknown configuration key.');
  for (const key of ['enabled']) if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
  if (config.reviewStatusIds !== undefined && (!Array.isArray(config.reviewStatusIds) || config.reviewStatusIds.some(s => !/^\d+$/.test(String(s))))) throw new Error('Invalid review statuses.');
  if (config.queueThreshold !== undefined && !['COSMETIC', 'MINOR', 'MAJOR', 'CRITICAL'].includes(config.queueThreshold)) throw new Error('Invalid queue threshold.');
  if (config.visibility !== undefined && !['reviewer-only', 'all'].includes(config.visibility)) throw new Error('Invalid visibility.');
  if (config.policy !== undefined) {
    if (!config.policy || typeof config.policy !== 'object' || Array.isArray(config.policy)) throw new Error('Invalid policy settings.');
    if (Object.keys(config.policy).some(k => !['mode'].includes(k))) throw new Error('Unknown policy setting.');
    if (config.policy.mode !== undefined && !['STRICT', 'DETECT'].includes(config.policy.mode)) throw new Error('Policy mode must be STRICT or DETECT.');
  }
  if (config.ai !== undefined) {
    if (!config.ai || typeof config.ai !== 'object' || Array.isArray(config.ai)) throw new Error('Invalid AI settings.');
    if (Object.keys(config.ai).some(k => !['enabled', 'models', 'maxCompletionTokens'].includes(k))) throw new Error('Unknown AI setting.');
    if (config.ai.enabled !== undefined && typeof config.ai.enabled !== 'boolean') throw new Error('AI enabled must be a boolean.');
    const tokens = config.ai.maxCompletionTokens;
    if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < 256 || tokens > 16384)) throw new Error('AI token limit must be between 256 and 16384.');
    if (config.ai.models !== undefined && (!config.ai.models || typeof config.ai.models !== 'object' || Array.isArray(config.ai.models) ||
      Object.entries(config.ai.models).some(([k, v]) => !['light', 'standard', 'deep'].includes(k) || typeof v !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(v)))) throw new Error('Invalid AI model settings.');
  }
  if (config.restore !== undefined) {
    if (!config.restore || typeof config.restore !== 'object' || Array.isArray(config.restore)) throw new Error('Invalid restore settings.');
    if (Object.keys(config.restore).some(k => !['actAs', 'notifyUsers', 'perFieldRetries', 'commentOnRestore'].includes(k))) throw new Error('Unknown restore setting.');
    if (config.restore.commentOnRestore !== undefined && typeof config.restore.commentOnRestore !== 'boolean') throw new Error('commentOnRestore must be a boolean.');
    if (config.restore.notifyUsers !== undefined && typeof config.restore.notifyUsers !== 'boolean') throw new Error('notifyUsers must be a boolean.');
    if (config.restore.perFieldRetries !== undefined && (!Number.isSafeInteger(config.restore.perFieldRetries) || config.restore.perFieldRetries < 0 || config.restore.perFieldRetries > 10)) throw new Error('perFieldRetries must be between 0 and 10.');
    if (config.restore.actAs !== undefined && !['app', 'user'].includes(config.restore.actAs)) throw new Error('Invalid actAs value.');
  }
  if (config.notifications !== undefined) {
    if (!config.notifications || typeof config.notifications !== 'object' || Array.isArray(config.notifications)) throw new Error('Invalid notification settings.');
    if (Object.keys(config.notifications).some(k => !['digest', 'digestAfterHours'].includes(k))) throw new Error('Unknown notification setting.');
    if (config.notifications.digest !== undefined && typeof config.notifications.digest !== 'boolean') throw new Error('digest must be a boolean.');
    if (config.notifications.digestAfterHours !== undefined && (!Number.isSafeInteger(config.notifications.digestAfterHours) || config.notifications.digestAfterHours < 1 || config.notifications.digestAfterHours > 168)) throw new Error('digestAfterHours must be between 1 and 168.');
  }
  // Only JSON data is persisted; reject prototype keys at every depth before merge.
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid configuration key.');
      walk(child);
    }
  };
  walk(config);
  if (JSON.stringify(config).length > 20000) throw new Error('Configuration is too large.');
  return config;
}
