import { contentDigest } from './content.js';

const fail = () => { throw Object.assign(new Error('The complete test record could not be read.'), { reason: 'SERVICE_UNAVAILABLE' }); };
const parse = (value, fallback) => { if (value == null) return fallback; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { fail(); } };
const id = value => { const text = String(value ?? ''); if (!/^[a-f0-9]{32}$/.test(text)) fail(); return text; };
const issueId = value => { const text = String(value ?? ''); if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) fail(); return Number(text); };
const defaultQuery = async (sql, params) => (await import('../lib/db.js')).executeQuery(sql, params);

export function reportRunFrom(row) {
  return { runId: String(row.run_id), executionIssueId: String(row.execution_issue_id), projectId: String(row.project_id),
    testIssueId: String(row.test_issue_id), testVersionId: String(row.test_version_id), testDigest: row.test_digest,
    environment: row.environment ?? '', configuration: row.configuration ?? '',
    release: row.release_id == null ? null : { id: String(row.release_id), name: row.release_name },
    chain: parse(row.chain, null), chainDigest: row.chain_digest, state: row.state, result: row.result,
    steps: parse(row.steps, []), resolvedSteps: parse(row.resolved_steps, null), iterations: parse(row.iterations, []), revision: Number(row.revision), frozenDigest: row.frozen_digest ?? null,
    planSnapshot: parse(row.plan_snapshot, null), planningSnapshot: parse(row.planning_snapshot, null),
    datasetSnapshot: parse(row.dataset_snapshot, null), sourceSnapshot: parse(row.source_snapshot, null), creationKey: row.creation_key ?? null,
    retestOf: row.retest_of ?? null, createdBy: row.created_by, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}

/** Bounded reads always fetch one extra row. No caller can confuse a row cap with a complete result. */
export function createReportStore({ query = defaultQuery, maxRecords = 1000 } = {}) {
  const bound = Math.min(5000, Math.max(1, Number.isSafeInteger(maxRecords) ? maxRecords : 1000));
  const q = async (sql, params = []) => { const result = await query(sql, params); if (!result?.result) fail(); return result; };
  const read = async (sql, params) => { const data = (await q(sql, params)).data; if (!Array.isArray(data)) fail(); return data; };
  const bounded = (rows, convert = value => value) => ({ records: rows.slice(0, bound).map(convert), complete: rows.length <= bound });
  const runList = async (where, value) => bounded(await read(`SELECT * FROM tm_run WHERE ${where} = ? ORDER BY created_at DESC, run_id DESC LIMIT ${bound + 1}`, [issueId(value)]), reportRunFrom);
  const readRunsForTestComplete = testIssueId => runList('test_issue_id', testIssueId);
  const readRunsForExecutionComplete = executionIssueId => runList('execution_issue_id', executionIssueId);
  async function beginSignedSourceProjection(version) {
    await q(`INSERT INTO tm_source_projection (version_id, test_issue_id, project_id, expected_count, complete, signed_at)
      VALUES (?, ?, ?, ?, 0, ?) ON DUPLICATE KEY UPDATE version_id = version_id`,
    [id(version.versionId), issueId(version.testIssueId), issueId(version.projectId), (version.content.verifies ?? []).length, version.signedAt]);
  }
  async function insertSignedSourceAssociation(row) {
    await q(`INSERT INTO tm_source_association (version_id, test_issue_id, source_issue_id, project_id, source_ref, signed_at)
      VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE version_id = version_id`,
    [id(row.versionId), issueId(row.testIssueId), issueId(row.sourceIssueId), issueId(row.projectId), JSON.stringify(row.source), row.signedAt]);
  }
  async function finishSignedSourceProjection(version) {
    // The immutable content is the authority: a missing row or a conflicting projection never clears.
    const expected = version.content.verifies ?? [];
    const actual = await read(`SELECT source_ref FROM tm_source_association WHERE version_id = ? ORDER BY source_issue_id LIMIT 51`, [id(version.versionId)]);
    if (actual.length !== expected.length || contentDigest(actual.map(row => parse(row.source_ref)).sort((a, b) => a.issueId.localeCompare(b.issueId))) !==
      contentDigest([...expected].sort((a, b) => a.issueId.localeCompare(b.issueId)))) fail();
    await q(`UPDATE tm_source_projection SET complete = 1 WHERE version_id = ? AND expected_count = ?`, [id(version.versionId), expected.length]);
  }
  async function readTestsForSource(sourceIssueId, { projectId }) {
    const scope = issueId(projectId);
    const incomplete = await read(`SELECT v.version_id FROM tm_test_version v LEFT JOIN tm_source_projection p ON p.version_id = v.version_id
      WHERE v.project_id = ? AND v.state = 'SIGNED' AND (p.complete IS NULL OR p.complete <> 1)
      AND NOT EXISTS (SELECT 1 FROM tm_test_version n WHERE n.test_issue_id = v.test_issue_id AND n.state = 'SIGNED' AND n.version_no > v.version_no) LIMIT 1`, [scope]);
    const rows = await read(`SELECT a.test_issue_id, a.version_id FROM tm_source_association a
      JOIN tm_test_version v ON v.version_id = a.version_id JOIN tm_source_projection p ON p.version_id = v.version_id AND p.complete = 1
      WHERE a.project_id = ? AND a.source_issue_id = ? AND v.state = 'SIGNED'
      AND NOT EXISTS (SELECT 1 FROM tm_test_version n WHERE n.test_issue_id = v.test_issue_id AND n.state = 'SIGNED' AND n.version_no > v.version_no)
      ORDER BY a.test_issue_id LIMIT ${bound + 1}`, [scope, issueId(sourceIssueId)]);
    const result = bounded(rows, row => ({ testIssueId: String(row.test_issue_id), versionId: String(row.version_id) }));
    result.complete = result.complete && !incomplete.length; return result;
  }
  async function readSourcesForTest(testIssueId) {
    const versions = await read(`SELECT v.version_id, p.complete, p.expected_count FROM tm_test_version v
      LEFT JOIN tm_source_projection p ON p.version_id = v.version_id WHERE v.test_issue_id = ? AND v.state = 'SIGNED' ORDER BY v.version_no DESC LIMIT 1`, [issueId(testIssueId)]);
    if (!versions.length) return { records: [], complete: true };
    const version = versions[0];
    const rows = await read('SELECT source_ref FROM tm_source_association WHERE version_id = ? ORDER BY source_issue_id LIMIT 51', [id(version.version_id)]);
    return { records: rows.map(row => parse(row.source_ref)), complete: Number(version.complete) === 1 && rows.length === Number(version.expected_count) && rows.length <= 50 };
  }
  async function sourceProjectionComplete(versionId) {
    const row = (await read(`SELECT p.complete, p.expected_count,
      (SELECT COUNT(*) FROM tm_source_association a WHERE a.version_id = p.version_id) AS actual_count
      FROM tm_source_projection p WHERE p.version_id = ?`, [id(versionId)]))[0];
    return !!row && Number(row.complete) === 1 && Number(row.expected_count) === Number(row.actual_count);
  }
  async function readDefectsForTestComplete(testIssueId) {
    return bounded(await read(`SELECT b.* FROM tm_bug b JOIN tm_run r ON r.run_id = b.run_id
      WHERE r.test_issue_id = ? ORDER BY b.updated_at DESC LIMIT ${bound + 1}`, [issueId(testIssueId)]), row => ({
      runId: String(row.run_id), projectId: String(row.project_id), state: row.state, issueId: row.issue_id == null ? null : String(row.issue_id) }));
  }
  async function insertExecutionSummary(record) {
    if (contentDigest(record.snapshot) !== record.digest) fail();
    try {
      await q(`INSERT INTO tm_execution_summary (summary_id, execution_issue_id, project_id, digest, snapshot, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [id(record.summaryId), issueId(record.executionIssueId), issueId(record.projectId), record.digest, JSON.stringify(record.snapshot), record.createdBy, record.createdAt]); return true;
    } catch (error) { if (error?.code === 'ER_DUP_ENTRY' || error?.context?.debug?.code === 'ER_DUP_ENTRY') return false; throw error; }
  }
  async function readExecutionSummary(summaryId) {
    const row = (await read('SELECT * FROM tm_execution_summary WHERE summary_id = ?', [id(summaryId)]))[0];
    return row ? { summaryId: String(row.summary_id), executionIssueId: String(row.execution_issue_id), projectId: String(row.project_id), digest: row.digest,
      snapshot: parse(row.snapshot), createdBy: row.created_by, createdAt: Number(row.created_at) } : null;
  }
  function decisionFrom(row) {
    return { decisionId: String(row.decision_id), testIssueId: String(row.test_issue_id), projectId: String(row.project_id),
      sourceIssueId: String(row.source_issue_id), kind: row.kind, content: parse(row.content), digest: row.digest,
      chain: parse(row.chain), chainDigest: row.chain_digest, state: row.state, createdBy: row.created_by,
      createdAt: Number(row.created_at), signedAt: row.signed_at == null ? null : Number(row.signed_at) };
  }
  async function insertSourceDecision(record) {
    if (contentDigest(record.content) !== record.digest) fail();
    try {
      const out = await query(`INSERT INTO tm_source_decision (decision_id, test_issue_id, project_id, source_issue_id, kind, content,
        digest, chain, chain_digest, state, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SIGNING', ?, ?)`,
      [id(record.decisionId), issueId(record.testIssueId), issueId(record.projectId), issueId(record.sourceIssueId), record.kind,
        JSON.stringify(record.content), record.digest, JSON.stringify(record.chain), record.chainDigest, record.createdBy, record.createdAt]);
      if (!out?.result) {
        const code = out?.error?.code ?? out?.error?.context?.debug?.code;
        if (code === 'ER_DUP_ENTRY') return false;
        fail();
      }
      return true;
    } catch (error) { if ((error?.code ?? error?.context?.debug?.code) === 'ER_DUP_ENTRY') return false; throw error; }
  }
  async function readSourceDecision(decisionId) {
    const row = (await read('SELECT * FROM tm_source_decision WHERE decision_id = ?', [id(decisionId)]))[0];
    return row ? decisionFrom(row) : null;
  }
  async function setSourceDecisionState({ decisionId, from, to, now }) {
    if (from !== 'SIGNING' || to !== 'SIGNED') fail();
    const out = await q('UPDATE tm_source_decision SET state = ?, signed_at = ? WHERE decision_id = ? AND state = ?', [to, now, id(decisionId), from]);
    return Number(out.data?.affectedRows) === 1;
  }
  async function readSourceDecisionsForTestComplete(testIssueId) {
    return bounded(await read(`SELECT * FROM tm_source_decision WHERE test_issue_id = ? ORDER BY created_at DESC, decision_id DESC LIMIT ${bound + 1}`, [issueId(testIssueId)]), decisionFrom);
  }
  return { readRunsForTestComplete, readRunsForExecutionComplete, beginSignedSourceProjection, insertSignedSourceAssociation,
    finishSignedSourceProjection, sourceProjectionComplete, readTestsForSource, readSourcesForTest, readDefectsForTestComplete, insertExecutionSummary, readExecutionSummary,
    insertSourceDecision, readSourceDecision, setSourceDecisionState, readSourceDecisionsForTestComplete };
}
