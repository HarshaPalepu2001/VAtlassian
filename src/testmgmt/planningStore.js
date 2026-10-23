import { executeQuery } from '../lib/db.js';
import { tmFail } from './messages.js';

const id = value => { const out = String(value ?? ''); if (!/^[0-9a-f]{32}$/.test(out)) tmFail('NOT_FOUND'); return out; };
const issueId = value => { const out = Number(value); if (!Number.isSafeInteger(out) || out <= 0) tmFail('INVALID_INPUT'); return out; };
const parse = value => { try { const out = JSON.parse(value); if (!out || typeof out !== 'object') tmFail('RECORDS_INCOMPLETE'); return out; } catch { tmFail('RECORDS_INCOMPLETE'); } };
const duplicate = error => error?.code === 'ER_DUP_ENTRY' || error?.context?.debug?.code === 'ER_DUP_ENTRY' || /duplicate entry/i.test(error?.message ?? '');
const changes = result => Number(result?.data?.affectedRows ?? 0);
// Unreadable is null, never an empty list: authorship then falls back to the last editor.
const editorsFrom = value => { if (value == null) return null; try { const out = JSON.parse(value); return Array.isArray(out) ? out : null; } catch { return null; } };

/** SQL boundary is injected so failures and compare-and-swap outcomes are testable without Forge. */
export function createPlanningStore(query = executeQuery) {
  async function q(sql, params) {
    const result = await query(sql, params);
    if (!result?.result) {
      if (duplicate(result?.error)) throw Object.assign(new Error('duplicate'), { duplicate: true });
      tmFail('SERVICE_UNAVAILABLE');
    }
    return result;
  }
  const rows = async (sql, params) => {
    const result = await q(sql, params);
    if (!Array.isArray(result.data)) tmFail('RECORDS_INCOMPLETE');
    return result.data;
  };
  const draftFrom = row => row ? { issueId: String(row.issue_id), projectId: String(row.project_id), role: row.role,
    content: parse(row.content), revision: Number(row.revision), updatedAt: Number(row.updated_at), updatedBy: row.updated_by,
    editors: editorsFrom(row.editors) } : null;
  const revisionFrom = row => row ? { revisionId: String(row.revision_id), issueId: String(row.issue_id), projectId: String(row.project_id), role: row.role,
    revisionNo: Number(row.revision_no), draftRevision: Number(row.draft_revision), content: parse(row.content), digest: row.digest,
    chain: parse(row.chain), chainDigest: row.chain_digest, state: row.state, publishedBy: row.published_by,
    publishedAt: Number(row.published_at), signedAt: row.signed_at == null ? null : Number(row.signed_at),
    authors: row.authors == null ? null : parse(row.authors) } : null;
  async function readCollectionDraft(key) {
    return draftFrom((await rows('SELECT * FROM tm_collection_draft WHERE issue_id = ?', [issueId(key)]))[0]);
  }
  async function saveCollectionDraft({ issueId: key, projectId, role, content, expectedRevision, now, actor, editors }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) tmFail('INVALID_INPUT');
    if (expectedRevision === 0) {
      try {
        await q(`INSERT INTO tm_collection_draft (issue_id, project_id, role, content, revision, updated_at, updated_by, editors)
          VALUES (?, ?, ?, ?, 1, ?, ?, ?)`, [issueId(key), issueId(projectId), role, JSON.stringify(content), now, actor, JSON.stringify(editors ?? [])]);
        return 1;
      } catch (error) { if (error.duplicate) return null; throw error; }
    }
    const result = await q(`UPDATE tm_collection_draft SET content = ?, revision = revision + 1, updated_at = ?, updated_by = ?, editors = ?
      WHERE issue_id = ? AND project_id = ? AND role = ? AND revision = ?`,
    [JSON.stringify(content), now, actor, JSON.stringify(editors ?? []), issueId(key), issueId(projectId), role, expectedRevision]);
    return changes(result) === 1 ? expectedRevision + 1 : null;
  }
  async function listCollectionRevisions(key) {
    const all = await rows('SELECT * FROM tm_collection_revision WHERE issue_id = ? ORDER BY revision_no DESC LIMIT 101', [issueId(key)]);
    return { items: all.slice(0, 100).map(revisionFrom), complete: all.length <= 100 };
  }
  async function readCollectionRevision(key) {
    return revisionFrom((await rows('SELECT * FROM tm_collection_revision WHERE revision_id = ?', [id(key)]))[0]);
  }
  async function insertCollectionRevision(r) {
    try {
      const result = await q(`INSERT INTO tm_collection_revision (revision_id, issue_id, project_id, role, revision_no,
        draft_revision, content, digest, chain, chain_digest, state, published_by, published_at, authors)
        SELECT ?, issue_id, project_id, role, ?, revision, ?, ?, ?, ?, 'PUBLISHING', ?, ?, ?
        FROM tm_collection_draft WHERE issue_id = ? AND project_id = ? AND role = ? AND revision = ?`,
      [id(r.revisionId), r.revisionNo, JSON.stringify(r.content), r.digest, JSON.stringify(r.chain), r.chainDigest, r.publishedBy,
        r.publishedAt, JSON.stringify(r.authors), issueId(r.issueId), issueId(r.projectId), r.role, r.draftRevision]);
      return changes(result) === 1;
    } catch (error) { if (error.duplicate) return false; throw error; }
  }
  async function setCollectionRevisionState(key, { from, to, now }) {
    if (!({ PUBLISHING: ['PUBLISHED'], PUBLISHED: ['SIGNED', 'REJECTED'] }[from] ?? []).includes(to)) tmFail('INVALID_INPUT');
    const result = await q(`UPDATE tm_collection_revision SET state = ?, signed_at = ? WHERE revision_id = ? AND state = ?`,
      [to, to === 'SIGNED' ? now : null, id(key), from]);
    return changes(result) === 1;
  }
  return { readCollectionDraft, saveCollectionDraft, listCollectionRevisions, readCollectionRevision, insertCollectionRevision, setCollectionRevisionState };
}
const store = createPlanningStore();
export const { readCollectionDraft, saveCollectionDraft, listCollectionRevisions, readCollectionRevision, insertCollectionRevision, setCollectionRevisionState } = store;
