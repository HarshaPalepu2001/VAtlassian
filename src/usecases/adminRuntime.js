// Production dependencies are loaded only when invoked; tests inject the same contracts.
export async function adminDependencies(overrides, profile = '') {
  if (overrides) return overrides;
  const [forge, db, store, ledger, directory] = await Promise.all([
    import('@forge/api'), import('../lib/db.js'), import('../db/store.js'),
    import('../lib/ledger.js'), import('../lib/directory.js')
  ]);
  const api = forge.default;
  const deps = { ...db, ...store, ...ledger, ...directory,
    asApp: () => api.asApp(), asUser: () => api.asUser(), route: forge.route,
    hasUnresolvedDrift: (await import('../db/driftStore.js')).hasUnresolvedDrift,
    listGatedTransitions: (await import('../db/configStore.js')).listGatedTransitions,
    declaredFieldRows: (await import('../db/configStore.js')).declaredFieldRows };
  deps.isJiraAdmin = async () => {
    const response = await api.asUser().requestJira(forge.route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
    if (!response.ok) throw new Error('Could not verify Jira administrator permission.');
    return (await response.json()).permissions?.ADMINISTER?.havePermission === true;
  };
  if (profile === 'adminRecovery') Object.assign(deps, await import('../lib/credentialRecovery.js'));
  if (profile === 'eligibility') Object.assign(deps, await import('../lib/eligibility.js'));
  if (profile === 'retention') Object.assign(deps, await import('../lib/retention.js'));
  if (profile === 'evidenceExport') Object.assign(deps, await import('../lib/exportRecord.js'));
  if (profile === 'adminAlerts') {
    Object.assign(deps, await import('../db/alertStore.js'));
    const alerts = await import('../jobs/alerts.js');
    deps.ALERT_PROJECT_CFG = alerts.PROJECT_KEY_CFG;
    deps.ALERT_ISSUE_TYPE_CFG = alerts.ISSUE_TYPE_CFG;
  }
  if (profile === 'fields') {
    const modules = await Promise.all([
      import('../db/configStore.js'), import('../lib/content.js'), import('../lib/trackedFields.js'),
      import('../lib/materiality.js'), import('../lib/aiClassification.js'), import('../jobs/prune.js')
    ]);
    modules.forEach(m => Object.assign(deps, m));
    // Administrative changes must surface an audit failure rather than reporting success.
    deps.tryAppend = event => deps.append(deps.auditStore, { eventId: deps.newId(), ...event });
  }
  return deps;
}

export async function query(deps, sql, params = []) {
  const result = await deps.executeQuery(sql, params);
  if (!result.result) throw new Error('Database operation failed. No success was recorded.');
  return result;
}

export async function requireAdmin(deps, context) {
  if (!context?.accountId) throw new Error('Unauthorized. Sign in to continue.');
  const result = await query(deps,
    'SELECT account_id FROM va_admin WHERE account_id = ? AND state = ?', [context.accountId, 'ACTIVE']);
  if (!Array.isArray(result.data) || !result.data.length) throw new Error('Unauthorized. An active VAtlassian administrator is required.');
}

export async function runAdmin(req, action, overrides, profile = '', { bootstrap = false } = {}) {
  try {
    if (!req?.context?.accountId) throw new Error('Unauthorized. Sign in to continue.');
    const deps = await adminDependencies(overrides, profile);
    if (!bootstrap) await requireAdmin(deps, req.context);
    const result = await action(deps);
    const success = result?.success ?? result?.ok ?? true;
    return { ...result, success, ok: success };
  } catch (error) {
    return { success: false, ok: false, error: error.message ?? 'Administration failed.' };
  }
}

export function validId(value) { return typeof value === 'string' && /^[a-fA-F0-9]{32}$/.test(value); }
export function validScope(projectId, issueTypeId) {
  return /^\d+$/.test(String(projectId ?? '')) && Number(projectId) > 0 &&
    (issueTypeId === '*' || /^\d+$/.test(String(issueTypeId ?? '')));
}
export async function audit(deps, actorAccountId, eventType, payload) {
  return deps.append(deps.auditStore, { eventId: deps.newId(), actorAccountId, eventType, payload });
}
