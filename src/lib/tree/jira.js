import { FailClosed } from '../errors.js';
import { TREE_LIMIT } from './model.js';

export function createTreeReader({ api, route }) {
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
      if (!('parent' in rootIssue.fields)) rootIssue.fields.parent = null;

      for (const f of requestedFieldIds) {
        if (!(f in rootIssue.fields)) {
          throw new Error(`Jira omitted requested field: ${f}`);
        }
      }

      nodes.push({ id: rootIssue.id, key: rootIssue.key, fields: rootIssue.fields });
      visited.add(rootIssue.id);

      let queue = [rootIssue];

      while (queue.length > 0) {
        const parentNode = queue.shift();

        let startAt = 0;
        const maxResults = 100;
        let isLast = false;

        while (!isLast) {
          const escapedKey = parentNode.key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const jql = `parent IN ("${escapedKey}")`;
          const req = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jql,
              startAt,
              maxResults,
              fields: requestedFieldIds
            })
          };

          const searchRes = await api.asApp().requestJira(route`/rest/api/3/search/jql`, req);
          if (searchRes.status >= 300) throw new Error('Failed search');
          const searchData = await searchRes.json();

          const issues = searchData.issues || [];
          for (const child of issues) {
            if (!child.fields) child.fields = {};
            if (!('parent' in child.fields)) child.fields.parent = null;

            for (const f of requestedFieldIds) {
              if (!(f in child.fields)) {
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

          startAt += issues.length;
          if (issues.length < maxResults) {
            isLast = true;
          }
        }
      }

      return { nodes, edges };
    }
  };
}
