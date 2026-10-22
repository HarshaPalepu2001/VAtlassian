import { executeQuery, limitClause } from '../lib/db.js';
import { tmFail } from './messages.js';
const hex = value => { const s = String(value ?? ''); if (!/^[a-f0-9]{32}$/.test(s)) tmFail('NOT_FOUND'); return s; };
const numeric = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) tmFail('INVALID_INPUT'); return n; };
const duplicate = error => (error?.code ?? error?.context?.debug?.code) === 'ER_DUP_ENTRY' || /duplicate entry/i.test(error?.message ?? '');
export const SOURCE_LINK_LEASE_MS = 180_000;
export const MAX_PENDING_SOURCE_LINK_INTENTS = 20;
const timestamp = value => { if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - SOURCE_LINK_LEASE_MS) tmFail('INVALID_INPUT'); return value; };
const changed = data => Number(data?.affectedRows ?? 0) === 1;
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { tmFail('CONTENT_CHANGED'); } };
const from = row => row ? { versionId: row.version_id, testIssueId: String(row.test_issue_id), projectId: String(row.project_id),
  versionNo: Number(row.version_no), digest: row.content_hash, typeId: row.type_id ?? null,
  desired: parse(row.desired_sources), previous: parse(row.prior_sources), previousVersionId: row.prior_version_id ?? null,
  previousDigest: row.prior_digest ?? null, state: row.state, problem: row.problem ?? null,
  proof: row.audit_seq == null ? null : { seq: Number(row.audit_seq), entryHash: row.audit_hash }, createdAt: Number(row.created_at) } : null;

export function createSourceLinkStore(query = executeQuery) {
  async function q(sql, params) {
    const r = await query(sql, params);
    if (!r?.result) throw Object.assign(new Error('Source link storage unavailable'), { reason: 'SERVICE_UNAVAILABLE', duplicate: duplicate(r?.error) });
    return r.data;
  }
  const rows = async (sql, params) => { const data = await q(sql, params); if (!Array.isArray(data)) tmFail('SERVICE_UNAVAILABLE'); return data; };
  async function insertSourceLinkIntent(row) {
    try {
      const result = await q(`INSERT INTO tm_source_link_outbox (version_id, test_issue_id, project_id, version_no, content_hash, type_id,
        desired_sources, prior_sources, prior_version_id, prior_digest, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`, [hex(row.versionId), numeric(row.testIssueId), numeric(row.projectId),
        row.versionNo, row.digest, row.typeId, JSON.stringify(row.desired), JSON.stringify(row.previous), row.previousVersionId,
        row.previousDigest, row.createdAt, row.createdAt]);
      return changed(result);
    } catch (error) { if (!error.duplicate) throw error; return false; }
  }
  const readSourceLinkIntent = async versionId => from((await rows('SELECT * FROM tm_source_link_outbox WHERE version_id = ?', [hex(versionId)]))[0]);
  const latestCommittedSourceLinks = async issueId => from((await rows(`SELECT * FROM tm_source_link_outbox
    WHERE test_issue_id = ? AND state = 'COMMITTED' ORDER BY version_no DESC LIMIT 1`, [numeric(issueId)]))[0]);
  async function latestSourceLinkIntent(issueId, { beforeVersionNo = null } = {}) {
    if (beforeVersionNo != null && (!Number.isSafeInteger(beforeVersionNo) || beforeVersionNo < 1)) tmFail('INVALID_INPUT');
    return from((await rows(`SELECT * FROM tm_source_link_outbox WHERE test_issue_id = ?${beforeVersionNo == null ? '' : ' AND version_no < ?'}
      ORDER BY version_no DESC LIMIT 1`, [numeric(issueId), ...(beforeVersionNo == null ? [] : [beforeVersionNo])]))[0]);
  }
  async function setSourceLinkIntentState(versionId, state, problem = null, proof = null) {
    if (!['PENDING', 'BLOCKED', 'COMMITTED', 'SUPERSEDED'].includes(state)) tmFail('INVALID_INPUT');
    if (state === 'COMMITTED' && (!Number.isSafeInteger(proof?.seq) || proof.seq < 1 || !/^[a-f0-9]{64}$/.test(proof?.entryHash ?? ''))) tmFail('LEDGER_UNAVAILABLE');
    if (state !== 'COMMITTED' && proof != null || state === 'COMMITTED' && problem != null) tmFail('INVALID_INPUT');
    if (problem != null && (typeof problem !== 'string' || problem.length > 64)) tmFail('INVALID_INPUT');
    return changed(await q(`UPDATE tm_source_link_outbox SET state = ?, problem = ?, audit_seq = ?, audit_hash = ?, updated_at = ?
      WHERE version_id = ? AND state IN ('PENDING', 'BLOCKED')`,
    [state, problem, proof?.seq ?? null, proof?.entryHash ?? null, Date.now(), hex(versionId)]));
  }
  async function claimSourceLinkLease(issueId, token, now) {
    timestamp(now);
    try { return changed(await q('INSERT INTO tm_source_link_lease (test_issue_id, token, expires_at) VALUES (?, ?, ?)', [numeric(issueId), hex(token), now + SOURCE_LINK_LEASE_MS])); }
    catch (error) { if (!error.duplicate) throw error; }
    const r = await q('UPDATE tm_source_link_lease SET token = ?, expires_at = ? WHERE test_issue_id = ? AND expires_at <= ?',
      [hex(token), now + SOURCE_LINK_LEASE_MS, numeric(issueId), now]);
    return changed(r);
  }
  const ownsSourceLinkLease = async (issueId, token, now) => (await rows('SELECT token FROM tm_source_link_lease WHERE test_issue_id = ? AND token = ? AND expires_at > ?', [numeric(issueId), hex(token), timestamp(now)])).length === 1;
  const releaseSourceLinkLease = (issueId, token) => q('DELETE FROM tm_source_link_lease WHERE test_issue_id = ? AND token = ?', [numeric(issueId), hex(token)]);
  const pendingSourceLinkIntents = async (limit = MAX_PENDING_SOURCE_LINK_INTENTS) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING_SOURCE_LINK_INTENTS) tmFail('INVALID_INPUT');
    return (await rows(`SELECT version_id FROM tm_source_link_outbox WHERE state IN ('PENDING', 'BLOCKED') ORDER BY updated_at, version_id LIMIT ${limitClause(limit)}`, [])).map(row => hex(row.version_id));
  };
  return { insertSourceLinkIntent, readSourceLinkIntent, latestCommittedSourceLinks, setSourceLinkIntentState,
    latestSourceLinkIntent, claimSourceLinkLease, ownsSourceLinkLease, releaseSourceLinkLease, pendingSourceLinkIntents };
}
const store = createSourceLinkStore();
export const { insertSourceLinkIntent, readSourceLinkIntent, latestCommittedSourceLinks, setSourceLinkIntentState,
  latestSourceLinkIntent, claimSourceLinkLease, ownsSourceLinkLease, releaseSourceLinkLease, pendingSourceLinkIntents } = store;
