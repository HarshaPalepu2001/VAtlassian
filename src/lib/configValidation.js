/**
 * Accept settings only when a runtime module reads them. A saved setting
 * must control the behavior the administration page describes.
 *
 * stripRetiredConfig() removes keys accepted by earlier builds but now refused:
 *   visibility has no reader; panelAccess.js uses Jira issue security instead.
 *   notifications.* has no reader or digest job.
 *   restore.commentOnRestore is not read by executeRestore().
 *   reviewStatusIds has no reader that supersedes approvals on status re-entry.
 *   queueThreshold only relabelled rows, sometimes calling major changes
 *                  "Formatting only". All drift still queues and holds.
 *
 * Keep policy.mode because saveConfig explicitly refuses STRICT instead of
 * saving an unenforced locking setting. See fieldsConfiguration.js.
 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Configuration must be an object.');
  const allowed = new Set(['enabled', 'ai', 'restore', 'policy', 'vault']);
  if (Object.keys(config).some(k => !allowed.has(k))) throw new Error('Unknown configuration key.');
  for (const key of ['enabled']) if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
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
    if (Object.keys(config.restore).some(k => !['actAs', 'notifyUsers', 'perFieldRetries'].includes(k))) throw new Error('Unknown restore setting.');
    if (config.restore.notifyUsers !== undefined && typeof config.restore.notifyUsers !== 'boolean') throw new Error('notifyUsers must be a boolean.');
    if (config.restore.perFieldRetries !== undefined && (!Number.isSafeInteger(config.restore.perFieldRetries) || config.restore.perFieldRetries < 0 || config.restore.perFieldRetries > 10)) throw new Error('perFieldRetries must be between 0 and 10.');
    if (config.restore.actAs !== undefined && !['app', 'user'].includes(config.restore.actAs)) throw new Error('Invalid actAs value.');
  }
  if (config.vault !== undefined) {
    if (!config.vault || typeof config.vault !== 'object' || Array.isArray(config.vault)) throw new Error('Invalid attachment protection settings.');
    if (Object.keys(config.vault).some(k => !['lockAttachmentDeletion'].includes(k))) throw new Error('Unknown attachment protection setting.');
    if (config.vault.lockAttachmentDeletion !== undefined && typeof config.vault.lockAttachmentDeletion !== 'boolean') throw new Error('lockAttachmentDeletion must be a boolean.');
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

/**
 * Remove retired keys from stored configuration without changing live siblings.
 *
 * saveConfig validates the merge of the stored row and incoming patch. Retired
 * stored keys would otherwise block every later save. Read paths also use this
 * function so the UI does not offer controls for unused settings.
 */
export function stripRetiredConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const { visibility, notifications, reviewStatusIds, queueThreshold, ...rest } = config;
  if (rest.restore && typeof rest.restore === 'object' && !Array.isArray(rest.restore)) {
    const { commentOnRestore, ...restore } = rest.restore;
    rest.restore = restore;
  }
  return rest;
}
