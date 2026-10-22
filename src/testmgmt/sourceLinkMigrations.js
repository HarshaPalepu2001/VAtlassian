export const SOURCE_LINK_MIGRATIONS = [
  { id: 'v131_tm_source_link_type', sql: 'ALTER TABLE tm_project ADD COLUMN IF NOT EXISTS source_link_type_id VARCHAR(32) NULL' },
  { id: 'v132_tm_source_link_outbox', sql: `CREATE TABLE IF NOT EXISTS tm_source_link_outbox (
    version_id CHAR(32) NOT NULL PRIMARY KEY, test_issue_id BIGINT NOT NULL, project_id BIGINT NOT NULL,
    version_no INT NOT NULL, content_hash CHAR(64) NOT NULL, type_id VARCHAR(32) NULL,
    desired_sources JSON NOT NULL, prior_sources JSON NOT NULL, prior_version_id CHAR(32) NULL, prior_digest CHAR(64) NULL,
    state VARCHAR(16) NOT NULL, problem VARCHAR(64) NULL, audit_seq BIGINT NULL, audit_hash CHAR(64) NULL,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    KEY idx_tm_source_link_test (test_issue_id, version_no), KEY idx_tm_source_link_state (state, updated_at)
  )` },
  { id: 'v133_tm_source_link_lease', sql: `CREATE TABLE IF NOT EXISTS tm_source_link_lease (
    test_issue_id BIGINT NOT NULL PRIMARY KEY, token CHAR(32) NOT NULL, expires_at BIGINT NOT NULL
  )` }
];
