/** Fresh-app consolidated schema. Append-only after first release.
 * UUID binary keys, Node-computed hashes, epoch milliseconds, one DDL per entry.
 * Traceability seams (reserved names only): va_trace_node, va_trace_edge, va_trace_run.
 * Configuration namespace reserved: trace.*. Baseline baseline_id is the trace anchor.
 */
import { PLANNING_MIGRATIONS } from '../testmgmt/planningMigrations.js';
import { REPORT_MIGRATIONS } from '../testmgmt/reportMigrations.js';
import { BUG_MIGRATIONS } from '../testmgmt/bugStore.js';
import { RETEST_MIGRATIONS } from '../testmgmt/retestMigrations.js';
import { SOURCE_LINK_MIGRATIONS } from '../testmgmt/sourceLinkMigrations.js';
import { BASELINE_LINK_POLICY_MIGRATIONS } from './baselineLinkPolicyMigrations.js';

export const MIGRATIONS = [
  { id: 'v001_config', sql: `CREATE TABLE IF NOT EXISTS va_config (
    cfg_key    VARCHAR(64)  NOT NULL,
    cfg_value  TEXT         NOT NULL,
    updated_at BIGINT       NOT NULL,
    updated_by VARCHAR(128) NOT NULL,
    PRIMARY KEY (cfg_key)
  )` },
  { id: 'v002_admin', sql: `CREATE TABLE IF NOT EXISTS va_admin (
    account_id VARCHAR(128) NOT NULL,
    state      VARCHAR(16)  NOT NULL,
    seeded_by  VARCHAR(128) NOT NULL,
    created_at BIGINT       NOT NULL,
    revoked_at BIGINT       NULL,
    PRIMARY KEY (account_id)
  )` },
  { id: 'v003_credential', sql: `CREATE TABLE IF NOT EXISTS va_credential (
    account_id        VARCHAR(128)   NOT NULL,
    secret_ciphertext  VARBINARY(64)  NOT NULL,
    secret_iv          VARBINARY(16)  NOT NULL,
    secret_tag          VARBINARY(16) NOT NULL,
    key_version         INT           NOT NULL,
    algo                VARCHAR(16)   NOT NULL,
    digits              INT           NOT NULL DEFAULT 6,
    period_seconds       INT          NOT NULL DEFAULT 30,
    state               VARCHAR(24)   NOT NULL,
    failed_attempts     INT           NOT NULL DEFAULT 0,
    locked_at           BIGINT        NULL,
    enrolled_at         BIGINT        NOT NULL,
    confirmed_at        BIGINT        NULL,
    last_used_step      BIGINT        NULL,
    version             INT           NOT NULL DEFAULT 0,
    last_verified_at BIGINT NULL,
    verification_count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id)
  )` },
  { id: 'v004_approval', sql: `CREATE TABLE IF NOT EXISTS va_approval (
    approval_id   BINARY(16)   NOT NULL,
    issue_key VARCHAR(64) NOT NULL,
    issue_type_id VARCHAR(64) NOT NULL,
    issue_id         BIGINT        NOT NULL,
    project_id       BIGINT        NOT NULL,
    transition_id VARCHAR(32) NULL,
    from_status_id VARCHAR(32) NULL,
    to_status_id VARCHAR(32) NULL,
    account_id     VARCHAR(128) NOT NULL,
    printed_name   VARCHAR(255) NOT NULL,
    signer_role    VARCHAR(32)  NOT NULL,
    meaning VARCHAR(255) NOT NULL,
    content_hash   CHAR(64)     NOT NULL,
    state            VARCHAR(16)   NOT NULL,
    created_at     BIGINT       NOT NULL,
    expires_at       BIGINT        NOT NULL,
    consumed_at      BIGINT        NULL,
    covers_from_hash CHAR(64) NULL,
    covers_to_hash   CHAR(64) NULL,
    baseline_id BINARY(16) NULL,
    baseline_version INT NULL,
    decision VARCHAR(16) NOT NULL DEFAULT 'APPROVE',
    actor_account_id VARCHAR(128) NOT NULL,
    actor_name VARCHAR(255) NOT NULL,
    decided_at BIGINT NOT NULL,
    drift_count INT NOT NULL DEFAULT 0,
    report_hash      CHAR(64)      NULL,
    note TEXT NULL,
    assurance_level VARCHAR(24) NOT NULL,
    provider_id VARCHAR(32) NOT NULL,
    provider_ref VARCHAR(255) NULL,
    provider_evidence TEXT NOT NULL,
    evidence_hash CHAR(64) NOT NULL,
    signed_at BIGINT NOT NULL,
    PRIMARY KEY (approval_id),
    KEY idx_approval_pending (issue_id, state, from_status_id, to_status_id, decided_at),
    KEY idx_approval_project (project_id, decided_at),
    KEY idx_decision_history (issue_id, decided_at),
    KEY idx_decision_actor (actor_account_id, decided_at)
  )` },
  { id: 'v005_audit', sql: `CREATE TABLE IF NOT EXISTS va_audit (
    seq              BIGINT       NOT NULL,
    event_id         BINARY(16)   NOT NULL,
    occurred_at      BIGINT       NOT NULL,
    actor_account_id VARCHAR(128) NOT NULL,
    event_type       VARCHAR(48)  NOT NULL,
    issue_id         BIGINT       NULL,
    approval_id     BINARY(16)   NULL,
    payload          TEXT         NOT NULL,
    prev_hash        CHAR(64)     NOT NULL,
    entry_hash       CHAR(64)     NOT NULL,
    PRIMARY KEY (seq),
    KEY idx_audit_issue (issue_id, seq)
  )` },
  { id: 'v006_chain_segment', sql: `CREATE TABLE IF NOT EXISTS va_chain_segment (
    segment_id         BINARY(16) NOT NULL,
    from_seq           BIGINT     NOT NULL,
    to_seq             BIGINT     NOT NULL,
    opening_hash       CHAR(64)   NOT NULL,
    terminal_hash      CHAR(64)   NOT NULL,
    sealed_at          BIGINT     NOT NULL,
    export_target      VARCHAR(32) NOT NULL,
    export_ref         VARCHAR(255) NULL,
    export_sha256      CHAR(64)   NULL,
    verified_at        BIGINT     NULL,
    pruned_at          BIGINT     NULL,
    PRIMARY KEY (segment_id)
  )` },
  { id: 'v007_controlled_transition', sql: `CREATE TABLE IF NOT EXISTS va_controlled_transition (
    ct_id             BINARY(16)   NOT NULL,
    project_id        BIGINT       NOT NULL,
    issue_type_id     VARCHAR(32)  NOT NULL,
    from_status_id    VARCHAR(32)  NOT NULL,
    to_status_id      VARCHAR(32)  NOT NULL,
    required_role     VARCHAR(32)  NOT NULL,
    meaning VARCHAR(32) NOT NULL DEFAULT 'APPROVED',
    state             VARCHAR(16)  NOT NULL,
    created_at        BIGINT       NOT NULL,
    created_by        VARCHAR(128) NOT NULL,
    reject_to_status_id VARCHAR(32) NULL,
    require_decision  BOOLEAN      NOT NULL DEFAULT FALSE,
    block_on_drift    BOOLEAN      NOT NULL DEFAULT TRUE,
    transition_id VARCHAR(32) NULL,
    required_assurance VARCHAR(24) NOT NULL DEFAULT 'ESIGNATURE',
    capture_baseline BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (ct_id),
    KEY idx_gt_lookup (project_id, issue_type_id, to_status_id, state)
  )` },
  { id: 'v008_eligibility', sql: `CREATE TABLE IF NOT EXISTS va_eligibility (
    el_id         BINARY(16)   NOT NULL,
    account_id    VARCHAR(128) NOT NULL,
    issue_type_id VARCHAR(32)  NOT NULL,
    role          VARCHAR(32)  NOT NULL,
    state         VARCHAR(16)  NOT NULL,
    granted_at    BIGINT       NOT NULL,
    granted_by    VARCHAR(128) NOT NULL,
    project_id    BIGINT       NULL,
    display_name VARCHAR(255) NOT NULL DEFAULT '',
    PRIMARY KEY (el_id),
    KEY idx_elig_lookup (account_id, issue_type_id, state),
    KEY idx_reviewer_scope (account_id, issue_type_id, role, state, project_id),
    KEY idx_reviewer_role (issue_type_id, role, state)
  )` },
  { id: 'v009_credential_reset_grant', sql: `CREATE TABLE IF NOT EXISTS va_credential_reset_grant (
    grant_id    BINARY(16)   NOT NULL,
    account_id  VARCHAR(128) NOT NULL,
    issued_by   VARCHAR(128) NOT NULL,
    issued_at   BIGINT       NOT NULL,
    expires_at  BIGINT       NOT NULL,
    redeemed_at BIGINT       NULL,
    PRIMARY KEY (grant_id),
    KEY idx_reset_grant_open (account_id, redeemed_at, issued_at)
  )` },
  { id: 'v010_item_state', sql: `CREATE TABLE IF NOT EXISTS va_item_state (
    issue_id            BIGINT       NOT NULL,
    project_id          BIGINT       NOT NULL,
    issue_type_id       VARCHAR(32)  NOT NULL,
    content_hash        CHAR(64)     NULL,
    baseline_hash CHAR(64) NULL,
    state               VARCHAR(16)  NOT NULL,
    last_checked_at     BIGINT       NOT NULL,
    last_change_at BIGINT NULL,
    version             INT          NOT NULL DEFAULT 0,
    field_digests       TEXT         NULL,
    baseline_status_id VARCHAR(32) NULL,
    issue_key           VARCHAR(32)  NOT NULL,
    summary             VARCHAR(255) NOT NULL,
    reviewer_account_id VARCHAR(128) NULL,
    reviewer_name       VARCHAR(255) NULL,
    baseline_id         BINARY(16)   NULL,
    baseline_version    INT          NULL,
    drift_count         INT          NOT NULL DEFAULT 0,
    drifted_field_count INT          NOT NULL DEFAULT 0,
    max_materiality     VARCHAR(16)  NULL,
    last_drift_at       BIGINT       NULL,
    last_drift_by       VARCHAR(128) NULL,
    last_changelog_id   VARCHAR(64)  NULL,
    PRIMARY KEY (issue_id),
    KEY idx_review_sweep (last_checked_at),
    KEY idx_review_reviewer (reviewer_account_id, state, last_drift_at),
    KEY idx_review_project (project_id, state, last_drift_at)
  )` },
  { id: 'v011_controlled_field', sql: `CREATE TABLE IF NOT EXISTS va_controlled_field (
    cf_id         BINARY(16)   NOT NULL,
    project_id    BIGINT       NOT NULL,
    issue_type_id VARCHAR(32)  NOT NULL,
    field_id      VARCHAR(64)  NOT NULL,
    field_kind    VARCHAR(24)  NOT NULL,
    state         VARCHAR(16)  NOT NULL,
    created_at    BIGINT       NOT NULL,
    created_by    VARCHAR(128) NOT NULL,
    field_name    VARCHAR(255) NOT NULL,
    schema_type   VARCHAR(48)  NULL,
    store_values  BOOLEAN      NOT NULL DEFAULT TRUE,
    writable      BOOLEAN      NULL,
    materiality   VARCHAR(16)  NOT NULL,
    PRIMARY KEY (cf_id),
    KEY idx_cf_lookup (project_id, issue_type_id, state)
  )` },
  { id: 'v012_event_receipt', sql: `CREATE TABLE IF NOT EXISTS va_event_receipt (
    event_id    VARCHAR(128) NOT NULL,
    issue_id    BIGINT       NOT NULL,
    received_at BIGINT       NOT NULL,
    outcome     VARCHAR(24)  NOT NULL,
    PRIMARY KEY (event_id),
    KEY idx_receipt_prune (received_at)
  )` },
  { id: 'v013_gate_finding', sql: `CREATE TABLE IF NOT EXISTS va_gate_finding (
    finding_key    VARCHAR(191) NOT NULL,
    finding_type   VARCHAR(32)  NOT NULL,
    severity       VARCHAR(16)  NOT NULL,
    project_id     BIGINT       NULL,
    issue_type_id  VARCHAR(32)  NULL,
    workflow_id    VARCHAR(191) NULL,
    transition_id  VARCHAR(32)  NULL,
    from_status_id VARCHAR(32)  NULL,
    to_status_id   VARCHAR(32)  NULL,
    detail         TEXT         NOT NULL,
    first_seen_at  BIGINT       NOT NULL,
    last_seen_at   BIGINT       NOT NULL,
    cleared_at     BIGINT       NULL,
    PRIMARY KEY (finding_key),
    KEY idx_gate_finding_open (cleared_at, severity)
  )` },
  { id: 'v014_alert', sql: `CREATE TABLE IF NOT EXISTS va_alert (
    alert_id     BINARY(16)   NOT NULL,
    dedupe_key   VARCHAR(191) NOT NULL,
    kind         VARCHAR(32)  NOT NULL,
    severity     VARCHAR(16)  NOT NULL,
    title        VARCHAR(255) NOT NULL,
    body         TEXT         NOT NULL,
    occurred_at  BIGINT       NOT NULL,
    attempts     INT          NOT NULL,
    last_error   TEXT         NULL,
    delivered_at BIGINT       NULL,
    delivery_ref VARCHAR(64)  NULL,
    PRIMARY KEY (alert_id),
    UNIQUE KEY uq_alert_dedupe (dedupe_key),
    KEY idx_alert_pending (delivered_at, occurred_at)
  )` },
  { id: 'v015_baseline', sql: `CREATE TABLE IF NOT EXISTS va_baseline (
    baseline_id    BINARY(16)   NOT NULL,
    issue_id       BIGINT       NOT NULL,
    project_id     BIGINT       NOT NULL,
    issue_type_id  VARCHAR(32)  NOT NULL,
    version        INT          NOT NULL,
    state          VARCHAR(16)  NOT NULL,
    content_hash   CHAR(64)     NOT NULL,
    field_digests  TEXT         NOT NULL,
    transition_id  VARCHAR(32)  NULL,
    from_status_id VARCHAR(32)  NULL,
    to_status_id   VARCHAR(32)  NULL,
    approved_by    VARCHAR(128) NOT NULL,
    approved_name  VARCHAR(255) NOT NULL,
    transition_at  BIGINT       NOT NULL,
    captured_at    BIGINT       NOT NULL,
    approval_id BINARY(16) NULL,
    fidelity       VARCHAR(16)  NOT NULL,
    field_count    INT          NOT NULL,
    value_bytes    INT          NOT NULL DEFAULT 0,
    assurance_level VARCHAR(24) NOT NULL,
    PRIMARY KEY (baseline_id),
    UNIQUE KEY idx_baseline_version (issue_id, version),
    UNIQUE KEY idx_baseline_approval (issue_id, approval_id),
    KEY idx_baseline_state (issue_id, state)
  )` },
  { id: 'v016_baseline_value', sql: `CREATE TABLE IF NOT EXISTS va_baseline_value (
    issue_id  BIGINT      NOT NULL,
    version   INT         NOT NULL,
    field_id  VARCHAR(64) NOT NULL,
    seq       INT         NOT NULL,
    encoding  VARCHAR(16) NOT NULL,
    raw_bytes INT         NOT NULL,
    data      MEDIUMTEXT  NOT NULL,
    PRIMARY KEY (issue_id, version, field_id, seq)
  )` },
  { id: 'v017_drift', sql: `CREATE TABLE IF NOT EXISTS va_drift (
    drift_id         BINARY(16)   NOT NULL,
    issue_id         BIGINT       NOT NULL,
    project_id       BIGINT       NOT NULL,
    baseline_id      BINARY(16)   NOT NULL,
    baseline_version INT          NOT NULL,
    field_id         VARCHAR(64)  NOT NULL,
    field_name       VARCHAR(255) NOT NULL,
    from_digest      CHAR(64)     NULL,
    to_digest        CHAR(64)     NULL,
    from_repr        VARCHAR(512) NULL,
    to_repr          VARCHAR(512) NULL,
    actor_account_id VARCHAR(128) NULL,
    actor_name       VARCHAR(255) NULL,
    occurred_at      BIGINT       NOT NULL,
    changelog_id     VARCHAR(64)  NULL,
    detected_via     VARCHAR(16)  NOT NULL,
    source           VARCHAR(16)  NOT NULL,
    materiality      VARCHAR(16)  NOT NULL,
    approval_id      BINARY(16)   NULL,
    PRIMARY KEY (drift_id),
    KEY idx_drift_issue (issue_id, occurred_at),
    KEY idx_drift_undecided (approval_id, occurred_at),
    UNIQUE KEY idx_drift_dedupe (issue_id, changelog_id, field_id)
  )` },
  { id: 'v018_restore', sql: `CREATE TABLE IF NOT EXISTS va_restore (
    restore_id       BINARY(16)   NOT NULL,
    approval_id      BINARY(16)   NOT NULL,
    issue_id         BIGINT       NOT NULL,
    project_id       BIGINT       NOT NULL,
    baseline_id      BINARY(16)   NOT NULL,
    baseline_version INT          NOT NULL,
    actor_account_id VARCHAR(128) NOT NULL,
    started_at       BIGINT       NOT NULL,
    finished_at      BIGINT       NULL,
    attempted        INT          NOT NULL DEFAULT 0,
    succeeded        INT          NOT NULL DEFAULT 0,
    failed           INT          NOT NULL DEFAULT 0,
    skipped          INT          NOT NULL DEFAULT 0,
    irreversible     INT          NOT NULL DEFAULT 0,
    state            VARCHAR(16)  NOT NULL,
    detail           MEDIUMTEXT   NULL,
    PRIMARY KEY (restore_id),
    KEY idx_restore_issue (issue_id, started_at)
  )` },
  { id: 'v019_ai_report', sql: `CREATE TABLE IF NOT EXISTS va_ai_report (
    report_hash   CHAR(64)     NOT NULL,
    issue_id      BIGINT       NOT NULL,
    baseline_id   BINARY(16)   NOT NULL,
    model         VARCHAR(64)  NOT NULL,
    body          MEDIUMTEXT   NOT NULL,
    input_tokens  INT          NULL,
    output_tokens INT          NULL,
    generated_at  BIGINT       NOT NULL,
    degraded      BOOLEAN      NOT NULL DEFAULT FALSE,
    PRIMARY KEY (report_hash),
    KEY idx_report_issue (issue_id, generated_at)
  )` },
  { id: 'v020_write_suppression', sql: `CREATE TABLE IF NOT EXISTS va_write_suppression (
    issue_id   BIGINT      NOT NULL,
    field_id   VARCHAR(64) NOT NULL,
    digest     CHAR(64)    NOT NULL,
    written_at BIGINT      NOT NULL,
    expires_at BIGINT      NOT NULL,
    PRIMARY KEY (issue_id, field_id, digest),
    KEY idx_suppression_prune (expires_at)
  )` },
  // 2026-09-07: the rejected candidate's per-field digests, captured when the
  // restore starts. Two jobs: it is the evidence of WHAT was rejected, which a
  // successful restore would otherwise erase from the item; and it is what
  // lib/restore/resume.js needs to decide whether a retry may still resume the
  // reviewer's signature instead of silently re-signing today's content.
  { id: 'v021_restore_candidate', sql:
    `ALTER TABLE va_restore ADD COLUMN candidate_digests MEDIUMTEXT NULL` },
  { id: 'v022_incident', sql: `CREATE TABLE IF NOT EXISTS va_incident (
    incident_id BINARY(16) NOT NULL,
    issue_id BIGINT NOT NULL,
    account_id VARCHAR(255) NULL,
    event_type VARCHAR(64) NOT NULL,
    occurred_at BIGINT NOT NULL,
    PRIMARY KEY (incident_id),
    KEY idx_incident_issue (issue_id, occurred_at)
  )` },
  { id: 'v023_proposal_snapshot', sql: `CREATE TABLE IF NOT EXISTS va_proposal (
    proposal_id BINARY(16) NOT NULL,
    issue_id BIGINT NOT NULL,
    baseline_id BINARY(16) NOT NULL,
    baseline_version INT NOT NULL,
    baseline_hash CHAR(64) NOT NULL,
    field_config_version VARCHAR(64) NULL,
    content_hash CHAR(64) NOT NULL,
    field_digests TEXT NOT NULL,
    proposer_account_id VARCHAR(128) NOT NULL,
    state VARCHAR(16) NOT NULL,
    captured_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    operation_plan_hash CHAR(64) NULL,
    PRIMARY KEY (proposal_id),
    KEY idx_proposal_issue (issue_id, state)
  )` },
  { id: 'v023_proposal_snapshot_val', sql: `CREATE TABLE IF NOT EXISTS va_proposal_value (
    proposal_id BINARY(16) NOT NULL,
    field_id VARCHAR(64) NOT NULL,
    seq INT NOT NULL,
    encoding VARCHAR(16) NOT NULL,
    raw_bytes INT NOT NULL,
    data MEDIUMTEXT NOT NULL,
    PRIMARY KEY (proposal_id, field_id, seq)
  )` },
  { id: 'v024_challenge', sql: `CREATE TABLE IF NOT EXISTS va_challenge (
    challenge_id BINARY(16) NOT NULL,
    tenant_id VARCHAR(128) NOT NULL,
    issue_id BIGINT NOT NULL,
    signer_account_id VARCHAR(128) NOT NULL,
    decision VARCHAR(16) NOT NULL,
    meaning VARCHAR(255) NOT NULL,
    baseline_id BINARY(16) NOT NULL,
    candidate_hash CHAR(64) NOT NULL,
    transition_id VARCHAR(32) NULL,
    operation_plan_hash CHAR(64) NULL,
    nonce VARCHAR(64) NOT NULL,
    state VARCHAR(16) NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (challenge_id)
  )` },
  { id: 'v025_operation', sql: `CREATE TABLE IF NOT EXISTS va_operation (
    operation_id BINARY(16) NOT NULL,
    issue_id BIGINT NOT NULL,
    type VARCHAR(32) NOT NULL,
    state VARCHAR(16) NOT NULL,
    actor_account_id VARCHAR(128) NOT NULL,
    payload TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (operation_id),
    KEY idx_operation_issue (issue_id, state)
  )` },
  { id: 'v026_challenge_baseline_nullable', sql: `ALTER TABLE va_challenge MODIFY baseline_id BINARY(16) NULL` },
  { id: 'v027_observation', sql: `CREATE TABLE IF NOT EXISTS va_observation (
    observation_id CHAR(64) NOT NULL, issue_id BIGINT NOT NULL, baseline_id BINARY(16) NOT NULL,
    baseline_version INT NOT NULL, content_hash CHAR(64) NOT NULL, field_digests MEDIUMTEXT NOT NULL,
    matches_baseline BOOLEAN NOT NULL, event_id VARCHAR(128) NULL, event_at BIGINT NULL,
    observed_at BIGINT NOT NULL, actor_account_id VARCHAR(128) NULL, detected_via VARCHAR(16) NOT NULL,
    state VARCHAR(16) NOT NULL, PRIMARY KEY (observation_id), KEY idx_observation_issue (issue_id, observed_at)
  )` },
  { id: 'v028_observation_value', sql: `CREATE TABLE IF NOT EXISTS va_observation_value (
    observation_id CHAR(64) NOT NULL, field_id VARCHAR(64) NOT NULL, seq INT NOT NULL,
    encoding VARCHAR(16) NOT NULL, raw_bytes INT NOT NULL, data MEDIUMTEXT NOT NULL,
    PRIMARY KEY (observation_id, field_id, seq)
  )` },
  { id: 'v029_webauthn_credential', sql: `CREATE TABLE IF NOT EXISTS va_webauthn_credential (
    credential_row_id BINARY(16) NOT NULL,
    account_id VARCHAR(128) NOT NULL,
    credential_id VARCHAR(255) NOT NULL,
    public_key TEXT NOT NULL,
    sign_count BIGINT NOT NULL DEFAULT 0,
    rp_id VARCHAR(255) NOT NULL,
    origin VARCHAR(512) NOT NULL,
    aaguid VARCHAR(64) NULL,
    transports VARCHAR(128) NULL,
    backup_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    backup_state BOOLEAN NOT NULL DEFAULT FALSE,
    device_label VARCHAR(128) NULL,
    state VARCHAR(16) NOT NULL,
    enrolled_at BIGINT NOT NULL,
    last_used_at BIGINT NULL,
    PRIMARY KEY (credential_row_id),
    UNIQUE KEY idx_webauthn_account_credential (account_id, credential_id),
    KEY idx_webauthn_account_state (account_id, state, enrolled_at)
  )` },
  { id: 'v030_webauthn_challenge', sql: `CREATE TABLE IF NOT EXISTS va_webauthn_challenge (
    challenge_id BINARY(16) NOT NULL,
    account_id VARCHAR(128) NOT NULL,
    purpose VARCHAR(16) NOT NULL,
    challenge VARCHAR(255) NOT NULL,
    binding_hash CHAR(64) NULL,
    issue_id BIGINT NULL,
    approval_challenge_id BINARY(16) NULL,
    rp_id VARCHAR(255) NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    consumed_at BIGINT NULL,
    PRIMARY KEY (challenge_id),
    KEY idx_webauthn_challenge_account (account_id, consumed_at, expires_at),
    KEY idx_webauthn_challenge_approval (approval_challenge_id)
  )` },
  { id: 'v032_baseline_tree_meta', sql: `ALTER TABLE va_baseline
  ADD COLUMN tree_hash CHAR(64) NULL,
  ADD COLUMN tree_schema_version INT NOT NULL DEFAULT 1,
  ADD COLUMN node_count INT NOT NULL DEFAULT 1,
  ADD COLUMN edge_count INT NOT NULL DEFAULT 0,
  ADD COLUMN total_field_count INT NOT NULL DEFAULT 0` },
  { id: 'v033_baseline_node', sql: `CREATE TABLE IF NOT EXISTS va_baseline_node (
  baseline_id BINARY(16) NOT NULL,
  logical_node_id CHAR(64) NOT NULL,
  original_issue_id BIGINT NOT NULL,
  current_issue_id BIGINT NOT NULL,
  issue_key VARCHAR(32) NOT NULL,
  parent_logical_node_id CHAR(64) NULL,
  project_id BIGINT NOT NULL,
  issue_type_id VARCHAR(32) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  field_digests MEDIUMTEXT NOT NULL,
  node_order INT NOT NULL,
  PRIMARY KEY (baseline_id, logical_node_id),
  UNIQUE KEY uq_baseline_original_issue (baseline_id, original_issue_id),
  KEY idx_baseline_current_issue (current_issue_id, baseline_id)
)` },
  { id: 'v034_baseline_node_value', sql: `CREATE TABLE IF NOT EXISTS va_baseline_node_value (
  baseline_id BINARY(16) NOT NULL,
  logical_node_id CHAR(64) NOT NULL,
  field_id VARCHAR(64) NOT NULL,
  seq INT NOT NULL DEFAULT 0,
  encoding VARCHAR(16) NOT NULL,
  raw_bytes INT NOT NULL,
  chunk MEDIUMTEXT NOT NULL,
  PRIMARY KEY (baseline_id, logical_node_id, field_id, seq)
)` },
  { id: 'v035_tree_drift', sql: `CREATE TABLE IF NOT EXISTS va_tree_drift (
  baseline_id BINARY(16) NOT NULL,
  logical_node_id CHAR(64) NOT NULL,
  field_id VARCHAR(64) NOT NULL,
  field_name VARCHAR(256) NULL,
  baseline_digest CHAR(64) NULL,
  current_digest CHAR(64) NULL,
  materiality VARCHAR(32) NULL,
  detected_at BIGINT NOT NULL,
  PRIMARY KEY (baseline_id, logical_node_id, field_id)
)` },
  { id: 'v036_restore_step', sql: `CREATE TABLE IF NOT EXISTS va_restore_step (
  restore_id BINARY(16) NOT NULL,
  logical_node_id CHAR(64) NOT NULL,
  issue_id BIGINT NOT NULL,
  started_at BIGINT NOT NULL,
  finished_at BIGINT NULL,
  success TINYINT(1) NULL,
  detail TEXT NULL,
  PRIMARY KEY (restore_id, logical_node_id)
)` },
  { id: 'v037_restore_replacement', sql: `CREATE TABLE IF NOT EXISTS va_restore_replacement (
  restore_id BINARY(16) NOT NULL,
  logical_node_id CHAR(64) NOT NULL,
  old_issue_id BIGINT NOT NULL,
  new_issue_id BIGINT NOT NULL,
  replaced_at BIGINT NOT NULL,
  PRIMARY KEY (restore_id, logical_node_id)
)` },
  { id: 'v038_restore_action', sql: `CREATE TABLE IF NOT EXISTS va_restore_action (
  restore_id BINARY(16) NOT NULL,
  step_key CHAR(64) NOT NULL,
  logical_node_id CHAR(64) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  issue_id BIGINT NULL,
  issue_key VARCHAR(32) NULL,
  state VARCHAR(16) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  started_at BIGINT NOT NULL,
  finished_at BIGINT NULL,
  detail TEXT NULL,
  PRIMARY KEY (restore_id, step_key),
  KEY idx_restore_action_state (restore_id, state, started_at)
)` },
  { id: 'v039_baseline_control_provenance', sql: `ALTER TABLE va_baseline
  ADD COLUMN required_role VARCHAR(32) NULL,
  ADD COLUMN required_assurance VARCHAR(24) NULL,
  ADD COLUMN controlled_fields_hash CHAR(64) NULL` },
  { id: 'v040_restore_progress', sql: `ALTER TABLE va_restore
  ADD COLUMN job_id VARCHAR(128) NULL,
  ADD COLUMN queued_at BIGINT NULL,
  ADD COLUMN heartbeat_at BIGINT NULL,
  ADD COLUMN total_steps INT NOT NULL DEFAULT 0,
  ADD COLUMN completed_steps INT NOT NULL DEFAULT 0,
  ADD COLUMN last_checkpoint BIGINT NULL,
  ADD COLUMN last_error TEXT NULL` },
  { id: 'v041_baseline_node_value_mediumtext', sql: `ALTER TABLE va_baseline_node_value MODIFY COLUMN chunk MEDIUMTEXT NOT NULL` },
  { id: 'v042_confluence_audit', sql: `ALTER TABLE va_audit
    ADD COLUMN product VARCHAR(32) NULL,
    ADD COLUMN content_type VARCHAR(64) NULL,
    ADD COLUMN content_id VARCHAR(128) NULL,
    ADD COLUMN container_id VARCHAR(128) NULL,
    ADD COLUMN baseline_subject_identity VARCHAR(255) NULL` },
  { id: 'v043_governance_subject', sql: `CREATE TABLE IF NOT EXISTS va_governed_subject (
    subject_id VARCHAR(128) NOT NULL, product VARCHAR(32) NOT NULL, content_type VARCHAR(64) NOT NULL,
    PRIMARY KEY (subject_id)
  )` },
  { id: 'v044_governance_policy', sql: `CREATE TABLE IF NOT EXISTS va_governance_policy (
    policy_id VARCHAR(128) NOT NULL, subject_id VARCHAR(128) NOT NULL, type VARCHAR(32) NOT NULL,
    PRIMARY KEY (policy_id)
  )` },
  { id: 'v045_scoped_role_grant', sql: `CREATE TABLE IF NOT EXISTS va_scoped_role_grant (
    grant_id VARCHAR(128) NOT NULL, space_key VARCHAR(128) NOT NULL, role VARCHAR(64) NOT NULL, account_id VARCHAR(128) NOT NULL,
    PRIMARY KEY (grant_id)
  )` },
  { id: 'v046_governance_state', sql: `CREATE TABLE IF NOT EXISTS va_governance_state (
    subject_id VARCHAR(128) NOT NULL, state VARCHAR(32) NOT NULL,
    PRIMARY KEY (subject_id)
  )` },
  { id: 'v047_governance_approval', sql: `CREATE TABLE IF NOT EXISTS va_governance_approval (
    approval_id VARCHAR(128) NOT NULL, subject_id VARCHAR(128) NOT NULL, state VARCHAR(32) NOT NULL,
    PRIMARY KEY (approval_id)
  )` },
  { id: 'v048_governance_challenge', sql: `CREATE TABLE IF NOT EXISTS va_governance_challenge (
    challenge_id VARCHAR(128) NOT NULL, approval_id VARCHAR(128) NOT NULL,
    PRIMARY KEY (challenge_id)
  )` },
  { id: 'v049_governance_baseline', sql: `CREATE TABLE IF NOT EXISTS va_governance_baseline (
    baseline_id VARCHAR(128) NOT NULL, subject_id VARCHAR(128) NOT NULL, content_hash CHAR(64) NOT NULL,
    PRIMARY KEY (baseline_id)
  )` },
  { id: 'v050_governance_node', sql: `CREATE TABLE IF NOT EXISTS va_governance_node (
    node_id VARCHAR(128) NOT NULL, baseline_id VARCHAR(128) NOT NULL,
    PRIMARY KEY (node_id)
  )` },
  { id: 'v051_governance_artifact', sql: `CREATE TABLE IF NOT EXISTS va_governance_artifact (
    artifact_id VARCHAR(128) NOT NULL, baseline_id VARCHAR(128) NOT NULL, hash CHAR(64) NOT NULL,
    PRIMARY KEY (artifact_id)
  )` },
  { id: 'v052_governance_workspace', sql: `CREATE TABLE IF NOT EXISTS va_governance_workspace (
    workspace_id VARCHAR(128) NOT NULL, subject_id VARCHAR(128) NOT NULL,
    PRIMARY KEY (workspace_id)
  )` },
  { id: 'v053_governance_operation', sql: `CREATE TABLE IF NOT EXISTS va_governance_operation (
    operation_id VARCHAR(128) NOT NULL, subject_id VARCHAR(128) NOT NULL,
    PRIMARY KEY (operation_id)
  )` },
  { id: 'v054_governance_event_receipt', sql: `CREATE TABLE IF NOT EXISTS va_governance_event_receipt (
    receipt_id VARCHAR(128) NOT NULL, event_id VARCHAR(128) NOT NULL, processed_at BIGINT NOT NULL,
    PRIMARY KEY (receipt_id)
  )` },
  { id: 'v055_va_events', sql: `CREATE TABLE IF NOT EXISTS va_events (
    id VARCHAR(128) NOT NULL,
    product VARCHAR(32) NOT NULL,
    type VARCHAR(64) NOT NULL,
    content_id VARCHAR(128) NOT NULL,
    timestamp BIGINT NOT NULL,
    PRIMARY KEY (id)
  )` },
  { id: 'v056_vault_space', sql: `CREATE TABLE IF NOT EXISTS va_vault_space (
    project_id BIGINT NOT NULL,
    space_id VARCHAR(64) NOT NULL,
    space_key VARCHAR(64) NOT NULL,
    permission_scheme_id VARCHAR(64) NULL,
    permission_locked_at BIGINT NULL,
    created_at BIGINT NOT NULL,
    created_by VARCHAR(128) NOT NULL,
    PRIMARY KEY (project_id)
  )` },
  { id: 'v057_vault_page', sql: `CREATE TABLE IF NOT EXISTS va_vault_page (
    issue_id BIGINT NOT NULL,
    project_id BIGINT NOT NULL,
    confluence_page_id VARCHAR(64) NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (issue_id)
  )` },
  { id: 'v058_vault_attachment', sql: `CREATE TABLE IF NOT EXISTS va_vault_attachment (
    id VARCHAR(32) NOT NULL,
    baseline_id VARCHAR(128) NOT NULL,
    issue_id BIGINT NOT NULL,
    jira_attachment_id VARCHAR(64) NOT NULL,
    filename VARCHAR(512) NOT NULL,
    content_hash CHAR(64) NOT NULL,
    confluence_attachment_id VARCHAR(64) NOT NULL,
    vaulted_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_vault_attachment_baseline (baseline_id, jira_attachment_id)
  )` },
  // One vault space for the whole site, not one per project: each project is a
  // page in it (va_vault_space.project_page_id). See lib/vaultConfluence.js.
  { id: 'v059_vault_site', sql: `CREATE TABLE IF NOT EXISTS va_vault_site (
    id VARCHAR(16) NOT NULL,
    space_id VARCHAR(64) NOT NULL,
    space_key VARCHAR(64) NOT NULL,
    homepage_id VARCHAR(64) NULL,
    created_at BIGINT NOT NULL,
    created_by VARCHAR(128) NOT NULL,
    PRIMARY KEY (id)
  )` },
  { id: 'v060_vault_project_page', sql: `ALTER TABLE va_vault_space ADD COLUMN project_page_id VARCHAR(64) NULL` },
  // A child's baseline captured by its parent's tree capture points at that
  // parent baseline: the child's approval IS the parent's. Null for a baseline
  // captured on the item's own controlled transition.
  { id: 'v061_baseline_captured_by', sql: `ALTER TABLE va_baseline ADD COLUMN captured_by_baseline_id BINARY(16) NULL` },
  // Publication and repair select a parent capture's child rows by this link.
  { id: 'v062_baseline_captured_by_index', sql: `ALTER TABLE va_baseline ADD INDEX idx_baseline_captured_by (captured_by_baseline_id)` },
  // A file a rejection re-uploaded from the vault gets a new Jira id. This row
  // says which original it stands for, once its bytes were checked against the
  // vault's hash, so every comparison reads it as the file that was approved.
  // Written only by the app. See lib/attachmentIdentity.js.
  { id: 'v063_attachment_alias', sql: `CREATE TABLE IF NOT EXISTS va_attachment_alias (
    attachment_id VARCHAR(64) NOT NULL,
    issue_id BIGINT NOT NULL,
    stands_for_id VARCHAR(64) NOT NULL,
    content_hash CHAR(64) NOT NULL,
    restore_ref VARCHAR(128) NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (attachment_id),
    KEY idx_attachment_alias_issue (issue_id)
  )` },
  // A restore looks up a file's vaulted copy by work item and Jira id, from
  // whichever baseline vaulted it: a Jira attachment never changes, so any copy
  // of the same id is a copy of the same bytes.
  { id: 'v064_vault_attachment_issue_index', sql: `ALTER TABLE va_vault_attachment ADD INDEX idx_vault_attachment_issue (issue_id, jira_attachment_id)` },
  // When the app's own account was granted Delete all attachments on the
  // project's scheme, so a rejection can remove a file added after approval.
  { id: 'v065_vault_app_delete_grant', sql: `ALTER TABLE va_vault_space ADD COLUMN app_delete_granted_at BIGINT NULL` },
  // A rich-text field points at an attachment by its MEDIA file id, not its
  // Jira id (probed live 2026-09-24: the download redirect names it). The vault
  // records it, so a restore knows which file each pointer in an approved
  // description needs; the alias records the restored copy's media id and the
  // original's, so the pointer can be rewritten and read back as approved.
  { id: 'v066_vault_attachment_media', sql: `ALTER TABLE va_vault_attachment ADD COLUMN media_id VARCHAR(64) NULL` },
  { id: 'v067_attachment_alias_media', sql: `ALTER TABLE va_attachment_alias
    ADD COLUMN media_id VARCHAR(64) NULL,
    ADD COLUMN stands_for_media_id VARCHAR(64) NULL` },
  // When a tree baseline's child nodes were read from Jira. Null means at its
  // own captured_at. Set on a version that re-recorded only its root's link on
  // another issue's approval (jobs/linkWorker.js): its children were copied
  // from the version before, and still own their content from that capture.
  { id: 'v068_baseline_nodes_captured_at', sql: `ALTER TABLE va_baseline ADD COLUMN nodes_captured_at BIGINT NULL` },
  // A link decision queued for this issue's record and not yet recorded
  // (db/linkPendingStore.js): lets its panel and the validator say so.
  { id: 'v069_link_pending', sql: `CREATE TABLE IF NOT EXISTS va_link_pending (
    issue_id BIGINT NOT NULL,
    decided_on_issue_id BIGINT NOT NULL,
    decided_on_key VARCHAR(64) NOT NULL,
    queued_at BIGINT NOT NULL,
    PRIMARY KEY (issue_id, decided_on_issue_id)
  )` },
  // When Jira last REFUSED the app's own attachment-delete grant. The hourly
  // backfill otherwise retried a refused grant every hour for ever; with this
  // it asks again once a day (db/vaultStore.js projectsNeedingVault).
  { id: 'v070_vault_space_app_delete_check', sql: `ALTER TABLE va_vault_space ADD COLUMN app_delete_checked_at BIGINT NULL` },
  // THE VAULT HAS TWO HOMES. A site with Confluence keeps copies in its private
  // vault space; a Jira-only site keeps them in the Forge Object Store
  // (lib/vaultTier.js). A copy records where it went, so a restore reads it
  // back from there: `storage` is CONFLUENCE or OBJECT_STORE, and an Object
  // Store copy has an `object_key` and no Confluence attachment. Rows written
  // before this are Confluence copies, which the default says.
  { id: 'v071_vault_attachment_confluence_optional', sql: `ALTER TABLE va_vault_attachment MODIFY COLUMN confluence_attachment_id VARCHAR(64) NULL` },
  { id: 'v072_vault_attachment_storage', sql: `ALTER TABLE va_vault_attachment
    ADD COLUMN storage VARCHAR(16) NOT NULL DEFAULT 'CONFLUENCE',
    ADD COLUMN object_key VARCHAR(191) NULL` },
  // A project on a Jira-only site has no vault space, but still needs its row:
  // the app's attachment-delete grant and the lockdown are recorded on it.
  { id: 'v073_vault_space_id_optional', sql: `ALTER TABLE va_vault_space MODIFY COLUMN space_id VARCHAR(64) NULL` },
  { id: 'v074_vault_space_key_optional', sql: `ALTER TABLE va_vault_space MODIFY COLUMN space_key VARCHAR(64) NULL` },
  { id: 'v075_baseline_field', sql: `CREATE TABLE IF NOT EXISTS va_baseline_field (
    baseline_id BINARY(16) NOT NULL,
    field_id VARCHAR(64) NOT NULL,
    label VARCHAR(255) NOT NULL,
    kind VARCHAR(24) NOT NULL,
    schema_type VARCHAR(48) NULL,
    severity VARCHAR(16) NOT NULL,
    store_values BOOLEAN NOT NULL,
    restorable BOOLEAN NOT NULL,
    digest CHAR(64) NOT NULL,
    required_by TEXT NOT NULL,
    PRIMARY KEY (baseline_id, field_id)
  )` },
  { id: 'v076_baseline_rule', sql: `CREATE TABLE IF NOT EXISTS va_baseline_rule (
    baseline_id BINARY(16) NOT NULL,
    rule_key VARCHAR(64) NOT NULL,
    project_id BIGINT NOT NULL,
    issue_type_id VARCHAR(32) NOT NULL,
    transition_id VARCHAR(32) NULL,
    role VARCHAR(32) NOT NULL,
    assurance VARCHAR(24) NOT NULL,
    controlled_fields_hash CHAR(64) NULL,
    imposed_by_baseline_id BINARY(16) NULL,
    PRIMARY KEY (baseline_id, rule_key)
  )` },
  { id: 'v077_baseline_signature', sql: `CREATE TABLE IF NOT EXISTS va_baseline_signature (
    baseline_id BINARY(16) NOT NULL,
    approval_id BINARY(16) NOT NULL,
    signer_account_id VARCHAR(128) NOT NULL,
    signer_name VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL,
    assurance VARCHAR(24) NOT NULL,
    from_status_id VARCHAR(32) NULL,
    to_status_id VARCHAR(32) NULL,
    fields_covered TEXT NOT NULL,
    cause VARCHAR(32) NOT NULL,
    PRIMARY KEY (baseline_id, approval_id)
  )` },
  { id: 'v078_baseline_node_child', sql: `ALTER TABLE va_baseline_node
    ADD COLUMN child_baseline_id BINARY(16) NULL,
    ADD COLUMN child_version INT NULL` },
  { id: 'v079_baseline_link', sql: `CREATE TABLE IF NOT EXISTS va_baseline_link (
    baseline_id BINARY(16) NOT NULL,
    link_id VARCHAR(64) NOT NULL,
    link_type VARCHAR(64) NOT NULL,
    direction VARCHAR(16) NOT NULL,
    other_issue_id BIGINT NOT NULL,
    other_issue_key VARCHAR(32) NOT NULL,
    other_baseline_id BINARY(16) NULL,
    other_baseline_version INT NULL,
    PRIMARY KEY (baseline_id, link_id)
  )` },
  { id: 'v080_baseline_policy_recorded', sql: `ALTER TABLE va_baseline ADD COLUMN policy_recorded BOOLEAN NOT NULL DEFAULT FALSE` },
  { id: 'v081_capture_lease', sql: `CREATE TABLE IF NOT EXISTS va_capture_lease (
    issue_id BIGINT NOT NULL,
    holder VARCHAR(128) NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (issue_id)
  )` },
  { id: 'v082_drift_observations', sql: `ALTER TABLE va_drift
    ADD COLUMN observed_at BIGINT NULL,
    ADD COLUMN trigger_kind VARCHAR(32) NULL,
    ADD COLUMN trigger_account_id VARCHAR(128) NULL,
    ADD COLUMN edit_status VARCHAR(32) NULL,
    ADD COLUMN editor_account_id VARCHAR(128) NULL,
    ADD COLUMN edited_at BIGINT NULL,
    ADD COLUMN decision_id VARCHAR(128) NULL` },
  { id: 'v083_decisions', sql: `CREATE TABLE IF NOT EXISTS va_decision (
    decision_id VARCHAR(128) NOT NULL,
    issue_id BIGINT NOT NULL,
    scope VARCHAR(16) NOT NULL,
    state VARCHAR(32) NOT NULL,
    covered_issues TEXT NULL,
    covered_baselines TEXT NULL,
    PRIMARY KEY (decision_id)
  )` },
  { id: 'v084_decision_group', sql: `CREATE TABLE IF NOT EXISTS va_decision_group (
    decision_id VARCHAR(128) NOT NULL,
    group_id VARCHAR(128) NOT NULL,
    covered_issues TEXT NOT NULL,
    covered_fields TEXT NOT NULL,
    roles TEXT NOT NULL,
    required_assurance VARCHAR(32) NOT NULL,
    evidence_hash CHAR(64) NOT NULL,
    PRIMARY KEY (decision_id, group_id)
  )` },
  { id: 'v085_decision_signature', sql: `CREATE TABLE IF NOT EXISTS va_decision_signature (
    decision_id VARCHAR(128) NOT NULL,
    group_id VARCHAR(128) NOT NULL,
    approval_id BINARY(16) NOT NULL,
    role VARCHAR(64) NOT NULL,
    decision VARCHAR(16) NOT NULL,
    PRIMARY KEY (decision_id, group_id, role)
  )` },
  { id: 'v086_security_level', sql: `ALTER TABLE va_baseline_node ADD COLUMN security_level_id VARCHAR(64) NULL` },
  { id: 'v087_baseline_cause', sql: `ALTER TABLE va_baseline ADD COLUMN cause VARCHAR(32) NULL` },
  // ── THE BASELINE EVIDENCE MODEL (docs/specs/2026-10-03-baseline-evidence-model-design.md §4, §9.1) ──
  // v075–v087 were an early draft of these tables and may already have run on a
  // site. Nothing ever wrote to the draft tables, so they are replaced, not
  // altered: dropped, then created in the spec's shape. Never edit v075–v087.
  { id: 'v088_drop_draft_baseline_field', sql: `DROP TABLE IF EXISTS va_baseline_field` },
  // One field as it was signed. History is displayed from these rows, never
  // from today's va_controlled_field.
  { id: 'v089_baseline_field', sql: `CREATE TABLE IF NOT EXISTS va_baseline_field (
    baseline_id BINARY(16) NOT NULL,
    field_id VARCHAR(64) NOT NULL,
    label VARCHAR(255) NOT NULL,
    label_source VARCHAR(16) NOT NULL,
    kind VARCHAR(24) NOT NULL,
    schema_type VARCHAR(48) NULL,
    materiality VARCHAR(16) NOT NULL,
    store_values BOOLEAN NOT NULL,
    restorable BOOLEAN NULL,
    digest CHAR(64) NOT NULL,
    required_by TEXT NOT NULL,
    PRIMARY KEY (baseline_id, field_id)
  )` },
  { id: 'v090_drop_draft_baseline_rule', sql: `DROP TABLE IF EXISTS va_baseline_rule` },
  // One rule covering a version: its own, or inherited from the ancestor
  // version named here. `approvers` is a JSON set of {role, assurance}.
  { id: 'v091_baseline_rule', sql: `CREATE TABLE IF NOT EXISTS va_baseline_rule (
    baseline_id BINARY(16) NOT NULL,
    rule_key CHAR(32) NOT NULL,
    source VARCHAR(16) NOT NULL,
    project_id BIGINT NOT NULL,
    issue_type_id VARCHAR(32) NOT NULL,
    transition_id VARCHAR(32) NULL,
    approvers TEXT NOT NULL,
    controlled_fields_hash CHAR(64) NULL,
    imposed_by_baseline_id BINARY(16) NULL,
    imposed_by_version INT NULL,
    PRIMARY KEY (baseline_id, rule_key)
  )` },
  { id: 'v092_drop_draft_baseline_signature', sql: `DROP TABLE IF EXISTS va_baseline_signature` },
  // One signed act on a version, with the stage it happened at. A second
  // signature on an unchanged version is a second row, never an update.
  { id: 'v093_baseline_signature', sql: `CREATE TABLE IF NOT EXISTS va_baseline_signature (
    baseline_id BINARY(16) NOT NULL,
    approval_id BINARY(16) NOT NULL,
    signer_account_id VARCHAR(128) NOT NULL,
    signer_name VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL,
    assurance VARCHAR(24) NOT NULL,
    cause VARCHAR(32) NOT NULL,
    cause_baseline_id BINARY(16) NULL,
    decision_id BINARY(16) NULL,
    transition_id VARCHAR(32) NULL,
    from_status_id VARCHAR(32) NULL,
    to_status_id VARCHAR(32) NULL,
    transition_at BIGINT NULL,
    status_at_capture VARCHAR(32) NULL,
    fields_covered TEXT NOT NULL,
    signed_at BIGINT NOT NULL,
    PRIMARY KEY (baseline_id, approval_id)
  )` },
  // The editor of a confirmed edit stays in actor_account_id/actor_name (§7.1);
  // the draft's separate column would let two columns disagree.
  { id: 'v094_drift_drop_draft_editor', sql: `ALTER TABLE va_drift DROP COLUMN IF EXISTS editor_account_id` },
  // The draft typed decision_id as text; every id in this schema is BINARY(16).
  { id: 'v095_drift_drop_draft_decision', sql: `ALTER TABLE va_drift DROP COLUMN IF EXISTS decision_id` },
  { id: 'v096_drift_decision', sql: `ALTER TABLE va_drift ADD COLUMN IF NOT EXISTS decision_id BINARY(16) NULL` },
  // Observations are read and settled by the version they were recorded against.
  { id: 'v097_drift_by_baseline', sql: `ALTER TABLE va_drift ADD INDEX IF NOT EXISTS idx_drift_baseline (baseline_id, field_id)` },
  { id: 'v098_drop_draft_decision', sql: `DROP TABLE IF EXISTS va_decision` },
  { id: 'v099_drop_draft_decision_group', sql: `DROP TABLE IF EXISTS va_decision_group` },
  { id: 'v100_drop_draft_decision_signature', sql: `DROP TABLE IF EXISTS va_decision_signature` },
  { id: 'v101_decision', sql: `CREATE TABLE IF NOT EXISTS va_decision (
    decision_id BINARY(16) NOT NULL,
    opened_on_issue_id BIGINT NOT NULL,
    scope VARCHAR(16) NOT NULL,
    state VARCHAR(16) NOT NULL,
    covers TEXT NOT NULL,
    opened_by VARCHAR(128) NOT NULL,
    opened_at BIGINT NOT NULL,
    PRIMARY KEY (decision_id),
    KEY idx_decision_issue (opened_on_issue_id, state)
  )` },
  // A group's evidence hash is computed from live digests when needed; each
  // signature stores the hash it signed (v103).
  { id: 'v102_decision_group', sql: `CREATE TABLE IF NOT EXISTS va_decision_group (
    decision_id BINARY(16) NOT NULL,
    group_key CHAR(64) NOT NULL,
    covers TEXT NOT NULL,
    roles TEXT NOT NULL,
    required_assurance VARCHAR(24) NOT NULL,
    PRIMARY KEY (decision_id, group_key)
  )` },
  { id: 'v103_decision_signature', sql: `CREATE TABLE IF NOT EXISTS va_decision_signature (
    decision_id BINARY(16) NOT NULL,
    group_key CHAR(64) NOT NULL,
    approval_id BINARY(16) NOT NULL,
    role VARCHAR(32) NOT NULL,
    outcome VARCHAR(16) NOT NULL,
    evidence_hash CHAR(64) NOT NULL,
    signed_at BIGINT NOT NULL,
    PRIMARY KEY (decision_id, group_key, approval_id)
  )` },
  { id: 'v104_capture_lease_acquired', sql: `ALTER TABLE va_capture_lease ADD COLUMN IF NOT EXISTS acquired_at BIGINT NULL` },
  // Set only by the step-2 job on a child version materialised from its
  // parent's stored node: when that content was read, not when it was written.
  { id: 'v105_baseline_content_as_of', sql: `ALTER TABLE va_baseline ADD COLUMN IF NOT EXISTS content_as_of BIGINT NULL` },
  // "Did a parent's restore write to THIS item?" is asked on every panel
  // paint; the table is otherwise only keyed by restore.
  { id: 'v106_restore_action_issue_index', sql: `ALTER TABLE va_restore_action ADD INDEX IF NOT EXISTS idx_restore_action_issue (issue_id, state)` },
  // A mixed drift decision records exactly which fields were approved and which
  // rejected. NULL on every whole-set approval, which are unchanged.
  { id: 'v107_approval_decision_map', sql: `ALTER TABLE va_approval
    ADD COLUMN IF NOT EXISTS decision_map TEXT NULL,
    ADD COLUMN IF NOT EXISTS decision_map_hash CHAR(64) NULL` },
  // Remove all Confluence governance and vault tables and columns. Forge Object
  // Store is the only attachment vault.
  { id: 'v108_remove_confluence', sql: `DROP TABLE IF EXISTS
    va_governed_subject, va_governance_policy, va_governance_state, va_governance_approval,
    va_governance_challenge, va_governance_baseline, va_governance_node, va_governance_artifact,
    va_governance_workspace, va_governance_operation, va_governance_event_receipt, va_events,
    va_vault_site, va_vault_page;
    ALTER TABLE va_vault_space DROP COLUMN IF EXISTS space_id;
    ALTER TABLE va_vault_space DROP COLUMN IF EXISTS space_key;
    ALTER TABLE va_vault_space DROP COLUMN IF EXISTS project_page_id;
    DELETE FROM va_config WHERE cfg_key = 'vault:tier'` },
  // ── Test management (spec 2026-10-20-test-management-first-design.md) ──
  // One row per enabled project: which Jira types are tests, executions and
  // bugs, and the two sign-off chains the client configured.
  { id: 'v109_tm_project', sql: `CREATE TABLE IF NOT EXISTS tm_project (
    project_id BIGINT NOT NULL,
    enabled TINYINT NOT NULL DEFAULT 0,
    test_type_id VARCHAR(32) NOT NULL,
    execution_type_id VARCHAR(32) NOT NULL,
    plan_type_id VARCHAR(32) NULL,
    defect_type_id VARCHAR(32) NOT NULL,
    link_type_name VARCHAR(255) NOT NULL,
    run_chain TEXT NOT NULL,
    version_chain TEXT NOT NULL,
    revision INT NOT NULL DEFAULT 1,
    updated_at BIGINT NOT NULL,
    updated_by VARCHAR(128) NOT NULL,
    PRIMARY KEY (project_id)
  )` },
  // A test's working copy. Free to edit; never executed for the record.
  { id: 'v110_tm_test_draft', sql: `CREATE TABLE IF NOT EXISTS tm_test_draft (
    test_issue_id BIGINT NOT NULL,
    project_id BIGINT NOT NULL,
    content MEDIUMTEXT NOT NULL,
    revision INT NOT NULL DEFAULT 1,
    updated_at BIGINT NOT NULL,
    updated_by VARCHAR(128) NOT NULL,
    PRIMARY KEY (test_issue_id)
  )` },
  // A published version is frozen: content and digest never change after the
  // insert. Only its state moves, PUBLISHED → SIGNED or REJECTED.
  { id: 'v111_tm_test_version', sql: `CREATE TABLE IF NOT EXISTS tm_test_version (
    version_id CHAR(32) NOT NULL,
    test_issue_id BIGINT NOT NULL,
    project_id BIGINT NOT NULL,
    version_no INT NOT NULL,
    content MEDIUMTEXT NOT NULL,
    digest CHAR(64) NOT NULL,
    chain TEXT NOT NULL,
    chain_digest CHAR(64) NOT NULL,
    state VARCHAR(16) NOT NULL,
    published_by VARCHAR(128) NOT NULL,
    published_at BIGINT NOT NULL,
    signed_at BIGINT NULL,
    PRIMARY KEY (version_id),
    UNIQUE KEY uq_tm_version_no (test_issue_id, version_no),
    KEY idx_tm_version_state (test_issue_id, state)
  )` },
  // One run of one signed test version inside a Test Execution issue.
  { id: 'v112_tm_run', sql: `CREATE TABLE IF NOT EXISTS tm_run (
    run_id CHAR(32) NOT NULL,
    execution_issue_id BIGINT NOT NULL,
    project_id BIGINT NOT NULL,
    test_issue_id BIGINT NOT NULL,
    test_version_id CHAR(32) NOT NULL,
    test_digest CHAR(64) NOT NULL,
    environment VARCHAR(255) NOT NULL,
    configuration VARCHAR(255) NOT NULL,
    release_id VARCHAR(32) NULL,
    release_name VARCHAR(255) NULL,
    chain TEXT NOT NULL,
    chain_digest CHAR(64) NOT NULL,
    state VARCHAR(16) NOT NULL,
    result VARCHAR(16) NOT NULL,
    steps MEDIUMTEXT NOT NULL,
    revision INT NOT NULL DEFAULT 1,
    frozen_digest CHAR(64) NULL,
    retest_of CHAR(32) NULL,
    created_by VARCHAR(128) NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (run_id),
    KEY idx_tm_run_execution (execution_issue_id, created_at),
    KEY idx_tm_run_test (test_issue_id, state)
  )` },
  // Every test-management signature. The key makes each chain step signable
  // exactly once; a second insert for the same step is refused by the database.
  { id: 'v113_tm_signature', sql: `CREATE TABLE IF NOT EXISTS tm_signature (
    subject_kind VARCHAR(24) NOT NULL,
    subject_id CHAR(32) NOT NULL,
    step_index INT NOT NULL,
    account_id VARCHAR(128) NOT NULL,
    printed_name VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL,
    label VARCHAR(64) NOT NULL,
    meaning VARCHAR(255) NOT NULL,
    decision VARCHAR(16) NOT NULL,
    reason TEXT NULL,
    content_hash CHAR(64) NOT NULL,
    assurance_level VARCHAR(24) NOT NULL,
    signed_at BIGINT NOT NULL,
    PRIMARY KEY (subject_kind, subject_id, step_index)
  )` },
  // The one automatic bug per failed run. The row is written BEFORE Jira is
  // called, so a timeout can be reconciled instead of retried blind.
  { id: 'v114_tm_bug', sql: `CREATE TABLE IF NOT EXISTS tm_bug (
    run_id CHAR(32) NOT NULL,
    project_id BIGINT NOT NULL,
    parent_issue_id BIGINT NULL,
    marker VARCHAR(64) NOT NULL,
    state VARCHAR(16) NOT NULL,
    issue_id BIGINT NULL,
    issue_key VARCHAR(64) NULL,
    attempts INT NOT NULL DEFAULT 0,
    last_error VARCHAR(255) NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (run_id),
    KEY idx_tm_bug_issue (issue_id),
    KEY idx_tm_bug_state (project_id, state)
  )` },
  { id: 'v115_tm_signature_durability', sql: `ALTER TABLE tm_signature
    ADD COLUMN IF NOT EXISTS state VARCHAR(16) NOT NULL DEFAULT 'LEGACY',
    ADD COLUMN IF NOT EXISTS audit_event_id CHAR(32) NULL,
    ADD COLUMN IF NOT EXISTS audit_seq BIGINT NULL,
    ADD COLUMN IF NOT EXISTS audit_hash CHAR(64) NULL` },
  // Old rows count only if their exact signer, subject, step and content can
  // be matched to an existing ledger event. Unmatched legacy rows fail closed.
  { id: 'v116_tm_signature_legacy_proof', sql: `UPDATE tm_signature s JOIN va_audit a
    ON a.actor_account_id = s.account_id
      AND a.event_type IN ('TM_SIGNED', 'TM_REJECTED', 'TM_NOT_EXECUTED')
      AND JSON_UNQUOTE(JSON_EXTRACT(a.payload, '$.kind')) = s.subject_kind
      AND JSON_UNQUOTE(JSON_EXTRACT(a.payload, '$.subjectId')) = s.subject_id
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(a.payload, '$.stepIndex')) AS UNSIGNED) = s.step_index
      AND JSON_UNQUOTE(JSON_EXTRACT(a.payload, '$.contentHash')) = s.content_hash
    SET s.state = 'ACTIVE', s.audit_seq = a.seq, s.audit_hash = a.entry_hash
    WHERE s.state = 'LEGACY'` },
  { id: 'v117_tm_run_snapshots', sql: `ALTER TABLE tm_run
    ADD COLUMN IF NOT EXISTS resolved_steps MEDIUMTEXT NULL,
    ADD COLUMN IF NOT EXISTS iterations MEDIUMTEXT NULL,
    ADD COLUMN IF NOT EXISTS planning_snapshot MEDIUMTEXT NULL,
    ADD COLUMN IF NOT EXISTS creation_key CHAR(64) NULL,
    ADD COLUMN IF NOT EXISTS creation_fingerprint CHAR(64) NULL,
    ADD COLUMN IF NOT EXISTS creation_event_id CHAR(32) NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_tm_run_creation ON tm_run (creation_key)` },
  ...BUG_MIGRATIONS,
  ...PLANNING_MIGRATIONS.map((migration, index) => ({ ...migration,
    id: `v${119 + index}_${migration.id.replace(/^tm-planning-/, 'tm_').replaceAll('-', '_')}` })),
  ...REPORT_MIGRATIONS,
  { id: 'v127_tm_version_publication', sql: 'ALTER TABLE tm_test_version ADD COLUMN IF NOT EXISTS publish_event_id CHAR(32) NULL' },
  { id: 'v128_tm_audit_event_lookup', sql: 'CREATE INDEX IF NOT EXISTS idx_tm_audit_event ON va_audit (event_id)' },
  ...RETEST_MIGRATIONS.map((migration, index) => ({ ...migration, id: `v${129 + index}_${migration.id.replaceAll('-', '_')}` })),
  ...SOURCE_LINK_MIGRATIONS,
  ...BASELINE_LINK_POLICY_MIGRATIONS,
  // Authors never sign their own test version or plan revision (testmgmt/authorship.js).
  { id: 'v137_tm_draft_editors', sql: 'ALTER TABLE tm_test_draft ADD COLUMN IF NOT EXISTS editors TEXT NULL' },
  { id: 'v138_tm_version_authors', sql: 'ALTER TABLE tm_test_version ADD COLUMN IF NOT EXISTS authors TEXT NULL' },
  { id: 'v139_tm_collection_draft_editors', sql: 'ALTER TABLE tm_collection_draft ADD COLUMN IF NOT EXISTS editors TEXT NULL' },
  { id: 'v140_tm_collection_revision_authors', sql: 'ALTER TABLE tm_collection_revision ADD COLUMN IF NOT EXISTS authors TEXT NULL' },
  // A step-result change is effective only with its audit entry (usecases/testExecution.js#saveSteps).
  { id: 'v141_tm_run_step_event', sql: 'ALTER TABLE tm_run ADD COLUMN IF NOT EXISTS step_event_id CHAR(32) NULL' },
  { id: 'v142_tm_run_step_prior', sql: 'ALTER TABLE tm_run ADD COLUMN IF NOT EXISTS step_prior MEDIUMTEXT NULL' }
];
