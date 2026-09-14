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

const PERMISSION_FOR_KIND = {
  CREATE_REPLACEMENT: 'CREATE_ISSUES',
  MOVE_NODE: 'EDIT_ISSUES',
  RESTORE_FIELDS: 'EDIT_ISSUES',
  DELETE_ADDED_NODE: 'DELETE_ISSUES'
};

export function createRestoreAdapters({ api, route }) {
  const request = (path, options) => api.asApp().requestJira(path, options);
  return {
    /**
     * A recursive hierarchy can span more than one Jira project. Checking
     * permissions only against rootIssueKey lets a plan pass preflight and
     * then fail midway on a child in a project the actor cannot touch.
     * Grouped by project (never by node — that would reintroduce an
     * unbounded-round-trip risk like the unbatched tree writer had), so
     * this is at most one request per DISTINCT project the plan touches,
     * not one per step.
     */
    async checkPermissions({ steps, rootIssueKey, baselineTree, currentTree }) {
      const nodesByLogicalId = new Map();
      for (const node of baselineTree?.nodes ?? []) nodesByLogicalId.set(String(node.logicalNodeId), node);
      for (const node of currentTree?.nodes ?? []) nodesByLogicalId.set(String(node.logicalNodeId), node);

      const groups = new Map(); // groupKey -> { projectId, permissions: Set }
      for (const step of steps) {
        const permission = PERMISSION_FOR_KIND[step.kind];
        if (!permission) continue;
        const node = step.kind === 'CREATE_REPLACEMENT' ? step.node : nodesByLogicalId.get(String(step.logicalNodeId));
        const projectId = node?.projectId != null ? String(node.projectId) : null;
        const groupKey = projectId ?? `root:${rootIssueKey}`;
        if (!groups.has(groupKey)) groups.set(groupKey, { projectId, permissions: new Set() });
        groups.get(groupKey).permissions.add(permission);
      }
      if (groups.size === 0) return true;

      for (const { projectId, permissions } of groups.values()) {
        const names = [...permissions].sort();
        const query = projectId != null
          ? route`/rest/api/3/mypermissions?projectId=${projectId}&permissions=${names.join(',')}`
          : route`/rest/api/3/mypermissions?issueKey=${rootIssueKey}&permissions=${names.join(',')}`;
        const response = await request(query, { headers: { Accept: 'application/json' } });
        if (!ok(response)) return false;
        const body = await responseBody(response);
        if (!names.every(name => body?.permissions?.[name]?.havePermission === true)) return false;
      }
      return true;
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
