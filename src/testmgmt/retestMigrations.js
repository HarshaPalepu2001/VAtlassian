/** Root assigns final global migration ids when integrating this slice. */
export const RETEST_MIGRATIONS = [
  { id: 'tm-retest-intent', sql: `CREATE TABLE IF NOT EXISTS tm_retest_intent (
    request_id CHAR(32) NOT NULL PRIMARY KEY,
    project_id BIGINT NOT NULL,
    source_execution_issue_id BIGINT NOT NULL,
    source_execution_key VARCHAR(64) NOT NULL,
    parent_issue_id BIGINT NOT NULL,
    actor_account_id VARCHAR(128) NOT NULL,
    fingerprint CHAR(64) NOT NULL,
    marker VARCHAR(64) NOT NULL,
    snapshot MEDIUMTEXT NOT NULL,
    state VARCHAR(24) NOT NULL,
    execution_issue_id BIGINT NULL,
    execution_key VARCHAR(64) NULL,
    last_error VARCHAR(255) NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    KEY idx_tm_retest_source (source_execution_issue_id),
    KEY idx_tm_retest_state (project_id, state)
  )` },
  { id: 'tm-retest-run', sql: `CREATE TABLE IF NOT EXISTS tm_retest_run (
    request_id CHAR(32) NOT NULL,
    source_run_id CHAR(32) NOT NULL,
    target_run_id CHAR(32) NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (request_id, source_run_id),
    UNIQUE KEY uq_tm_retest_target (target_run_id)
  )` }
];
