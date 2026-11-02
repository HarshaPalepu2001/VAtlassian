import { contentDigest } from './content.js';
import { validIntakeId } from './intake.js';
import { tmFail } from './messages.js';

export const INTAKE_MIGRATIONS = [
  { id: 'v169_tm_attempt_clock', sql: `CREATE TABLE IF NOT EXISTS tm_attempt_clock (
    clock_id INT NOT NULL PRIMARY KEY, last_sequence BIGINT NOT NULL, legacy_cutoff BIGINT NOT NULL)` },
  { id: 'v170_tm_run_attempt', sql: `CREATE TABLE IF NOT EXISTS tm_run_attempt (
    attempt_sequence BIGINT NOT NULL PRIMARY KEY, run_id CHAR(32) NOT NULL,
    UNIQUE KEY uq_tm_run_attempt (run_id))` },
  { id: 'v171_tm_run_attempt_sequence', sql: 'ALTER TABLE tm_run ADD COLUMN IF NOT EXISTS attempt_sequence BIGINT NULL' },
  { id: 'v172_tm_run_evidence_schema', sql: 'ALTER TABLE tm_run ADD COLUMN IF NOT EXISTS evidence_schema INT NULL' },
  { id: 'v173_tm_run_classification', sql: 'ALTER TABLE tm_run ADD COLUMN IF NOT EXISTS classification TEXT NULL' },
  { id: 'v174_tm_run_reported_build', sql: 'ALTER TABLE tm_run ADD COLUMN IF NOT EXISTS reported_build TEXT NULL' },
  { id: 'v175_tm_run_provenance', sql: 'ALTER TABLE tm_run ADD COLUMN IF NOT EXISTS provenance TEXT NULL' },
  { id: 'v176_tm_run_intake_receipt', sql: 'ALTER TABLE tm_run ADD COLUMN IF NOT EXISTS intake_receipt_id CHAR(32) NULL' },
  { id: 'v177_tm_run_intake_applied', sql: 'ALTER TABLE tm_run ADD COLUMN IF NOT EXISTS intake_applied TINYINT NULL' },
  { id: 'v178_tm_intake_token', sql: `CREATE TABLE IF NOT EXISTS tm_intake_token (
    token_id CHAR(32) PRIMARY KEY, installation_id VARCHAR(255) NOT NULL, project_id BIGINT NOT NULL,
    label VARCHAR(100) NOT NULL, secret_hash CHAR(64) NOT NULL, expires_at BIGINT NOT NULL, revoked_at BIGINT NULL,
    created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL, KEY idx_tm_intake_token_project (project_id, created_at))` },
  { id: 'v179_tm_intake_grant', sql: `CREATE TABLE IF NOT EXISTS tm_intake_grant (
    grant_id CHAR(32) PRIMARY KEY, installation_id VARCHAR(255) NOT NULL, project_id BIGINT NOT NULL,
    token_id CHAR(32) NOT NULL, execution_issue_id BIGINT NOT NULL, run_ids TEXT NOT NULL,
    expires_at BIGINT NOT NULL, revoked_at BIGINT NULL, created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL,
    KEY idx_tm_intake_grant_execution (execution_issue_id, created_at))` },
  { id: 'v180_tm_intake_receipt', sql: `CREATE TABLE IF NOT EXISTS tm_intake_receipt (
    receipt_id CHAR(32) PRIMARY KEY, installation_id VARCHAR(255) NOT NULL, project_id BIGINT NOT NULL,
    execution_issue_id BIGINT NOT NULL, token_id CHAR(32) NOT NULL, grant_id CHAR(32) NOT NULL,
    idempotency_hash CHAR(64) NOT NULL, payload_digest CHAR(64) NOT NULL, original_payload MEDIUMTEXT NOT NULL,
    reported_build TEXT NOT NULL, provenance TEXT NOT NULL, mappings TEXT NOT NULL, progress TEXT NOT NULL,
    received_at BIGINT NOT NULL, status VARCHAR(20) NOT NULL, audit_event_id CHAR(32) NOT NULL,
    audit_seq BIGINT NULL, audit_hash CHAR(64) NULL, open_execution_id BIGINT NULL,
    UNIQUE KEY uq_tm_intake_idempotency (idempotency_hash), UNIQUE KEY uq_tm_intake_open_execution (open_execution_id), KEY idx_tm_intake_receipt_execution (execution_issue_id, received_at))` }
];

const id = value => { if (!validIntakeId(value)) tmFail('INVALID_INPUT'); return value; };
const issueId = value => { if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) tmFail('INVALID_INPUT'); return Number(value); };
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : JSON.parse(JSON.stringify(value)); } catch { tmFail('RECORDS_INCOMPLETE'); } };
const number = value => { const out = Number(value); if (!Number.isSafeInteger(out) || out < 1) tmFail('RECORDS_INCOMPLETE'); return out; };
const duplicate = error => error?.code === 'ER_DUP_ENTRY' || error?.context?.debug?.code === 'ER_DUP_ENTRY' || /duplicate entry/i.test(error?.message ?? '');
const defaultQuery = async (sql, params) => (await import('../lib/db.js')).executeQuery(sql, params);
const tokenFrom = row => row ? ({ tokenId: row.token_id, installationId: row.installation_id, projectId: String(row.project_id),
  label: row.label, secretHash: row.secret_hash, expiresAt: Number(row.expires_at), revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
  createdBy: row.created_by, createdAt: Number(row.created_at) }) : null;
const grantFrom = row => row ? ({ grantId: row.grant_id, installationId: row.installation_id, projectId: String(row.project_id), tokenId: row.token_id,
  executionIssueId: String(row.execution_issue_id), runIds: parse(row.run_ids), expiresAt: Number(row.expires_at),
  revokedAt: row.revoked_at == null ? null : Number(row.revoked_at), createdBy: row.created_by, createdAt: Number(row.created_at) }) : null;
function receiptFrom(row) {
  if (!row) return null;
  const mappings = parse(row.mappings), progress = parse(row.progress);
  if (!Array.isArray(mappings) || !mappings.length || !Array.isArray(progress)) tmFail('RECORDS_INCOMPLETE');
  return { receiptId: row.receipt_id, installationId: row.installation_id, projectId: String(row.project_id), executionIssueId: String(row.execution_issue_id),
    tokenId: row.token_id, grantId: row.grant_id, idempotencyHash: row.idempotency_hash, payloadDigest: row.payload_digest,
    originalPayload: row.original_payload, reportedBuild: parse(row.reported_build), provenance: parse(row.provenance), mappings, progress,
    receivedAt: Number(row.received_at), status: row.status, auditEventId: row.audit_event_id,
    auditProof: row.audit_seq == null ? null : { seq: number(row.audit_seq), entryHash: row.audit_hash } };
}

// Embed authority in each run write: revocation between the worker's read and
// SQL submission must still stop the write. Installation/project/execution are
// tied to the receipt and grant rather than to an untrusted job body.
const authoritySql = `EXISTS (SELECT 1 FROM tm_intake_receipt ir
  JOIN tm_intake_token it ON it.token_id = ir.token_id
  JOIN tm_intake_grant ig ON ig.grant_id = ir.grant_id AND ig.token_id = it.token_id
  WHERE ir.receipt_id = ? AND ir.status = 'QUEUED'
  AND it.installation_id = ir.installation_id AND ig.installation_id = ir.installation_id
  AND it.project_id = ir.project_id AND ig.project_id = ir.project_id AND ig.execution_issue_id = ir.execution_issue_id
  AND it.revoked_at IS NULL AND ig.revoked_at IS NULL AND it.expires_at > ? AND ig.expires_at > ?)`;

export function createIntakeStore({ query = defaultQuery } = {}) {
  async function q(sql, params = []) {
    const out = await query(sql, params);
    if (!out?.result) { if (duplicate(out?.error)) throw Object.assign(new Error('Duplicate intake record'), { duplicate: true }); tmFail('SERVICE_UNAVAILABLE'); }
    return out;
  }
  const rows = async (sql, params) => { const out = (await q(sql, params)).data; if (!Array.isArray(out)) tmFail('RECORDS_INCOMPLETE'); return out; };
  const changed = out => Number(out?.data?.affectedRows) === 1;
  async function insert(sql, params) { try { return changed(await q(sql, params)); } catch (error) { if (error.duplicate || duplicate(error)) return false; throw error; } }
  const bounded = (records, convert) => { if (records.length > 100) tmFail('RECORDS_INCOMPLETE'); return records.map(convert); };
  const readIntakeToken = async tokenId => tokenFrom((await rows('SELECT * FROM tm_intake_token WHERE token_id = ?', [id(tokenId)]))[0]);
  const readIntakeGrant = async grantId => grantFrom((await rows('SELECT * FROM tm_intake_grant WHERE grant_id = ?', [id(grantId)]))[0]);
  const readIntakeReceipt = async receiptId => receiptFrom((await rows('SELECT * FROM tm_intake_receipt WHERE receipt_id = ?', [id(receiptId)]))[0]);
  const findIntakeReceipt = async hash => { if (!/^[a-f0-9]{64}$/.test(hash)) tmFail('INVALID_INPUT'); return receiptFrom((await rows('SELECT * FROM tm_intake_receipt WHERE idempotency_hash = ?', [hash]))[0]); };
  const listIntakeTokens = async projectId => bounded(await rows('SELECT * FROM tm_intake_token WHERE project_id = ? ORDER BY created_at DESC LIMIT 101', [issueId(projectId)]), tokenFrom);
  const listIntakeGrants = async executionId => bounded(await rows('SELECT * FROM tm_intake_grant WHERE execution_issue_id = ? ORDER BY created_at DESC LIMIT 101', [issueId(executionId)]), grantFrom);
  const listIntakeReceipts = async executionId => bounded(await rows('SELECT * FROM tm_intake_receipt WHERE execution_issue_id = ? ORDER BY received_at DESC LIMIT 101', [issueId(executionId)]), receiptFrom);
  const readIntakeForRun = async runId => bounded(await rows(`SELECT * FROM tm_intake_receipt WHERE JSON_CONTAINS(mappings, JSON_OBJECT('runId', ?)) ORDER BY received_at DESC LIMIT 101`, [id(runId)]), receiptFrom);
  const insertIntakeToken = token => insert(`INSERT INTO tm_intake_token (token_id, installation_id, project_id, label, secret_hash, expires_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id(token.tokenId), token.installationId, issueId(token.projectId), token.label, token.secretHash, token.expiresAt, token.createdBy, token.createdAt]);
  const insertIntakeGrant = grant => insert(`INSERT INTO tm_intake_grant (grant_id, installation_id, project_id, token_id, execution_issue_id, run_ids, expires_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id(grant.grantId), grant.installationId, issueId(grant.projectId), id(grant.tokenId), issueId(grant.executionIssueId), JSON.stringify(grant.runIds), grant.expiresAt, grant.createdBy, grant.createdAt]);
  const revokeIntakeToken = (tokenId, now) => q('UPDATE tm_intake_token SET revoked_at = COALESCE(revoked_at, ?) WHERE token_id = ?', [now, id(tokenId)]);
  const revokeIntakeGrant = (grantId, now) => q('UPDATE tm_intake_grant SET revoked_at = COALESCE(revoked_at, ?) WHERE grant_id = ?', [now, id(grantId)]);
  const insertIntakeReceipt = record => insert(`INSERT INTO tm_intake_receipt
    (receipt_id, installation_id, project_id, execution_issue_id, token_id, grant_id, idempotency_hash, payload_digest,
     original_payload, reported_build, provenance, mappings, progress, received_at, status, audit_event_id, open_execution_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'QUEUED', ?, ?)`,
  [id(record.receiptId), record.installationId, issueId(record.projectId), issueId(record.executionIssueId), id(record.tokenId), id(record.grantId), record.idempotencyHash, record.payloadDigest,
    record.originalPayload, JSON.stringify(record.reportedBuild), JSON.stringify(record.provenance), JSON.stringify(record.mappings), record.receivedAt, id(record.auditEventId), issueId(record.executionIssueId)]);
  async function reserveIntakeRun({ runId, receiptId, expectedRevision, now = Date.now() }) {
    const out = await q(`UPDATE tm_run SET intake_receipt_id = ? WHERE run_id = ? AND revision = ? AND state = 'IN_PROGRESS'
      AND evidence_schema = 2 AND step_event_id IS NULL AND intake_receipt_id IS NULL AND ${authoritySql}`,
    [id(receiptId), id(runId), expectedRevision, id(receiptId), now, now]);
    if (changed(out)) return true;
    const row = (await rows('SELECT intake_receipt_id FROM tm_run WHERE run_id = ?', [id(runId)]))[0];
    return row?.intake_receipt_id === receiptId;
  }
  async function applyIntakeRun({ runId, receiptId, expectedRevision, steps, result, reportedBuild, provenance, now }) {
    const out = await q(`UPDATE tm_run SET steps = ?, result = ?, reported_build = ?, provenance = ?, intake_applied = 1,
      revision = revision + 1, updated_at = ? WHERE run_id = ? AND revision = ? AND state = 'IN_PROGRESS'
      AND step_event_id IS NULL AND intake_receipt_id = ? AND COALESCE(intake_applied, 0) = 0 AND ${authoritySql}`,
    [JSON.stringify(steps), result, JSON.stringify(reportedBuild), JSON.stringify(provenance), now, id(runId), expectedRevision, id(receiptId), id(receiptId), now, now]);
    if (changed(out)) return true;
    const row = (await rows('SELECT intake_receipt_id, intake_applied FROM tm_run WHERE run_id = ?', [id(runId)]))[0];
    return row?.intake_receipt_id === receiptId && Number(row.intake_applied) === 1;
  }
  async function markIntakeProgress(receiptId, runId, now = Date.now()) {
    await q(`UPDATE tm_intake_receipt SET progress = JSON_ARRAY_APPEND(progress, '$', ?) WHERE receipt_id = ? AND status = 'QUEUED'
      AND NOT JSON_CONTAINS(progress, JSON_QUOTE(?)) AND EXISTS (SELECT 1 FROM tm_run r WHERE r.run_id = ?
        AND r.intake_receipt_id = tm_intake_receipt.receipt_id AND r.intake_applied = 1)
      AND EXISTS (SELECT 1 FROM tm_intake_token it JOIN tm_intake_grant ig ON ig.token_id = it.token_id
        WHERE it.token_id = tm_intake_receipt.token_id AND ig.grant_id = tm_intake_receipt.grant_id
        AND it.revoked_at IS NULL AND ig.revoked_at IS NULL AND it.expires_at > ? AND ig.expires_at > ?)`,
    [id(runId), id(receiptId), id(runId), id(runId), now, now]);
  }
  async function confirmIntakeAudit(record) {
    const row = (await rows(`SELECT seq, entry_hash, payload, actor_account_id, issue_id FROM va_audit
      WHERE event_id = FROM_BASE64(?) AND event_type = 'TM_INTAKE_APPLIED'`, [Buffer.from(id(record.auditEventId), 'hex').toString('base64')]))[0];
    if (!row) return null;
    const payload = parse(row.payload), expected = { receiptId: record.receiptId, payloadDigest: record.payloadDigest, tokenId: record.tokenId,
      grantId: record.grantId, executionIssueId: record.executionIssueId, mappings: record.mappings, reportedBuild: record.reportedBuild };
    if (row.actor_account_id !== `ci:${record.tokenId}` || String(row.issue_id) !== record.executionIssueId
      || contentDigest(payload) !== contentDigest(expected) || !/^[a-f0-9]{64}$/.test(row.entry_hash)) tmFail('INTAKE_RECORD_INVALID');
    return { seq: number(row.seq), entryHash: row.entry_hash };
  }
  async function completeIntakeReceipt(receiptId, proof, now = Date.now()) {
    if (!Number.isSafeInteger(proof?.seq) || proof.seq < 1 || !/^[a-f0-9]{64}$/.test(proof?.entryHash ?? '')) tmFail('LEDGER_UNAVAILABLE');
    return changed(await q(`UPDATE tm_intake_receipt SET status = 'APPLIED', audit_seq = ?, audit_hash = ?, open_execution_id = NULL
      WHERE receipt_id = ? AND status = 'QUEUED' AND JSON_LENGTH(progress) = JSON_LENGTH(mappings)
      AND NOT EXISTS (SELECT 1 FROM tm_run r WHERE r.intake_receipt_id = tm_intake_receipt.receipt_id AND COALESCE(r.intake_applied, 0) <> 1)
      AND (SELECT COUNT(*) FROM tm_run r WHERE r.intake_receipt_id = tm_intake_receipt.receipt_id) = JSON_LENGTH(mappings)
      AND EXISTS (SELECT 1 FROM tm_intake_token it JOIN tm_intake_grant ig ON ig.token_id = it.token_id
        WHERE it.token_id = tm_intake_receipt.token_id AND ig.grant_id = tm_intake_receipt.grant_id
        AND it.revoked_at IS NULL AND ig.revoked_at IS NULL AND it.expires_at > ? AND ig.expires_at > ?)`,
    [proof.seq, proof.entryHash, id(receiptId), now, now]));
  }
  return { readIntakeToken, readIntakeGrant, readIntakeReceipt, findIntakeReceipt, listIntakeTokens, listIntakeGrants, listIntakeReceipts, readIntakeForRun,
    insertIntakeToken, insertIntakeGrant, revokeIntakeToken, revokeIntakeGrant, insertIntakeReceipt, reserveIntakeRun, applyIntakeRun,
    markIntakeProgress, confirmIntakeAudit, completeIntakeReceipt };
}
