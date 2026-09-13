export class JiraRestoreError extends Error {
  constructor({ operation, status, detail }) {
    super(`${operation} failed${status ? ` (${status})` : ''}: ${detail}`);
    this.name = 'JiraRestoreError';
    this.code = 'JIRA_RESTORE_FAILED';
    this.operation = operation;
    this.status = status;
    this.detail = detail;
  }
}

const ok = response => response?.ok === true || (Number(response?.status) >= 200 && Number(response?.status) < 300);

async function responseBody(response) {
  try {
    if (typeof response?.json === 'function') return await response.json();
  } catch { /* fall through to text */ }
  try {
    if (typeof response?.text === 'function') return await response.text();
  } catch { /* use status text below */ }
  return response?.statusText ?? '';
}

function errorText(body) {
  if (typeof body === 'string') return body || 'Jira returned no error detail';
  const messages = Array.isArray(body?.errorMessages) ? body.errorMessages.map(String) : [];
  const fields = Object.entries(body?.errors ?? {}).map(([field, message]) => `${field}: ${String(message)}`);
  const fallback = body?.message ? [String(body.message)] : [];
  return [...messages, ...fields, ...fallback].join('; ') || 'Jira returned no error detail';
}

async function checked(response, operation) {
  if (ok(response)) return response;
  throw new JiraRestoreError({ operation, status: Number(response?.status) || null,
    detail: errorText(await responseBody(response)) });
}

function requestOptions(method, body) {
  const options = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  return options;
}

export function createRestoreAdapters({ api, route }) {
  const request = (path, options) => api.asApp().requestJira(path, options);
  return {
    async checkPermissions({ steps, rootIssueKey }) {
      const permissions = new Set();
      for (const step of steps) {
        if (step.kind === 'CREATE_REPLACEMENT') permissions.add('CREATE_ISSUES');
        if (step.kind === 'MOVE_NODE' || step.kind === 'RESTORE_FIELDS') permissions.add('EDIT_ISSUES');
        if (step.kind === 'DELETE_ADDED_NODE') permissions.add('DELETE_ISSUES');
      }
      if (permissions.size === 0) return true;
      const names = [...permissions].sort();
      const response = await request(route`/rest/api/3/mypermissions?issueKey=${rootIssueKey}&permissions=${names.join(',')}`,
        { headers: { Accept: 'application/json' } });
      if (!ok(response)) return false;
      const body = await responseBody(response);
      return names.every(name => body?.permissions?.[name]?.havePermission === true);
    },

    async createIssue(parentKey, node, retainedFields = {}) {
      const fields = { ...retainedFields };
      delete fields.status;
      delete fields.parent;
      fields.project = { id: String(node?.projectId ?? node?.fields?.project?.id ?? '') };
      fields.issuetype = { id: String(node?.issueTypeId ?? node?.fields?.issuetype?.id ?? '') };
      if (parentKey != null) fields.parent = { key: String(parentKey) };
      const response = await checked(await request(route`/rest/api/3/issue`, requestOptions('POST', { fields })), 'CREATE_REPLACEMENT');
      const body = await responseBody(response);
      if (!body?.id || !body?.key) {
        throw new JiraRestoreError({ operation: 'CREATE_REPLACEMENT', status: Number(response.status) || null,
          detail: 'Jira created no durable issue identity' });
      }
      return { newIssueId: body.id, newIssueKey: body.key };
    },

    async moveIssue(issueIdOrKey, parentKey) {
      const body = parentKey == null
        ? { update: { parent: [{ set: { none: true } }] } }
        : { fields: { parent: { key: String(parentKey) } } };
      await checked(await request(
        route`/rest/api/3/issue/${issueIdOrKey}?overrideScreenSecurity=true&overrideEditableFlag=true`,
        requestOptions('PUT', body)
      ), 'MOVE_NODE');
      return { issueIdOrKey, parentKey };
    },

    async editIssue(issueIdOrKey, fields) {
      await checked(await request(
        route`/rest/api/3/issue/${issueIdOrKey}?overrideScreenSecurity=true&overrideEditableFlag=true`,
        requestOptions('PUT', { fields })
      ), 'RESTORE_FIELDS');
      return { issueIdOrKey, fieldIds: Object.keys(fields).sort() };
    },

    async deleteIssue(issueIdOrKey) {
      await checked(await request(route`/rest/api/3/issue/${issueIdOrKey}`, requestOptions('DELETE')), 'DELETE_ADDED_NODE');
      return { issueIdOrKey };
    }
  };
}
