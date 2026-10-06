import { findLinkConflicts, LinkConflictError } from '../restore/linkConflicts.js';
import { restoreAttachments, pointAtLiveFiles, explainRichTextRefusal } from '../restore/attachments.js';
import { adfMediaIds } from '../attachmentIdentity.js';

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
  RESTORE_LINKS: 'EDIT_ISSUES',
  // Deleting an added file is not checked here: on a project whose attachment
  // deletion is locked only the app's own account holds that grant, and a
  // refusal is named per file rather than failing the whole restore.
  RESTORE_ATTACHMENTS: 'CREATE_ATTACHMENTS',
  REPOINT_RICH_TEXT: 'EDIT_ISSUES',
  DELETE_ADDED_NODE: 'DELETE_ISSUES'
};

/**
 * `actorAccountId`/`approvalId`: the signed rejection, recorded on the audit
 * entries an attachment restore writes.
 */
export function createRestoreAdapters({ api, route, actorAccountId = 'system', approvalId = null, attachmentDeps = null,
  approvedLinksOf = null }) {
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
      // Files cannot be set on create; RESTORE_ATTACHMENTS uploads them after.
      // Nor can rich text that shows them, which Jira would refuse until they
      // exist: RESTORE_FIELDS writes it once they do.
      delete fields.attachment;
      for (const [fieldId, value] of Object.entries(fields)) {
        if (adfMediaIds(value).length > 0) delete fields[fieldId];
      }
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
      try {
        await checked(await request(
          route`/rest/api/3/issue/${issueIdOrKey}?overrideScreenSecurity=true&overrideEditableFlag=true`,
          requestOptions('PUT', { fields })
        ), 'RESTORE_FIELDS');
      } catch (error) {
        if (error instanceof JiraRestoreError) error.detail = explainRichTextRefusal(error.detail);
        throw error;
      }
      return { issueIdOrKey, fieldIds: Object.keys(fields).sort() };
    },

    /**
     * Rich text pointed at the files the item has now (../restore/attachments.js):
     * of two copies of one original, the one still on the item.
     */
    async pointAtLiveFiles(issueId, fields) {
      if (!Object.values(fields ?? {}).some(value => adfMediaIds(value).length > 0)) return fields;
      const deps = attachmentDeps ?? (await import('../restore/attachmentAdapters.js'))
        .createAttachmentRestoreDeps({ api, route, actorAccountId, approvalId });
      const record = deps.identity ? await deps.identity(issueId) : null;
      let liveJiraIds = null;
      if (record?.media?.size && deps.readCurrent) {
        try {
          liveJiraIds = new Set((await deps.readCurrent(String(issueId))).map(a => String(a?.id ?? '')));
        } catch (error) {
          console.error('restore: could not read the files on the item; the newest restored copy is shown', error);
        }
      }
      return pointAtLiveFiles(fields, record, { liveJiraIds });
    },

    async restoreLinks(issueIdOrKey, target) {
      if (!Array.isArray(target)) {
        throw new JiraRestoreError({ operation: 'RESTORE_LINKS', status: null,
          detail: 'The approved issue-link list is not complete.' });
      }
      const read = await request(route`/rest/api/3/issue/${issueIdOrKey}?fields=issuelinks`, { headers: { Accept: 'application/json' } });
      if (!ok(read)) throw new JiraRestoreError({ operation: 'READ_LINKS', status: Number(read.status) || null,
        detail: errorText(await responseBody(read)) });
      const body = await responseBody(read);
      const current = body?.fields?.issuelinks;
      if (!Array.isArray(current)) {
        throw new JiraRestoreError({ operation: 'READ_LINKS', status: null,
          detail: 'Jira omitted the current issue links; no links were changed.' });
      }

      const desired = new Map(target.map(link => [linkIdentity(link), link]));
      const existing = new Map(current.map(link => [linkIdentity(link), link]));
      // A link belongs to both ends (../restore/linkConflicts.js). A change the
      // other end's approved state forbids is left exactly as it is.
      const conflicts = await findLinkConflicts({ selfIssueId: body?.id ?? issueIdOrKey,
        additions: [...desired].filter(([key]) => !existing.has(key)).map(([, link]) => link),
        removals: [...existing].filter(([key]) => !desired.has(key)).map(([, link]) => link),
        approvedLinksOf });
      const held = new Set(conflicts.map(c => linkIdentity(c.link)));
      const additions = [...desired].filter(([key]) => !existing.has(key) && !held.has(key));
      const removals = [...existing].filter(([key]) => !desired.has(key) && !held.has(key));
      if (removals.some(([, link]) => !link.id)) {
        throw new JiraRestoreError({ operation: 'RESTORE_LINKS', status: null,
          detail: 'A current issue link has no deletion id; the link set cannot be restored exactly.' });
      }

      await Promise.all(additions.map(async ([, link]) => {
        const direction = link.inwardIssue ? 'inwardIssue' : 'outwardIssue';
        const opposite = direction === 'inwardIssue' ? 'outwardIssue' : 'inwardIssue';
        const other = link[direction];
        const body = { type: link.type.id != null ? { id: String(link.type.id) } : { name: link.type.name },
          [direction]: other.id != null ? { id: String(other.id) } : { key: other.key },
          [opposite]: { key: String(issueIdOrKey) } };
        await checked(await request(route`/rest/api/3/issueLink`, requestOptions('POST', body)), 'RESTORE_LINKS');
      }));
      await Promise.all(removals.map(async ([, link]) => {
        const response = await request(route`/rest/api/3/issueLink/${link.id}`, { method: 'DELETE', headers: { Accept: 'application/json' } });
        if (!ok(response) && Number(response.status) !== 404) {
          throw new JiraRestoreError({ operation: 'RESTORE_LINKS', status: Number(response.status) || null,
            detail: errorText(await responseBody(response)) });
        }
      }));
      // The rest of the set is restored; the step still refuses, so the
      // reviewer is told which link was kept and why.
      if (conflicts.length) throw new LinkConflictError(conflicts);
      return { issueIdOrKey, added: additions.length, removed: removals.length };
    },

    async restoreAttachments({ issueKey, issueId, sourceIssueId, target }) {
      return restoreAttachments({ issueKey, issueId, sourceIssueId, target,
        deps: attachmentDeps ?? (await import('../restore/attachmentAdapters.js'))
          .createAttachmentRestoreDeps({ api, route, actorAccountId, approvalId }) });
    },

    async deleteIssue(issueIdOrKey) {
      await checked(await request(route`/rest/api/3/issue/${issueIdOrKey}`, requestOptions('DELETE')), 'DELETE_ADDED_NODE');
      return { issueIdOrKey };
    }
  };
}

function linkIdentity(link) {
  const direction = link?.inwardIssue ? 'inwardIssue' : 'outwardIssue';
  const other = link?.[direction];
  const type = link?.type?.id ?? link?.type?.name;
  if (!type || !other || !(other.id ?? other.key) || (link.inwardIssue && link.outwardIssue)) {
    throw new JiraRestoreError({ operation: 'RESTORE_LINKS', status: null,
      detail: 'A link is missing its type, direction or linked issue identity.' });
  }
  return JSON.stringify([String(type), direction, String(other.id ?? other.key)]);
}
