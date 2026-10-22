/** Root assigns global migration numbers when integrating this independently developed slice. */
export const PLANNING_MIGRATIONS = [
  { id: 'tm-planning-collection-draft', sql: `CREATE TABLE IF NOT EXISTS tm_collection_draft (
    issue_id BIGINT NOT NULL,
    project_id BIGINT NOT NULL,
    role VARCHAR(24) NOT NULL,
    content MEDIUMTEXT NOT NULL,
    revision INT NOT NULL DEFAULT 1,
    updated_at BIGINT NOT NULL,
    updated_by VARCHAR(128) NOT NULL,
    PRIMARY KEY (issue_id),
    KEY idx_tm_collection_project (project_id, role)
  )` },
  { id: 'tm-planning-collection-revision', sql: `CREATE TABLE IF NOT EXISTS tm_collection_revision (
    revision_id CHAR(32) NOT NULL,
    issue_id BIGINT NOT NULL,
    project_id BIGINT NOT NULL,
    role VARCHAR(24) NOT NULL,
    revision_no INT NOT NULL,
    draft_revision INT NOT NULL,
    content MEDIUMTEXT NOT NULL,
    digest CHAR(64) NOT NULL,
    chain TEXT NOT NULL,
    chain_digest CHAR(64) NOT NULL,
    state VARCHAR(24) NOT NULL,
    published_by VARCHAR(128) NOT NULL,
    published_at BIGINT NOT NULL,
    signed_at BIGINT NULL,
    PRIMARY KEY (revision_id),
    UNIQUE KEY uq_tm_collection_revision_no (issue_id, revision_no),
    KEY idx_tm_collection_signed (project_id, role, state)
  )` },
  { id: 'tm-planning-set-mapping', sql: 'ALTER TABLE tm_project ADD COLUMN set_type_id VARCHAR(32) NULL' },
  { id: 'tm-planning-precondition-mapping', sql: 'ALTER TABLE tm_project ADD COLUMN precondition_type_id VARCHAR(32) NULL' }
];
