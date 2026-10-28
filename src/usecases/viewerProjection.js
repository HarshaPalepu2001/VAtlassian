import api, { route } from '@forge/api';
import { logicalNodeId } from '../lib/tree/model.js';

const ISSUE_KEY = /\b[A-Z][A-Z0-9_]*-\d+\b/g;
const ISSUE_ID_TEXT = /(?:\b(?:issue|work item)\s+|\/issue\/)(\d+)\b/gi;
const ID_FIELDS = new Set(['issueId', 'issue_id', 'currentIssueId', 'originalIssueId', 'newIssueId']);
const KEY_FIELDS = new Set(['issueKey', 'issue_key', 'newIssueKey']);
const LOGICAL_FIELDS = new Set(['logicalNodeId', 'logical_node_id', 'parentLogicalNodeId', 'parentLogicalId']);
const OMIT = Symbol('not visible');
const numericId = value => /^\d+$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? String(value) : null;

/** Search only as the viewer, in bounded batches. Missing/failed pages grant nothing. */
async function findViewableIssues(keys) {
  const issues = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    const batch = keys.slice(offset, offset + 100);
    let nextPageToken;
    const seen = new Set();
    do {
      try {
        const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jql: `key in (${batch.map(key => `"${key}"`).join(',')})`,
            fields: ['key'], maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) })
        });
        if (!response?.ok) break;
        const body = await response.json();
        if (!Array.isArray(body?.issues)) break;
        issues.push(...body.issues.filter(issue => batch.includes(issue?.key) && numericId(issue?.id)));
        nextPageToken = body.isLast === true ? null : body.nextPageToken;
        if (nextPageToken && seen.has(nextPageToken)) break;
        seen.add(nextPageToken);
      } catch { break; }
    } while (nextPageToken);
  }
  return issues;
}

async function filterViewableTree(tree) {
  const ids = tree.nodes.map(node => Number(node.id));
  const visible = new Set();
  // Baseline/current trees plus retained restore histories can exceed one tree's cap.
  // Jira accepts at most 1000 issue IDs in a bulk permission request.
  for (let offset = 0; offset < ids.length; offset += 1000) {
    const batch = ids.slice(offset, offset + 1000);
    try {
      const response = await api.asUser().requestJira(route`/rest/api/3/permissions/check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPermissions: [{ issues: batch, permissions: ['BROWSE_PROJECTS'] }] })
      });
      if (!response?.ok) continue;
      const body = await response.json();
      for (const grant of Array.isArray(body?.projectPermissions) ? body.projectPermissions : []) {
        if (grant?.permission !== 'BROWSE_PROJECTS' || !Array.isArray(grant.issues)) continue;
        for (const id of grant.issues) if (batch.includes(Number(id))) visible.add(String(id));
      }
    } catch { /* A failed chunk grants nothing, while checked chunks remain useful. */ }
  }
  return { nodes: tree.nodes.filter(node => visible.has(String(node.id))) };
}

/**
 * A presentation boundary, never a mutation of authoritative restore/drift data.
 * Collect identities once, then perform batched viewer checks. Unknown logical
 * identities and incomplete checks fail closed. A root read is already proven
 * by each caller; no child inherits that permission. Baseline-only NODE_REMOVED
 * evidence may retain its historical identity, but never a current value.
 */
export async function viewerProjection({ issueId, issueKey, nodes = [], values = [] }, deps = {}) {
  const known = new Map();
  const keys = new Set();
  const logical = new Map();
  const addNode = node => {
    const id = numericId(node?.id ?? node?.currentIssueId ?? node?.issueId ?? node?.issue_id ?? node?.originalIssueId);
    if (!id) return;
    known.set(id, { id, key: node.key ?? node.issueKey ?? node.issue_key ?? known.get(id)?.key });
    logical.set(logicalNodeId(id), id);
    if (node.logicalNodeId) logical.set(String(node.logicalNodeId), id);
    if (node.originalIssueId) logical.set(logicalNodeId(node.originalIssueId), id);
  };
  nodes.forEach(addNode);
  addNode({ id: issueId, key: issueKey });
  const collect = value => {
    if (typeof value === 'string') {
      for (const key of value.match(ISSUE_KEY) ?? []) keys.add(key);
      for (const match of value.matchAll(ISSUE_ID_TEXT)) addNode({ id: match[1] });
      return;
    }
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    for (const [key, entry] of Object.entries(value)) {
      if (ID_FIELDS.has(key) && numericId(entry)) addNode({ id: entry });
      collect(key); collect(entry);
    }
  };
  collect(values);
  const keyIds = new Map([...known].filter(([, node]) => node.key).map(([id, node]) => [String(node.key), id]));
  if (issueKey) keyIds.set(String(issueKey), String(issueId));
  const unknownKeys = [...keys].filter(key => !keyIds.has(key));
  try {
    for (const node of await (deps.findViewableIssues ?? findViewableIssues)(unknownKeys)) {
      if (!unknownKeys.includes(node?.key) || !numericId(node?.id)) continue;
      addNode(node); keyIds.set(node.key, String(node.id));
    }
  } catch { /* Unknown identities remain invisible. */ }
  let visible = new Set();
  try {
    const filtered = await (deps.filterViewableTree ?? filterViewableTree)({ nodes: [...known.values()]
      .filter(node => node.id !== String(issueId)) });
    visible = new Set((filtered?.nodes ?? []).map(node => String(node.id)).filter(id => known.has(id)));
  } catch { /* A refused check discloses only the already-authorized root. */ }
  visible.add(String(issueId));
  const readable = value => visible.has(String(value));
  const textVisible = value => (value.match(ISSUE_KEY) ?? []).every(key => readable(keyIds.get(key)))
    && [...value.matchAll(ISSUE_ID_TEXT)].every(match => readable(match[1]));
  const sanitise = (value, historical = false) => {
    if (typeof value === 'string') return textVisible(value) && (!logical.has(value) || readable(logical.get(value))) ? value : OMIT;
    if (value == null || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return value.map(entry => sanitise(entry, historical)).filter(entry => entry !== OMIT);
    for (const [key, entry] of Object.entries(value)) {
      if (entry == null) continue;
      if (ID_FIELDS.has(key) && !readable(entry) && !historical) return OMIT;
      if (KEY_FIELDS.has(key) && !readable(keyIds.get(String(entry))) && !historical) return OMIT;
      if (LOGICAL_FIELDS.has(key) && !readable(logical.get(String(entry))) && !historical) return OMIT;
    }
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!textVisible(key) || (logical.has(key) && !readable(logical.get(key)))
        || (numericId(key) && !readable(key))) continue;
      // Historical evidence must not carry current/observed data or live errors.
      if (historical && ['actual', 'currentDigest', 'to', 'error', 'reason', 'newIssueId', 'newIssueKey', 'currentIssueId'].includes(key)) continue;
      const projected = historical && (ID_FIELDS.has(key) || KEY_FIELDS.has(key) || LOGICAL_FIELDS.has(key))
        ? entry : sanitise(entry, historical);
      if (projected !== OMIT) out[key] = projected;
    }
    return out;
  };
  return {
    visibleIssue: readable,
    project: value => { const result = sanitise(value); return result === OMIT ? null : result; },
    entry: value => {
      // Unidentified worker entries cannot be assumed to describe the root.
      if (!value || !Object.keys(value).some(key => ID_FIELDS.has(key) || KEY_FIELDS.has(key) || LOGICAL_FIELDS.has(key))) return null;
      const historical = value.kind === 'NODE_REMOVED' || value.nodeRemoved === true;
      const result = sanitise(value, historical);
      return result === OMIT ? null : result;
    }
  };
}

/** Worker errors are opaque and may name any descendant, even without a key. */
export const restoreErrorForViewer = error => error == null ? null : 'Restore could not be completed. Review the visible verification details.';

const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const ENTRY_FIELDS = ['logicalNodeId', 'issueId', 'issueKey', 'kind', 'fieldId', 'fieldName', 'expected', 'actual',
  'baselineDigest', 'currentDigest', 'materiality', 'detectedAt', 'reason', 'error', 'fields', 'from', 'to',
  'newIssueId', 'newIssueKey', 'originalIssueId', 'nodeRemoved'];

// Stored reasons may have been replaced by explainRefusals() with arbitrary
// Jira/worker error text. Only these literal, app-authored verifier explanations
// are display content; recognizing an issue identifier is not proof that an
// opaque error contains no private data. Keep this a closed display schema.
const VERIFICATION_GUIDANCE = new Set([
  'Jira accepted the restore but this tracked field does not hold its approved value. '
    + 'A screen configuration, a field validator or a workflow post-function may be overriding it.',
  'This work item is part of the approved hierarchy and is not present, so the restore cannot be confirmed.',
  'This work item is not part of the approved hierarchy and is still present.',
  'This work item is not in its approved place in the hierarchy.',
  'The hierarchy could not be read back, so nothing about this restore could be confirmed.',
  'The linked work items could not be checked, so this restore could not be confirmed.',
  'The work item is no longer in the baseline review status, so restoration cannot be confirmed.',
  'The work item could not be re-read, so this restore could not be confirmed. Nothing is known to have failed — but nothing is confirmed either.',
  'The work item could not be re-read, so no field could be confirmed.',
  'No approved digest was recorded for this field, so the restore cannot be confirmed.',
  'Jira accepted the write but the field does not match the approved value. A screen configuration or a workflow post-function may be overriding it.',
  'No approved digest was recorded for this tracked field, so it cannot be confirmed.',
  'Jira omitted this tracked field from the verification read, so its value cannot be confirmed.',
  'This tracked field does not match its approved value after the restore.',
  'This text shows a file that is no longer on the work item, so its image does not display.',
  'The rejected fields were put back and verified, but the next baseline could not be published, '
    + 'so the approved fields are not yet recorded. Retry the restore to publish it.'
]);

function restoreDisplayEntry(value) {
  if (Array.isArray(value)) return value.map(restoreDisplayEntry);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    key === 'error' && entry != null ? { detail: restoreErrorForViewer(entry) }
      : key === 'reason' && entry != null && !VERIFICATION_GUIDANCE.has(entry) ? restoreErrorForViewer(entry)
        : restoreDisplayEntry(entry)]));
}

/** Never spread a worker row: candidate digests and nested plans are not UI evidence. */
export function projectRestore(row, viewer) {
  const entries = list => (Array.isArray(list) ? list : []).map(entry => viewer.entry(restoreDisplayEntry(pick(entry, ENTRY_FIELDS)))).filter(Boolean);
  const detail = (Array.isArray(row.detail) ? row.detail : []).filter(value => value && typeof value === 'object').map(summary => ({
    unmatched: entries(summary.unmatched ?? summary.verification?.unmatched),
    refused: entries(summary.refused),
    replacements: entries(summary.replacements),
    verification: {
      ...pick(summary.verification, ['matches', 'statusMatches', 'progress']),
      changes: entries(summary.verification?.changes)
    }
  }));
  return {
    ...pick(row, ['restore_id', 'approval_id', 'issue_id', 'project_id', 'baseline_id', 'baseline_version',
      'actor_account_id', 'started_at', 'finished_at', 'attempted', 'succeeded', 'failed', 'skipped', 'irreversible',
      'state', 'job_id', 'queued_at', 'heartbeat_at', 'total_steps', 'completed_steps', 'last_checkpoint']),
    last_error: restoreErrorForViewer(row.last_error), detail
  };
}

export async function projectRestoreRows(rows, prepared, deps = {}) {
  const viewer = await viewerProjection({ issueId: prepared.issueId, issueKey: prepared.issue?.key,
    nodes: [...(prepared.baselineTree?.nodes ?? []), ...(prepared.tree?.nodes ?? [])], values: rows }, deps);
  return rows.map(row => projectRestore(row, viewer));
}
