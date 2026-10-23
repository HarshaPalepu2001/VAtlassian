import { executeQuery } from '../lib/db.js';
import { FailClosed } from '../lib/errors.js';
import { terminalProofProblem } from './proof.js';

// The same test as db/store.js#isDuplicateKey, kept local: tests replace that
// module wholesale, and this one must not depend on what they stub.
function isDuplicateKey(err) {
  const code = err?.code === 'ER_DUP_ENTRY' ? err.code : err?.context?.debug?.code;
  return code === 'ER_DUP_ENTRY' || /duplicate entry/i.test(err?.message ?? '');
}

/**
 * Test-management SQL. Every read that fails throws: a test record that could
 * not be read is never treated as absent.
 */

async function q(sql, params = []) {
  const result = await executeQuery(sql, params);
  if (!result.result) {
    const error = new FailClosed('SERVICE_UNAVAILABLE');
    error.cause = result.error;
    error.duplicate = isDuplicateKey(result.error);
    throw error;
  }
  return result;
}
const rows = async (sql, params) => (await q(sql, params)).data ?? [];
const affected = (result) => Number(result?.data?.affectedRows ?? 0);
const json = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
// Test-management ids are 32 lowercase hex characters, stored as text: Forge
// SQL cannot bind a Buffer (lib/db.js), and these ids are never secrets.
const hex = (value) => (value == null ? null : String(value));
const bin = (id) => {
  const value = String(id ?? '');
  if (!/^[0-9a-f]{32}$/.test(value)) throw new FailClosed('NOT_FOUND');
  return value;
};

// ── project ───────────────────────────────────────────────────────────────
function projectFrom(row) {
  if (!row) return null;
  return {
    projectId: String(row.project_id), enabled: Number(row.enabled) === 1,
    testTypeId: String(row.test_type_id), executionTypeId: String(row.execution_type_id),
    planTypeId: row.plan_type_id == null ? null : String(row.plan_type_id),
    setTypeId: row.set_type_id == null ? null : String(row.set_type_id),
    preconditionTypeId: row.precondition_type_id == null ? null : String(row.precondition_type_id),
    defectTypeId: String(row.defect_type_id), linkTypeName: row.link_type_name,
    sourceLinkTypeId: row.source_link_type_id == null ? null : String(row.source_link_type_id),
    runChain: json(row.run_chain, null), versionChain: json(row.version_chain, null),
    revision: Number(row.revision), updatedAt: Number(row.updated_at), updatedBy: row.updated_by
  };
}

export async function readProject(projectId) {
  return projectFrom((await rows('SELECT * FROM tm_project WHERE project_id = ?', [Number(projectId)]))[0]);
}

export async function listProjects() {
  return (await rows('SELECT * FROM tm_project ORDER BY project_id', [])).map(projectFrom);
}

/** Insert or update with an expected revision; false when someone else saved first. */
export async function saveProject(p, { expectedRevision, now, actor }) {
  const values = [p.enabled ? 1 : 0, p.testTypeId, p.executionTypeId, p.planTypeId ?? null, p.setTypeId ?? null, p.preconditionTypeId ?? null, p.defectTypeId,
    p.linkTypeName, p.sourceLinkTypeId ?? null, JSON.stringify(p.runChain), JSON.stringify(p.versionChain), now, actor];
  if (!expectedRevision) {
    try {
      await q(`INSERT INTO tm_project (enabled, test_type_id, execution_type_id, plan_type_id, set_type_id, precondition_type_id, defect_type_id,
        link_type_name, source_link_type_id, run_chain, version_chain, updated_at, updated_by, project_id, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, [...values, Number(p.projectId)]);
      return true;
    } catch (error) { if (error.duplicate) return false; throw error; }
  }
  const result = await q(`UPDATE tm_project SET enabled = ?, test_type_id = ?, execution_type_id = ?, plan_type_id = ?, set_type_id = ?, precondition_type_id = ?,
    defect_type_id = ?, link_type_name = ?, source_link_type_id = ?, run_chain = ?, version_chain = ?, updated_at = ?, updated_by = ?,
    revision = revision + 1 WHERE project_id = ? AND revision = ?`, [...values, Number(p.projectId), Number(expectedRevision)]);
  return affected(result) === 1;
}

// ── drafts ────────────────────────────────────────────────────────────────
export async function readDraft(testIssueId) {
  const row = (await rows('SELECT * FROM tm_test_draft WHERE test_issue_id = ?', [Number(testIssueId)]))[0];
  return row ? { content: json(row.content, null), revision: Number(row.revision), updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by, editors: row.editors == null ? null : json(row.editors, []) } : null;
}

/** `editors` is the whole list after this save (testmgmt/authorship.js#withEditor). */
export async function saveDraft({ testIssueId, projectId, content, expectedRevision, now, actor, editors }) {
  if (!expectedRevision) {
    try {
      await q(`INSERT INTO tm_test_draft (test_issue_id, project_id, content, revision, updated_at, updated_by, editors)
        VALUES (?, ?, ?, 1, ?, ?, ?)`, [Number(testIssueId), Number(projectId), JSON.stringify(content), now, actor, JSON.stringify(editors ?? [])]);
      return 1;
    } catch (error) { if (error.duplicate) return null; throw error; }
  }
  const result = await q(`UPDATE tm_test_draft SET content = ?, revision = revision + 1, updated_at = ?, updated_by = ?, editors = ?
    WHERE test_issue_id = ? AND revision = ?`, [JSON.stringify(content), now, actor, JSON.stringify(editors ?? []), Number(testIssueId), Number(expectedRevision)]);
  return affected(result) === 1 ? Number(expectedRevision) + 1 : null;
}

// ── versions ──────────────────────────────────────────────────────────────
function versionFrom(row) {
  if (!row) return null;
  return {
    versionId: hex(row.version_id), testIssueId: String(row.test_issue_id), projectId: String(row.project_id),
    versionNo: Number(row.version_no), content: json(row.content, null), digest: row.digest,
    chain: json(row.chain, null), chainDigest: row.chain_digest, state: row.state,
    publishedBy: row.published_by, publishedAt: Number(row.published_at),
    signedAt: row.signed_at == null ? null : Number(row.signed_at), publishEventId: row.publish_event_id ?? null,
    authors: row.authors == null ? null : json(row.authors, null)
  };
}

export async function listVersions(testIssueId) {
  return (await rows('SELECT * FROM tm_test_version WHERE test_issue_id = ? ORDER BY version_no DESC LIMIT 100',
    [Number(testIssueId)])).map(versionFrom);
}

export async function readVersion(versionId) {
  return versionFrom((await rows('SELECT * FROM tm_test_version WHERE version_id = ?', [bin(versionId)]))[0]);
}

/** The version number is unique per test, so two concurrent publishes cannot both win. */
export async function insertVersion(v) {
  try {
    await q(`INSERT INTO tm_test_version (version_id, test_issue_id, project_id, version_no, content, digest, chain,
      chain_digest, state, published_by, published_at, publish_event_id, authors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHING', ?, ?, ?, ?)`,
    [bin(v.versionId), Number(v.testIssueId), Number(v.projectId), Number(v.versionNo), JSON.stringify(v.content),
      v.digest, JSON.stringify(v.chain), v.chainDigest, v.publishedBy, v.publishedAt, v.publishEventId, JSON.stringify(v.authors)]);
    return true;
  } catch (error) { if (error.duplicate) return false; throw error; }
}

export async function activateVersionPublication(versionId) {
  const version = await readVersion(versionId);
  if (!version || version.state !== 'PUBLISHING') return false;
  const event = (await rows(`SELECT payload, actor_account_id, issue_id FROM va_audit
    WHERE event_id = FROM_BASE64(?) AND event_type = 'TM_VERSION_PUBLISHED'`, [Buffer.from(version.publishEventId, 'hex').toString('base64')]))[0];
  const payload = json(event?.payload, null);
  if (!event || payload?.versionId !== versionId || payload.digest !== version.digest || payload.chainDigest !== version.chainDigest
    || event.actor_account_id !== version.publishedBy || String(event.issue_id) !== version.testIssueId) throw new FailClosed('PUBLICATION_PENDING');
  return setVersionState(versionId, { from: 'PUBLISHING', to: 'PUBLISHED', now: Date.now() });
}

export async function setVersionState(versionId, { from, to, now }) {
  const result = await q(`UPDATE tm_test_version SET state = ?, signed_at = ? WHERE version_id = ? AND state = ?`,
    [to, to === 'SIGNED' ? now : null, bin(versionId), from]);
  return affected(result) === 1;
}

// ── runs ──────────────────────────────────────────────────────────────────
function runFrom(row) {
  if (!row) return null;
  return {
    runId: hex(row.run_id), executionIssueId: String(row.execution_issue_id), projectId: String(row.project_id),
    testIssueId: String(row.test_issue_id), testVersionId: hex(row.test_version_id), testDigest: row.test_digest,
    environment: row.environment, configuration: row.configuration,
    release: row.release_id == null ? null : { id: String(row.release_id), name: row.release_name },
    chain: json(row.chain, null), chainDigest: row.chain_digest, state: row.state, result: row.result,
    steps: json(row.steps, []), revision: Number(row.revision), frozenDigest: row.frozen_digest ?? null,
    retestOf: hex(row.retest_of), createdBy: row.created_by, createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    resolvedSteps: json(row.resolved_steps, null), iterations: json(row.iterations, null), planningSnapshot: json(row.planning_snapshot, null),
    creationKey: row.creation_key ?? null, creationFingerprint: row.creation_fingerprint ?? null, creationEventId: row.creation_event_id ?? null,
    stepEventId: row.step_event_id ?? null, stepPrior: row.step_prior == null ? null : json(row.step_prior, null)
  };
}

export async function insertRun(r) {
  try { await q(`INSERT INTO tm_run (run_id, execution_issue_id, project_id, test_issue_id, test_version_id, test_digest,
    environment, configuration, release_id, release_name, chain, chain_digest, state, result, steps, revision,
    retest_of, created_by, created_at, updated_at, resolved_steps, iterations, planning_snapshot, creation_key, creation_fingerprint, creation_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATING', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [bin(r.runId), Number(r.executionIssueId), Number(r.projectId), Number(r.testIssueId), bin(r.testVersionId),
    r.testDigest, r.environment, r.configuration, r.release?.id ?? null, r.release?.name ?? null,
    JSON.stringify(r.chain), r.chainDigest, r.result, JSON.stringify(r.steps), r.retestOf ? bin(r.retestOf) : null,
    r.createdBy, r.createdAt, r.createdAt, JSON.stringify(r.resolvedSteps ?? null), JSON.stringify(r.iterations ?? null), JSON.stringify(r.planningSnapshot ?? null),
    r.creationKey ?? null, r.creationFingerprint ?? null, r.creationEventId]);
    return true;
  } catch (error) { if (error.duplicate) return false; throw error; }
}

export async function readRunByCreationKey(key) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new FailClosed('INVALID_INPUT');
  return runFrom((await rows('SELECT * FROM tm_run WHERE creation_key = ?', [key]))[0]);
}

export async function activateRunCreation(runId) {
  const run = await readRun(runId);
  if (!run || run.state !== 'CREATING') return false;
  const event = (await rows(`SELECT payload, actor_account_id, issue_id FROM va_audit
    WHERE event_id = FROM_BASE64(?) AND event_type = 'TM_RUN_CREATED'`, [Buffer.from(run.creationEventId, 'hex').toString('base64')]))[0];
  const payload = json(event?.payload, null);
  if (!event || payload?.runId !== runId || payload.testDigest !== run.testDigest || payload.chainDigest !== run.chainDigest
    || payload.creationFingerprint !== run.creationFingerprint || event.actor_account_id !== run.createdBy || String(event.issue_id) !== run.executionIssueId) throw new FailClosed('RUN_SETUP_PENDING');
  return affected(await q("UPDATE tm_run SET state = 'IN_PROGRESS' WHERE run_id = ? AND state = 'CREATING'", [bin(runId)])) === 1;
}

export async function readRun(runId) {
  return runFrom((await rows('SELECT * FROM tm_run WHERE run_id = ?', [bin(runId)]))[0]);
}

export async function listRunsForExecution(executionIssueId) {
  const all = await rows('SELECT * FROM tm_run WHERE execution_issue_id = ? ORDER BY created_at ASC, run_id ASC LIMIT 501',
    [Number(executionIssueId)]);
  if (all.length > 500) throw new FailClosed('RUN_LIST_INCOMPLETE');
  return all.map(runFrom);
}

/**
 * What holds an execution from Done (testmgmt/executionGuard.js): every run
 * not in a terminal state (TERMINAL_RUN_STATES there), and every signed Failed
 * run whose bug is not CREATED. No row cap: one such run is enough to hold it,
 * so none may be left out.
 */
export async function listOpenRunsForExecution(executionIssueId) {
  const headers = (await rows(`SELECT r.run_id, r.state, r.result, r.chain, r.chain_digest, r.frozen_digest, b.state AS bug_state FROM tm_run r
    LEFT JOIN tm_bug b ON b.run_id = r.run_id
    WHERE r.execution_issue_id = ?`,
  [Number(executionIssueId)])).map(r => ({ runId: hex(r.run_id), state: r.state, result: r.result,
    chain: json(r.chain, null), chainDigest: r.chain_digest, frozenDigest: r.frozen_digest,
    bugState: r.bug_state ?? null }));
  const out = [];
  for (let start = 0; start < headers.length; start += 50) {
    const batch = headers.slice(start, start + 50);
    const ids = batch.filter(r => ['SIGNED', 'REJECTED', 'NOT_EXECUTED'].includes(r.state)).map(r => r.runId);
    const [signed, closed] = await Promise.all([listSignaturesFor('RUN', ids), listSignaturesFor('RUN_NOT_EXECUTED', ids)]);
    for (const run of batch) {
      const terminal = ['SIGNED', 'REJECTED', 'NOT_EXECUTED'].includes(run.state);
      const problem = terminal ? terminalProofProblem(run, signed.filter(s => s.subjectId === run.runId), closed.filter(s => s.subjectId === run.runId)) : null;
      if (!terminal || problem || (run.state === 'SIGNED' && run.result === 'FAILED' && run.bugState !== 'CREATED')) out.push({ ...run, proofProblem: problem });
    }
  }
  return out;
}

export async function listRunsForTest(testIssueId) {
  return (await rows('SELECT * FROM tm_run WHERE test_issue_id = ? ORDER BY created_at DESC LIMIT 100',
    [Number(testIssueId)])).map(runFrom);
}

/**
 * Step results change only while the run is IN_PROGRESS, and only from the
 * revision the tester saw.
 *
 * A change is pending until its audit event `eventId` is written: the run
 * keeps the event id and the results it replaced (`prior`), takes no other
 * change, and cannot be frozen for sign-off. confirmRunSteps makes it
 * effective; settleRunSteps decides it from the audit chain after an
 * interruption.
 */
export async function updateRunSteps({ runId, expectedRevision, steps, result, now, eventId, prior }) {
  const out = await q(`UPDATE tm_run SET steps = ?, result = ?, revision = revision + 1, updated_at = ?, step_event_id = ?, step_prior = ?
    WHERE run_id = ? AND revision = ? AND state = 'IN_PROGRESS' AND step_event_id IS NULL`,
  [JSON.stringify(steps), result, now, bin(eventId), JSON.stringify(prior), bin(runId), Number(expectedRevision)]);
  return affected(out) === 1;
}

export async function confirmRunSteps({ runId, eventId }) {
  return affected(await q('UPDATE tm_run SET step_event_id = NULL, step_prior = NULL WHERE run_id = ? AND step_event_id = ?',
    [bin(runId), bin(eventId)])) === 1;
}

/**
 * Finish a pending step change from the audit chain: its exact event makes it
 * effective; no event, once the writer is certainly gone (`abandoned`, or
 * longer than a resolver's invocation budget), restores the results it
 * replaced. Returns whether the run is free of a pending change.
 */
export async function settleRunSteps(runId, { now = Date.now(), abandoned = false } = {}) {
  const run = await readRun(runId);
  if (!run?.stepEventId) return true;
  const event = (await rows(`SELECT payload, issue_id FROM va_audit WHERE event_id = FROM_BASE64(?) AND event_type = 'TM_STEP_RECORDED'`,
    [Buffer.from(run.stepEventId, 'hex').toString('base64')]))[0];
  if (event) {
    const payload = json(event.payload, null);
    if (payload?.runId !== runId || Number(payload.revision) !== run.revision || String(event.issue_id) !== run.executionIssueId) throw new FailClosed('CONTENT_CHANGED');
    await confirmRunSteps({ runId, eventId: run.stepEventId });
    return true;
  }
  if (!abandoned && now - run.updatedAt <= 5 * 60_000) return false;
  if (!run.stepPrior || !Array.isArray(run.stepPrior.steps)) throw new FailClosed('RECORDS_INCOMPLETE');
  await q(`UPDATE tm_run SET steps = ?, result = ?, revision = revision + 1, updated_at = ?, step_event_id = NULL, step_prior = NULL
    WHERE run_id = ? AND step_event_id = ?`,
  [JSON.stringify(run.stepPrior.steps), run.stepPrior.result ?? null, now, bin(runId), bin(run.stepEventId)]);
  return true;
}

/** No run is frozen, closed or moved on while a step change waits for its audit event. */
export async function setRunState({ runId, from, to, expectedRevision, frozenDigest, now }) {
  const out = await q(`UPDATE tm_run SET state = ?, revision = revision + 1, updated_at = ?,
    frozen_digest = COALESCE(frozen_digest, ?) WHERE run_id = ? AND state = ? AND revision = ? AND step_event_id IS NULL`,
  [to, now, frozenDigest ?? null, bin(runId), from, Number(expectedRevision)]);
  return affected(out) === 1;
}

// ── signatures ────────────────────────────────────────────────────────────
function signatureFrom(row) {
  return {
    subject_kind: row.subject_kind, subjectId: hex(row.subject_id), step_index: Number(row.step_index),
    account_id: row.account_id, printedName: row.printed_name, role: row.role, label: row.label,
    meaning: row.meaning, decision: row.decision, reason: row.reason ?? null, contentHash: row.content_hash,
    assuranceLevel: row.assurance_level, signedAt: Number(row.signed_at), state: row.state,
    auditEventId: row.audit_event_id, auditSeq: row.audit_seq == null ? null : Number(row.audit_seq), auditHash: row.audit_hash
  };
}

export async function listSignatures(kind, subjectId) {
  return (await rows("SELECT * FROM tm_signature WHERE subject_kind = ? AND subject_id = ? AND state = 'ACTIVE' AND audit_seq IS NOT NULL ORDER BY step_index",
    [kind, bin(subjectId)])).map(signatureFrom);
}

export async function listSignaturesFor(kind, subjectIds) {
  if (!subjectIds.length) return [];
  const marks = subjectIds.map(() => '?').join(', ');
  return (await rows(`SELECT * FROM tm_signature WHERE subject_kind = ? AND subject_id IN (${marks}) AND state = 'ACTIVE' AND audit_seq IS NOT NULL ORDER BY step_index`,
    [kind, ...subjectIds.map(bin)])).map(signatureFrom);
}

/** Exactly once per step: false when the step was already signed. */
export async function insertSignature(s) {
  try {
    await q(`INSERT INTO tm_signature (subject_kind, subject_id, step_index, account_id, printed_name, role, label,
      meaning, decision, reason, content_hash, assurance_level, signed_at, state, audit_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
    [s.kind, bin(s.subjectId), s.stepIndex, s.accountId, s.printedName, s.role, s.label, s.meaning, s.decision,
      s.reason ?? null, s.contentHash, s.assuranceLevel, s.signedAt, bin(s.auditEventId)]);
    return true;
  } catch (error) { if (error.duplicate) return false; throw error; }
}

export async function activateSignature({ kind, subjectId, stepIndex, auditEventId, proof }) {
  if (!Number.isSafeInteger(proof?.seq) || !/^[0-9a-f]{64}$/.test(proof?.entryHash ?? '')) throw new FailClosed('LEDGER_UNAVAILABLE');
  return affected(await q(`UPDATE tm_signature SET state = 'ACTIVE', audit_seq = ?, audit_hash = ?
    WHERE subject_kind = ? AND subject_id = ? AND step_index = ? AND state = 'PENDING' AND audit_event_id = ?`,
  [proof.seq, proof.entryHash, kind, bin(subjectId), Number(stepIndex), bin(auditEventId)])) === 1;
}

/** Repair only from the exact durable audit event; never infer success from a row. */
export async function recoverSignatures(kind, subjectId, now = Date.now()) {
  const pending = await rows("SELECT * FROM tm_signature WHERE subject_kind = ? AND subject_id = ? AND state = 'PENDING'", [kind, bin(subjectId)]);
  for (const row of pending) {
    const audit = (await rows(`SELECT seq, entry_hash, payload, actor_account_id
      FROM va_audit WHERE event_id = FROM_BASE64(?)`, [Buffer.from(row.audit_event_id, 'hex').toString('base64')]))[0];
    if (audit) {
      const payload = json(audit.payload, null);
      if (audit.actor_account_id !== row.account_id || payload?.kind !== kind || payload.subjectId !== subjectId
        || Number(payload.stepIndex) !== Number(row.step_index) || payload.contentHash !== row.content_hash) throw new FailClosed('CONTENT_CHANGED');
      await activateSignature({ kind, subjectId, stepIndex: row.step_index, auditEventId: row.audit_event_id,
        proof: { seq: Number(audit.seq), entryHash: audit.entry_hash } });
    } else if (now - Number(row.signed_at) > 5 * 60_000) {
      // Longer than a resolver's invocation budget: an absent ledger event is
      // an abandoned attempt, not a still-running signer.
      await deleteSignature({ kind, subjectId, stepIndex: row.step_index, auditEventId: row.audit_event_id });
    }
  }
}

export async function hasPendingSignatures(kind, subjectId) {
  return (await rows("SELECT 1 FROM tm_signature WHERE subject_kind = ? AND subject_id = ? AND state <> 'ACTIVE' LIMIT 1", [kind, bin(subjectId)])).length > 0;
}

// ── bugs ──────────────────────────────────────────────────────────────────
function bugFrom(row) {
  if (!row) return null;
  return { runId: hex(row.run_id), projectId: String(row.project_id),
    parentIssueId: row.parent_issue_id == null ? null : String(row.parent_issue_id), marker: row.marker,
    state: row.state, issueId: row.issue_id == null ? null : String(row.issue_id), issueKey: row.issue_key ?? null,
    attempts: Number(row.attempts), lastError: row.last_error ?? null, updatedAt: Number(row.updated_at) };
}

export async function readBug(runId) {
  return bugFrom((await rows('SELECT * FROM tm_bug WHERE run_id = ?', [bin(runId)]))[0]);
}

export async function listBugsFor(runIds) {
  if (!runIds.length) return [];
  const marks = runIds.map(() => '?').join(', ');
  return (await rows(`SELECT * FROM tm_bug WHERE run_id IN (${marks})`, runIds.map(bin))).map(bugFrom);
}

/** The intent row. False when one already exists: the run already has its bug, or is getting it. */
export async function insertBugIntent({ runId, projectId, parentIssueId, marker, now }) {
  try {
    await q(`INSERT INTO tm_bug (run_id, project_id, parent_issue_id, marker, state, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'INTENT', 0, ?, ?)`, [bin(runId), Number(projectId), parentIssueId == null ? null : Number(parentIssueId), marker, now, now]);
    return true;
  } catch (error) { if (error.duplicate) return false; throw error; }
}

/**
 * Compare-and-swap on the state, and on the attempt count when
 * `expectedAttempts` is given: that is how a create attempt is claimed by one
 * caller only (testmgmt/bug.js).
 */
export async function updateBug(runId, { from, state, issueId = null, issueKey = null, lastError = null, attempted = false,
  expectedAttempts = null, now }) {
  const out = await q(`UPDATE tm_bug SET state = ?, issue_id = COALESCE(?, issue_id), issue_key = COALESCE(?, issue_key),
    last_error = ?, attempts = attempts + ?, updated_at = ? WHERE run_id = ? AND state = ?${expectedAttempts == null ? '' : ' AND attempts = ?'}`,
  [state, issueId == null ? null : Number(issueId), issueKey, lastError, attempted ? 1 : 0, now, bin(runId), from,
    ...(expectedAttempts == null ? [] : [Number(expectedAttempts)])]);
  return affected(out) === 1;
}

/** Which of these issue ids are bugs test management created (tree exclusion). */
export async function bugIssueIdsAmong(issueIds) {
  const ids = [...new Set(issueIds.map(Number).filter(Number.isSafeInteger))];
  if (!ids.length) return new Set();
  const marks = ids.map(() => '?').join(', ');
  return new Set((await rows(`SELECT issue_id FROM tm_bug WHERE issue_id IN (${marks})`, ids)).map(r => String(r.issue_id)));
}

/**
 * Only for a signature whose audit entry could not be written (testmgmt/signing.js):
 * it never took effect, so it is removed rather than left looking valid.
 */
export async function deleteSignature({ kind, subjectId, stepIndex, auditEventId }) {
  await q("DELETE FROM tm_signature WHERE subject_kind = ? AND subject_id = ? AND step_index = ? AND state = 'PENDING' AND audit_event_id = ?",
    [kind, bin(subjectId), Number(stepIndex), bin(auditEventId)]);
}

/** Undo a freeze whose signature could not be recorded. Only while nothing is signed. */
export async function unfreezeRun({ runId, from, now }) {
  const out = await q(`UPDATE tm_run SET state = 'IN_PROGRESS', frozen_digest = NULL, revision = revision + 1, updated_at = ?
    WHERE run_id = ? AND state = ? AND NOT EXISTS (SELECT 1 FROM tm_signature WHERE subject_id = ?)`, [now, bin(runId), from, bin(runId)]);
  return affected(out) === 1;
}

/** Latest signed version of a test, or null. */
export async function latestSignedVersion(testIssueId) {
  return versionFrom((await rows(`SELECT * FROM tm_test_version WHERE test_issue_id = ? AND state = 'SIGNED'
    ORDER BY version_no DESC LIMIT 1`, [Number(testIssueId)]))[0]);
}

/** Only for a version or run whose audit entry could not be written: it never took effect. */
export async function deleteVersion(versionId) {
  await q(`DELETE FROM tm_test_version WHERE version_id = ? AND state = 'PUBLISHING'`, [bin(versionId)]);
}

export async function deleteRun(runId) {
  await q(`DELETE FROM tm_run WHERE run_id = ? AND state = 'CREATING' AND revision = 1`, [bin(runId)]);
}

/** A newer publish supersedes an unsigned older version: only the latest can be signed. */
export async function supersedePublished(testIssueId, exceptVersionId) {
  await q(`UPDATE tm_test_version SET state = 'SUPERSEDED' WHERE test_issue_id = ? AND state = 'PUBLISHED' AND version_id <> ?`,
    [Number(testIssueId), bin(exceptVersionId)]);
}

export async function readVersions(versionIds) {
  const ids = [...new Set(versionIds)];
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(', ');
  return (await rows(`SELECT * FROM tm_test_version WHERE version_id IN (${marks})`, ids.map(bin))).map(versionFrom);
}
