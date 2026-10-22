/** Root appends these after the shared test-management migrations; no existing signed baseline is rewritten. */
export const REPORT_MIGRATIONS = [
  { id: 'v123_tm_source_projection', sql: `CREATE TABLE IF NOT EXISTS tm_source_projection (
    version_id CHAR(32) NOT NULL, test_issue_id BIGINT NOT NULL, project_id BIGINT NOT NULL,
    expected_count INT NOT NULL, complete TINYINT NOT NULL DEFAULT 0, signed_at BIGINT NOT NULL,
    PRIMARY KEY (version_id), KEY idx_tm_source_projection_test (test_issue_id, project_id)
  )` },
  { id: 'v124_tm_source_association', sql: `CREATE TABLE IF NOT EXISTS tm_source_association (
    version_id CHAR(32) NOT NULL, test_issue_id BIGINT NOT NULL, source_issue_id BIGINT NOT NULL,
    project_id BIGINT NOT NULL, source_ref JSON NOT NULL, signed_at BIGINT NOT NULL,
    PRIMARY KEY (version_id, source_issue_id), KEY idx_tm_source_lookup (project_id, source_issue_id, test_issue_id)
  )` },
  { id: 'v125_tm_execution_summary', sql: `CREATE TABLE IF NOT EXISTS tm_execution_summary (
    summary_id CHAR(32) NOT NULL, execution_issue_id BIGINT NOT NULL, project_id BIGINT NOT NULL,
    digest CHAR(64) NOT NULL, snapshot JSON NOT NULL, created_by VARCHAR(128) NOT NULL, created_at BIGINT NOT NULL,
    PRIMARY KEY (summary_id), KEY idx_tm_summary_execution (execution_issue_id, created_at)
  )` },
  { id: 'v126_tm_source_decision', sql: `CREATE TABLE IF NOT EXISTS tm_source_decision (
    decision_id CHAR(32) NOT NULL, test_issue_id BIGINT NOT NULL, project_id BIGINT NOT NULL, source_issue_id BIGINT NOT NULL,
    kind VARCHAR(24) NOT NULL, content JSON NOT NULL, digest CHAR(64) NOT NULL, chain JSON NOT NULL, chain_digest CHAR(64) NOT NULL,
    state VARCHAR(16) NOT NULL, created_by VARCHAR(128) NOT NULL, created_at BIGINT NOT NULL, signed_at BIGINT NULL,
    PRIMARY KEY (decision_id), KEY idx_tm_source_decision_test (test_issue_id, created_at)
  )` }
];
