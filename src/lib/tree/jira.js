import { FailClosed } from '../errors.js';
import { TREE_LIMIT } from './model.js';
import { canonicaliseItems } from '../attachmentIdentity.js';

// Jira leaves `security` out of a response when the app cannot see the
// level. That is not "no level" (Jira gives null for that), so the node is
// read with it left absent, never invented, and capture records it as
// UNKNOWN (../evidence/treeEvidence.js). Every other requested field is required.
const OPTIONAL_FIELDS = new Set(['security']);
const omitted = (fields, f) => !OPTIONAL_FIELDS.has(f) && !(f in fields);

/**
 * `canonicalise` reads each node's attachments under the ids they stand for
 * (../attachmentIdentity.js), so every tree comparison — capture, drift, the
 * approval hash, restore and its verification — sees a restored file as the
 * approved one. One lookup per read, none when no node has an attachment.
 */
export function createTreeReader({ api, route, canonicalise = canonicaliseItems }) {
  return {
    async read(rootIssueKey, fieldIds) {
      const nodes = [];
      const edges = [];
      const visited = new Set();

      const requestedFieldIds = [...new Set([
        ...(fieldIds ?? []).map(String),
        'project', 'issuetype', 'status', 'parent'
      ])];
      const fieldsParam = requestedFieldIds.join(',');
      const rootRes = await api.asApp().requestJira(route`/rest/api/3/issue/${rootIssueKey}?fields=${fieldsParam}`);
      if (rootRes.status >= 300) throw new Error('Failed to fetch root');
      const rootIssue = await rootRes.json();

      if (!rootIssue.fields) rootIssue.fields = {};
      // The tree is rooted here. A root's own Jira parent (for example its Epic)
      // lies outside the tree, and keeping it would make capture, stable reads
      // and restore verification see a dangling edge (MISSING_PARENT).
      rootIssue.fields.parent = null;

      for (const f of requestedFieldIds) {
        if (omitted(rootIssue.fields, f)) {
          throw new Error(`Jira omitted requested field: ${f}`);
        }
      }

      nodes.push({ id: rootIssue.id, key: rootIssue.key, fields: rootIssue.fields });
      visited.add(rootIssue.id);

      let queue = [rootIssue];

      while (queue.length > 0) {
        const parentNode = queue.shift();

        let nextPageToken = null;
        const maxResults = 100;
        let isLast = false;

        while (!isLast) {
          const escapedKey = parentNode.key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const jql = `parent IN ("${escapedKey}")`;

          const payload = { jql, maxResults, fields: requestedFieldIds };
          if (nextPageToken) payload.nextPageToken = nextPageToken;

          const req = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          };

          const searchRes = await api.asApp().requestJira(route`/rest/api/3/search/jql`, req);
          if (searchRes.status >= 300) {
            throw new Error(`Failed search: ${searchRes.status}`);
          }
          const searchData = await searchRes.json();

          const issues = searchData.issues || [];
          for (const child of issues) {
            if (!child.fields) child.fields = {};
            if (!('parent' in child.fields)) child.fields.parent = null;

            for (const f of requestedFieldIds) {
              if (omitted(child.fields, f)) {
                throw new Error(`Jira omitted requested field: ${f}`);
              }
            }

            if (visited.has(child.id)) {
              // De-duplicate if it's the exact same parent (pagination artifact)
              const existingEdge = edges.find(e => e.target === child.id);
              if (existingEdge && existingEdge.source === parentNode.id) {
                continue; // Pagination duplicate, skip
              }
              // Otherwise it's a cycle or multi-paren
              throw new Error('Cycle detected');
            }
            if (nodes.length >= TREE_LIMIT) throw new FailClosed('TREE_LIMIT_EXCEEDED');

            visited.add(child.id);
            nodes.push({ id: child.id, key: child.key, fields: child.fields });
            edges.push({ source: parentNode.id, target: child.id });
            queue.push(child);
          }

          if (searchData.nextPageToken) {
            nextPageToken = searchData.nextPageToken;
          } else {
            isLast = true;
          }
        }
      }

      await canonicalise(nodes);
      return { nodes, edges };
    }
  };
}
