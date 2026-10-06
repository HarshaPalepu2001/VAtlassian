# Baseline Evidence Model, Step 1: Schema and Evidence Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every new baseline version records its field definitions, the rule that required them, its signature and its links, and cannot become ACTIVE without them. Every drift observation records how much is known about it. What any reader shows stays the same.

**Architecture:** This is rollout step 1 of the spec (§9.5). It has three parts:

- The draft tables are reshaped to the spec by append-only migrations.
- A pure builder (`lib/evidence/versionEvidence.js`) turns what a capture already knows into rows. A store (`db/evidenceStore.js`) writes them, batched, while the version is still CAPTURING.
- Publication gains `AND policy_recorded = TRUE` for every new capture.

Readers (panel, validator, collector comparison, restore) are not touched. They switch over in step 4.

**Tech Stack:** Node 20 ESM, Forge SQL (MySQL/TiDB dialect, no transactions), `node:test`, `@forge/events` for retries.

**Spec:** `docs/specs/2026-10-03-baseline-evidence-model-design.md` (approved 2026-10-03). Sections used: §4 data model, §5.4 tree hash/pins, §7.1 observations, §9.1 schema, §9.5 step 1.

## Global Constraints

- **Before Task 1, make sure nothing else is editing this working tree.** Another writer added draft files there on 2026-10-03, between 16:23 and 16:32 IST.
- **The working tree holds a large amount of unrelated uncommitted work, and `test/drift-store.test.js` is staged by someone else.**
  - Commit only the paths a task names, with `git add <paths>` and then `git commit -m "<msg>" -- <paths>`.
  - Never use `git add -A`, `git add .` or `git commit -a`.
  - Never modify `test/drift-store.test.js`.
- **Commit messages:** conventional (`feat(scope): …`, `fix(scope): …`). **No `Co-Authored-By` and no "Generated with" lines** (standing user rule).
- **Migrations are append-only.** Never edit or remove `v001`–`v087`: v075–v087 may already have run on mgtechdemo. New migrations start at `v088`.
- **Forge SQL:**
  - There are no transactions.
  - BINARY(16) ids go in as `FROM_BASE64(?)` with `toBinaryParam(...)`, and come out as `TO_BASE64(col) AS col` with `fromBinaryColumn(...)` (`src/lib/db.js`).
  - Multi-row inserts take at most 50 rows per statement.
- **A governed refusal throws `new FailClosed(reason)`** (`src/lib/errors.js`), never a plain `Error`.
- **Vocabularies:**
  - materiality from `src/lib/materiality.js` (`CRITICAL`, `MAJOR`, `MINOR`, `COSMETIC`);
  - assurance from `src/lib/approval/levels.js`;
  - field kinds from `FIELD_KIND` in `src/lib/content.js`.
- **Readers are unchanged in this plan.** No change to what the panel, validator, drift comparison, restore or exports read or show.
- **Tests:**
  - one file: `node --test test/<file>.test.js`;
  - all: `npm test`. At plan time this was 1598 tests passing.
- **Deploy happens only in Task 10.** Tasks 2 and 3 must ship together: v094 drops a column that the draft `recordDrift` still writes.

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrations.js` (modify) | v088–v105: reshape the draft tables to the spec |
| `src/lib/observation.js` (create) | Edit-status vocabulary and the provenance columns of one observation (pure) |
| `src/db/driftStore.js` (modify) | Writes and reads the provenance columns, survives the gap between deploy and migration, `toObservation` |
| `src/lib/collect.js` (modify) | Passes provenance columns into `recordDrift` |
| `src/lib/evidence/versionEvidence.js` (create) | Pure: field, rule, signature and link rows for one version; the derived-version variant |
| `src/db/evidenceStore.js` (create) | Batched writes and reads of evidence rows, child pins, node security levels, `SCHEMA_PENDING` |
| `src/lib/errors.js` (modify) | `DENY.SCHEMA_PENDING` |
| `src/triggers/retry.js` (modify) | A larger retry budget for `SCHEMA_PENDING` |
| `src/lib/tree/nodeFields.js` (modify) | `fieldScope()`: the fields **and** the rule scope they came from |
| `src/db/baselineStore.js` (modify) | `writeBaseline` writes evidence before publishing and can require it |
| `src/db/baselineTreeStore.js`, `src/db/childBaselineStore.js` (modify) | Publication can require evidence |
| `src/lib/capture.js` (modify) | Flat and tree captures build and write evidence |
| `src/usecases/panelAccess.js`, `src/usecases/drift.js` (modify) | Pass the rule scope and the cause into captures |
| `src/db/derivedBaselineStore.js`, `src/jobs/linkWorker.js`, `src/lib/approval/linkPropagation.js` (modify) | Link records carry evidence |

---

### Task 1: Remove the draft lease store and rule resolver

These two untracked files were written outside the spec and are not imported anywhere. `leaseStore.js` imports a module that doesn't exist (`./db.js`). `ruleResolver.js` uses a severity scale this app doesn't have. Steps 3 and 4 rebuild both from the spec.

**Files:**
- Delete: `src/db/leaseStore.js`, `src/lib/tree/ruleResolver.js`

**Interfaces:** none.

- [ ] **Step 1: Confirm nothing imports them**

Run: `grep -rn "leaseStore\|ruleResolver" src test frontend/src`
Expected: no output.

- [ ] **Step 2: Delete them**

Run: `rm src/db/leaseStore.js src/lib/tree/ruleResolver.js`

- [ ] **Step 3: Run the suite**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`.

- [ ] **Step 4: No commit.** Both files were untracked, so git has nothing to record.

---

### Task 2: Reshape the evidence tables to the spec (v088–v105)

Nothing has ever written to the draft tables, so they are dropped and recreated rather than altered. Draft columns on existing tables (`va_drift`) are dropped and re-added in the right type.

**Files:**
- Modify: `src/db/migrations.js` (append after `v087_baseline_cause`)
- Modify: `test/migrations.test.js` (replace the test named `'v075-v080 section 1 data model'`)

**Interfaces:**
- Produces these tables and columns, used by every later task:
  - `va_baseline_field(baseline_id, field_id, label, label_source, kind, schema_type, materiality, store_values, restorable, digest, required_by)`
  - `va_baseline_rule(baseline_id, rule_key CHAR(32), source, project_id, issue_type_id, transition_id, approvers, controlled_fields_hash, imposed_by_baseline_id, imposed_by_version)`
  - `va_baseline_signature(baseline_id, approval_id, signer_account_id, signer_name, role, assurance, cause, cause_baseline_id, decision_id, transition_id, from_status_id, to_status_id, transition_at, status_at_capture, fields_covered, signed_at)`
  - `va_baseline_link` stays as v079 created it: `(baseline_id, link_id, link_type, direction, other_issue_id, other_issue_key, other_baseline_id, other_baseline_version)`
  - `va_drift` gains `observed_at, trigger_kind, trigger_account_id, edit_status, edited_at` (from v082) and `decision_id BINARY(16)`; `editor_account_id` is removed
  - `va_baseline.policy_recorded`, `va_baseline.cause`, `va_baseline.content_as_of`
  - `va_baseline_node.child_baseline_id`, `child_version`, `security_level_id`
  - `va_decision`, `va_decision_group`, `va_decision_signature` (used in step 5)
  - `va_capture_lease.acquired_at` (used in step 3)

- [ ] **Step 1: Write the failing tests**

In `test/migrations.test.js`, replace the whole `test('v075-v080 section 1 data model', …)` block with:

```js
test('v075-v087 stay in the list: they may already have run on a site', () => {
  for (const id of ['v075_baseline_field', 'v076_baseline_rule', 'v077_baseline_signature',
    'v078_baseline_node_child', 'v079_baseline_link', 'v080_baseline_policy_recorded', 'v081_capture_lease',
    'v082_drift_observations', 'v083_decisions', 'v084_decision_group', 'v085_decision_signature',
    'v086_security_level', 'v087_baseline_cause']) {
    assert.ok(sqlFor(id), id);
  }
});

test('migration ids are unique and the list ends at v105', () => {
  const ids = MIGRATIONS.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(MIGRATIONS.at(-1).id, 'v105_baseline_content_as_of');
});

test('v088-v093 replace the draft field, rule and signature tables with the spec shape', () => {
  assert.match(sqlFor('v088_drop_draft_baseline_field'), /^DROP TABLE IF EXISTS va_baseline_field$/);
  const field = sqlFor('v089_baseline_field');
  for (const column of ['label_source VARCHAR\\(16\\) NOT NULL', 'materiality VARCHAR\\(16\\) NOT NULL',
    'restorable BOOLEAN NULL', 'digest CHAR\\(64\\) NOT NULL', 'required_by TEXT NOT NULL']) {
    assert.match(field, new RegExp(column), column);
  }
  assert.doesNotMatch(field, /severity/);
  assert.match(field, /PRIMARY KEY \(baseline_id, field_id\)/);

  assert.match(sqlFor('v090_drop_draft_baseline_rule'), /^DROP TABLE IF EXISTS va_baseline_rule$/);
  const rule = sqlFor('v091_baseline_rule');
  for (const column of ['rule_key CHAR\\(32\\) NOT NULL', 'source VARCHAR\\(16\\) NOT NULL', 'approvers TEXT NOT NULL',
    'imposed_by_baseline_id BINARY\\(16\\) NULL', 'imposed_by_version INT NULL']) {
    assert.match(rule, new RegExp(column), column);
  }
  assert.doesNotMatch(rule, /\brole VARCHAR/, 'a rule holds a set of approvers, not one role');

  assert.match(sqlFor('v092_drop_draft_baseline_signature'), /^DROP TABLE IF EXISTS va_baseline_signature$/);
  const signature = sqlFor('v093_baseline_signature');
  for (const column of ['cause_baseline_id BINARY\\(16\\) NULL', 'decision_id BINARY\\(16\\) NULL',
    'transition_id VARCHAR\\(32\\) NULL', 'transition_at BIGINT NULL', 'status_at_capture VARCHAR\\(32\\) NULL',
    'signed_at BIGINT NOT NULL']) {
    assert.match(signature, new RegExp(column), column);
  }
  assert.match(signature, /PRIMARY KEY \(baseline_id, approval_id\)/);
});

test('v094-v097 put the drift observation columns in the spec shape', () => {
  assert.match(sqlFor('v094_drift_drop_draft_editor'), /ALTER TABLE va_drift DROP COLUMN editor_account_id/);
  assert.match(sqlFor('v095_drift_drop_draft_decision'), /ALTER TABLE va_drift DROP COLUMN decision_id/);
  assert.match(sqlFor('v096_drift_decision'), /ALTER TABLE va_drift ADD COLUMN decision_id BINARY\(16\) NULL/);
  assert.match(sqlFor('v097_drift_by_baseline'), /ADD INDEX idx_drift_baseline \(baseline_id, field_id\)/);
});

test('v098-v103 replace the draft decision tables; a signature is appended, never overwritten', () => {
  for (const id of ['v098_drop_draft_decision', 'v099_drop_draft_decision_group', 'v100_drop_draft_decision_signature']) {
    assert.match(sqlFor(id), /^DROP TABLE IF EXISTS va_decision/);
  }
  assert.match(sqlFor('v101_decision'), /decision_id BINARY\(16\) NOT NULL/);
  assert.doesNotMatch(sqlFor('v102_decision_group'), /evidence_hash/, 'a group\'s evidence is computed, not stored');
  const signature = sqlFor('v103_decision_signature');
  assert.match(signature, /PRIMARY KEY \(decision_id, group_key, approval_id\)/);
  assert.match(signature, /evidence_hash CHAR\(64\) NOT NULL/);
});

test('v104-v105 add the lease acquisition time and a migrated version\'s content time', () => {
  assert.match(sqlFor('v104_capture_lease_acquired'), /ALTER TABLE va_capture_lease ADD COLUMN acquired_at BIGINT NULL/);
  assert.match(sqlFor('v105_baseline_content_as_of'), /ALTER TABLE va_baseline ADD COLUMN content_as_of BIGINT NULL/);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/migrations.test.js`
Expected: FAIL with `Migration v088_drop_draft_baseline_field not found` (and similar).

- [ ] **Step 3: Append the migrations**

In `src/db/migrations.js`, replace the final entry and closing bracket:

```js
  { id: 'v087_baseline_cause', sql: `ALTER TABLE va_baseline ADD COLUMN cause VARCHAR(32) NULL` }
];
```

with:

```js
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
  { id: 'v094_drift_drop_draft_editor', sql: `ALTER TABLE va_drift DROP COLUMN editor_account_id` },
  // The draft typed decision_id as text; every id in this schema is BINARY(16).
  { id: 'v095_drift_drop_draft_decision', sql: `ALTER TABLE va_drift DROP COLUMN decision_id` },
  { id: 'v096_drift_decision', sql: `ALTER TABLE va_drift ADD COLUMN decision_id BINARY(16) NULL` },
  // Observations are read and settled by the version they were recorded against.
  { id: 'v097_drift_by_baseline', sql: `ALTER TABLE va_drift ADD INDEX idx_drift_baseline (baseline_id, field_id)` },
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
  { id: 'v104_capture_lease_acquired', sql: `ALTER TABLE va_capture_lease ADD COLUMN acquired_at BIGINT NULL` },
  // Set only by the step-2 job on a child version materialised from its
  // parent's stored node: when that content was read, not when it was written.
  { id: 'v105_baseline_content_as_of', sql: `ALTER TABLE va_baseline ADD COLUMN content_as_of BIGINT NULL` }
];
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test test/migrations.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.js test/migrations.test.js
git commit -m "feat(schema): reshape the draft evidence tables to the approved spec (v088-v105)" -- src/db/migrations.js test/migrations.test.js
```

---

### Task 3: The drift store records provenance and survives the gap between deploy and migration

The draft `recordDrift` and the read column list name the new columns unconditionally. Until v082/v096 run on a site, every drift write and read would fail for up to five minutes after each deploy. `src/lib/db.js:123` explains why this codebase never accepts that. This task:
- falls back to the legacy columns when the new ones are unknown;
- removes `editor_account_id`;
- makes `toObservation` follow spec §7.1.

**Files:**
- Create: `src/lib/observation.js`
- Modify: `src/db/driftStore.js`
- Test: `test/drift-observation.test.js` (new; `test/drift-store.test.js` is staged by someone else and must not be touched)

**Interfaces:**
- Produces (from `src/lib/observation.js`):
  - `EDIT_STATUS = { CONFIRMED, UNATTRIBUTED, HISTORY_UNAVAILABLE }`
  - `editStatusFor({ changelogId, historyComplete }) → string`
  - `observationColumns({ changelogId, attributionAt, historyComplete, detectedVia, actorAccountId, now }) → { observed_at, trigger_kind, trigger_account_id, edit_status, edited_at }`
  - `observationOf(row) → { observedAt, trigger: { kind, accountId }, edit: { status, editorAccountId, editorName, editedAt, changelogId } }`
- Produces (from `src/db/driftStore.js`):
  - `recordDrift(drift, query = throwing)` accepts the five provenance properties above;
  - every decoded drift row gains `.observation` (from `observationOf`) and keeps every legacy property.

- [ ] **Step 1: Confirm the draft's camelCase properties are unused**

Run: `grep -rn "editStatus\|triggerKind\|triggerAccountId\|editorAccountId\|observedAt" src frontend/src | grep -v "src/db/driftStore.js"`
Expected: no output. If anything matches, stop and report it: a reader depends on the draft shape.

- [ ] **Step 2: Write the failing tests**

Create `test/drift-observation.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EDIT_STATUS, editStatusFor, observationColumns, observationOf } from '../src/lib/observation.js';
import { recordDrift, driftForIssueVersions } from '../src/db/driftStore.js';

const unknownColumn = () => Object.assign(new Error("Unknown column 'observed_at' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' });

test('only a matching Jira history item makes an edit confirmed', () => {
  assert.equal(editStatusFor({ changelogId: '10101', historyComplete: false }), EDIT_STATUS.CONFIRMED);
  assert.equal(editStatusFor({ changelogId: null, historyComplete: true }), EDIT_STATUS.UNATTRIBUTED);
  assert.equal(editStatusFor({ changelogId: null, historyComplete: false }), EDIT_STATUS.HISTORY_UNAVAILABLE);
});

test('the event user is recorded as what triggered the check, and an edit time only when confirmed', () => {
  assert.deepEqual(observationColumns({ changelogId: null, attributionAt: 5, historyComplete: true,
    detectedVia: 'EVENT', actorAccountId: 'event-user', now: 900 }), {
    observed_at: 900, trigger_kind: 'EVENT', trigger_account_id: 'event-user',
    edit_status: 'UNATTRIBUTED', edited_at: null
  });
  assert.equal(observationColumns({ changelogId: '7', attributionAt: 5, historyComplete: true,
    detectedVia: 'EVENT', actorAccountId: 'event-user', now: 900 }).edited_at, 5);
});

test('a row with provenance columns is decoded from them; the editor comes only with a confirmed edit', () => {
  const base = { occurred_at: 50, detected_via: 'EVENT', actor_account_id: 'x', actor_name: 'X', changelog_id: null };
  assert.deepEqual(observationOf({ ...base, edit_status: 'UNATTRIBUTED', observed_at: 60, trigger_kind: 'EVENT',
    trigger_account_id: 'y', edited_at: null }), {
    observedAt: 60, trigger: { kind: 'EVENT', accountId: 'y' },
    edit: { status: 'UNATTRIBUTED', editorAccountId: null, editorName: null, editedAt: null, changelogId: null }
  });
  assert.deepEqual(observationOf({ ...base, changelog_id: '9', edit_status: 'CONFIRMED', observed_at: 60,
    trigger_kind: 'RECONCILE', trigger_account_id: null, edited_at: 40 }).edit,
    { status: 'CONFIRMED', editorAccountId: 'x', editorName: 'X', editedAt: 40, changelogId: '9' });
});

test('a row written before the provenance columns is decoded for what it is', () => {
  const confirmed = observationOf({ occurred_at: 40, detected_via: 'RECONCILE', actor_account_id: 'x',
    actor_name: 'X', changelog_id: '9' });
  assert.equal(confirmed.edit.status, 'CONFIRMED');
  assert.equal(confirmed.edit.editedAt, 40);
  assert.equal(confirmed.observedAt, null, 'when it was observed was never recorded');
  const seen = observationOf({ occurred_at: 70, detected_via: 'EVENT', actor_account_id: 'event-user',
    actor_name: null, changelog_id: null });
  assert.deepEqual(seen, { observedAt: 70, trigger: { kind: 'EVENT', accountId: 'event-user' },
    edit: { status: 'UNATTRIBUTED', editorAccountId: null, editorName: null, editedAt: null, changelogId: null } });
});

const drift = () => ({ issue_id: 1, project_id: 2, baseline_id: Buffer.alloc(16, 3), baseline_version: 4,
  field_id: 'summary', field_name: 'Summary', from_digest: null, to_digest: null, from_repr: 'a', to_repr: 'b',
  actor_account_id: 'x', actor_name: 'X', occurred_at: 50, changelog_id: null, detected_via: 'EVENT',
  source: 'HUMAN', materiality: 'MAJOR', observed_at: 60, trigger_kind: 'EVENT', trigger_account_id: 'x',
  edit_status: 'UNATTRIBUTED', edited_at: null });

test('a drift row carries its provenance columns, and never the draft editor column', async () => {
  const queries = [];
  const result = await recordDrift(drift(), async (sql, params) => { queries.push({ sql, params }); return []; });
  assert.equal(result.inserted, true);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /observed_at, trigger_kind, trigger_account_id, edit_status, edited_at\)/);
  assert.doesNotMatch(queries[0].sql, /editor_account_id/);
  assert.equal((queries[0].sql.match(/\?/g) ?? []).length, queries[0].params.length);
});

test('before the provenance columns exist, a drift row is still recorded with the legacy columns', async () => {
  const queries = [];
  const result = await recordDrift(drift(), async (sql, params) => {
    queries.push({ sql, params });
    if (/observed_at/.test(sql)) throw unknownColumn();
    return [];
  });
  assert.equal(result.inserted, true);
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[1].sql, /observed_at/);
  assert.equal((queries[1].sql.match(/\?/g) ?? []).length, queries[1].params.length);
});

test('before the provenance columns exist, drift is still read, and decoded as legacy', async () => {
  const queries = [];
  const { rows } = await driftForIssueVersions([{ issueId: 1, version: 4 }], async (sql, params) => {
    queries.push(sql);
    if (/observed_at/.test(sql)) throw unknownColumn();
    return [{ drift_id: 'AAAA', baseline_id: null, approval_id: null, occurred_at: 70, detected_via: 'EVENT',
      actor_account_id: 'event-user', changelog_id: null }];
  });
  assert.equal(queries.length, 2);
  assert.equal(rows[0].observation.edit.status, 'UNATTRIBUTED');
  assert.equal(rows[0].actor_account_id, 'event-user', 'legacy properties stay for today\'s readers');
});
```

- [ ] **Step 3: Run them and see them fail**

Run: `node --test test/drift-observation.test.js`
Expected: FAIL with `Cannot find module '…/src/lib/observation.js'`.

- [ ] **Step 4: Create `src/lib/observation.js`**

```js
/**
 * HOW MUCH WE KNOW ABOUT ONE OBSERVED CHANGE (docs/specs/2026-10-03-baseline-evidence-model-design.md §7.1).
 *
 * A Jira event only wakes the collector. Its user is who TRIGGERED the check,
 * and `now` is when the difference was SEEN. Neither is the editor or the edit
 * time: those come only from a matching Jira history item. Each fact has its
 * own column, so a fallback can never pass for a confirmed edit.
 */
export const EDIT_STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  UNATTRIBUTED: 'UNATTRIBUTED',
  HISTORY_UNAVAILABLE: 'HISTORY_UNAVAILABLE'
});

export function editStatusFor({ changelogId, historyComplete }) {
  if (changelogId) return EDIT_STATUS.CONFIRMED;
  return historyComplete ? EDIT_STATUS.UNATTRIBUTED : EDIT_STATUS.HISTORY_UNAVAILABLE;
}

/** The provenance columns of one va_drift row. */
export function observationColumns({ changelogId, attributionAt, historyComplete, detectedVia, actorAccountId, now }) {
  const status = editStatusFor({ changelogId, historyComplete });
  return {
    observed_at: now,
    trigger_kind: detectedVia ?? null,
    trigger_account_id: actorAccountId ?? null,
    edit_status: status,
    edited_at: status === EDIT_STATUS.CONFIRMED ? attributionAt ?? null : null
  };
}

const time = value => (value == null ? null : Number(value));

/**
 * One observation, decoded. A row written before the provenance columns
 * existed is decoded for what it actually recorded: with a changelog id it is a
 * confirmed edit whose observation time was never kept; without one, its actor
 * was the event's user and its time was when the collector looked.
 */
export function observationOf(row) {
  if (row.edit_status) {
    const confirmed = row.edit_status === EDIT_STATUS.CONFIRMED;
    return {
      observedAt: time(row.observed_at),
      trigger: { kind: row.trigger_kind ?? null, accountId: row.trigger_account_id ?? null },
      edit: {
        status: row.edit_status,
        editorAccountId: confirmed ? row.actor_account_id ?? null : null,
        editorName: confirmed ? row.actor_name ?? null : null,
        editedAt: confirmed ? time(row.edited_at) : null,
        changelogId: confirmed ? row.changelog_id ?? null : null
      }
    };
  }
  if (row.changelog_id) {
    return {
      observedAt: null,
      trigger: { kind: row.detected_via ?? null, accountId: null },
      edit: { status: EDIT_STATUS.CONFIRMED, editorAccountId: row.actor_account_id ?? null,
        editorName: row.actor_name ?? null, editedAt: time(row.occurred_at), changelogId: row.changelog_id }
    };
  }
  return {
    observedAt: time(row.occurred_at),
    trigger: { kind: row.detected_via ?? null, accountId: row.actor_account_id ?? null },
    edit: { status: EDIT_STATUS.UNATTRIBUTED, editorAccountId: null, editorName: null, editedAt: null, changelogId: null }
  };
}
```

- [ ] **Step 5: Rework `src/db/driftStore.js`**

1. **Imports.** Add `isUnknownColumn` to the existing `../lib/db.js` import, and add this line below the imports:

```js
import { observationOf } from '../lib/observation.js';
```

2. **Column lists.** Replace the whole `const DRIFT_COLUMNS = \`…\`;` block with:

```js
const LEGACY_DRIFT_COLUMNS = `
  TO_BASE64(drift_id) AS drift_id, issue_id, project_id,
  TO_BASE64(baseline_id) AS baseline_id, baseline_version,
  field_id, field_name, from_digest, to_digest, from_repr, to_repr,
  actor_account_id, actor_name, occurred_at, changelog_id, detected_via, source,
  materiality, TO_BASE64(approval_id) AS approval_id
`;
// Written since v082/v096 (docs/specs/2026-10-03-baseline-evidence-model-design.md §7.1).
// Until those land on a site, reads fall back to the legacy list rather than
// failing every panel, hold and decision for the minutes after a deploy.
const DRIFT_COLUMNS = `${LEGACY_DRIFT_COLUMNS},
  observed_at, trigger_kind, trigger_account_id, edit_status, edited_at,
  TO_BASE64(decision_id) AS decision_id
`;

async function selectDrift(query, build, params) {
  try {
    return await query(build(DRIFT_COLUMNS), params);
  } catch (error) {
    if (!isUnknownColumn(error)) throw error;
    return query(build(LEGACY_DRIFT_COLUMNS), params);
  }
}
```

3. **Decoder.** Replace the whole `function toObservation(row) { … }` with:

```js
function toObservation(row) {
  if (!row) return null;
  return {
    ...row,
    drift_id: fromBinaryColumn(row.drift_id),
    baseline_id: fromBinaryColumn(row.baseline_id),
    approval_id: fromBinaryColumn(row.approval_id),
    decision_id: fromBinaryColumn(row.decision_id ?? null),
    // A stable string handle for the AI payload and the panel's citation chips.
    key: row.drift_id,
    observation: observationOf(row)
  };
}
```

4. **Reads.** Find every read that builds `SELECT ${DRIFT_COLUMNS}` with `grep -n 'DRIFT_COLUMNS}' src/db/driftStore.js`. There are two: the function that ends `return rows.map(toObservation);` and `driftForIssueVersions`. Convert each from:

```js
  const rows = await query(
    `SELECT ${DRIFT_COLUMNS} FROM va_drift
     WHERE …`,
    params
  );
```

to:

```js
  const rows = await selectDrift(query, columns =>
    `SELECT ${columns} FROM va_drift
     WHERE …`,
    params
  );
```

The `WHERE …` text and the params stay exactly as they are. If a read calls `throwing(...)` directly instead of a `query` parameter, pass `throwing` as `selectDrift`'s first argument.

5. **Write.** Replace the whole `export async function recordDrift(drift) { … }` with:

```js
const LEGACY_INSERT_COLUMNS = `drift_id, issue_id, project_id, baseline_id, baseline_version, field_id, field_name,
        from_digest, to_digest, from_repr, to_repr, actor_account_id, actor_name,
        occurred_at, changelog_id, detected_via, source, materiality, approval_id`;
const LEGACY_INSERT_VALUES = 'FROM_BASE64(?), ?, ?, FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL';

export async function recordDrift(drift, query = throwing) {
  const driftId = newId();
  const legacy = [
    toBinaryParam(driftId), drift.issue_id, drift.project_id, toBinaryParam(drift.baseline_id),
    drift.baseline_version, drift.field_id, drift.field_name ?? drift.field_id,
    drift.from_digest ?? null, drift.to_digest ?? null,
    truncate(drift.from_repr, 512), truncate(drift.to_repr, 512),
    drift.actor_account_id ?? null, drift.actor_name ?? null, drift.occurred_at,
    drift.changelog_id ?? null, drift.detected_via ?? 'EVENT', drift.source ?? 'JIRA', drift.materiality
  ];
  const provenance = [drift.observed_at ?? null, drift.trigger_kind ?? null, drift.trigger_account_id ?? null,
    drift.edit_status ?? null, drift.edited_at ?? null];
  try {
    try {
      await query(
        `INSERT INTO va_drift (${LEGACY_INSERT_COLUMNS},
          observed_at, trigger_kind, trigger_account_id, edit_status, edited_at)
         VALUES (${LEGACY_INSERT_VALUES}, ?, ?, ?, ?, ?)`,
        [...legacy, ...provenance]
      );
    } catch (error) {
      // Before v082 lands on a site: the observation is still recorded.
      if (!isUnknownColumn(error)) throw error;
      await query(`INSERT INTO va_drift (${LEGACY_INSERT_COLUMNS}) VALUES (${LEGACY_INSERT_VALUES})`, legacy);
    }
    return { inserted: true, driftId };
  } catch (e) {
    if (isDuplicateKey(e)) return { inserted: false, duplicate: true };
    throw e;
  }
}
```

`truncate`, `newId`, `toBinaryParam`, `isDuplicateKey` and `throwing` are already imported or defined in this file. Check with `grep -n "function truncate\|^import" src/db/driftStore.js`.

- [ ] **Step 6: Run the tests and see them pass**

Run: `node --test test/drift-observation.test.js && npm test 2>&1 | tail -6`
Expected: PASS, and `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/observation.js src/db/driftStore.js test/drift-observation.test.js
git commit -m "feat(drift): record how much is known about each observation, across the migration window" -- src/lib/observation.js src/db/driftStore.js test/drift-observation.test.js
```

---

### Task 4: The collector records how much it knows

**Files:**
- Modify: `src/lib/collect.js` (in `recordAll`: the changelog read and the `recordDrift({...})` call)

**Interfaces:**
- Consumes: `observationColumns` (Task 3).

- [ ] **Step 1: Read the changelog's completeness**

In `recordAll`, replace:

```js
  const { entries, failed } = await fetchChangelog(
```

with:

```js
  // `truncated` matters as much as `failed`: Jira's changelog pages oldest
  // first, so a bounded read stops before the NEWEST edits, which are the ones
  // an unmatched observation would need.
  const { entries, failed, truncated } = await fetchChangelog(
```

- [ ] **Step 2: Pass the provenance columns**

Add `import { observationColumns } from './observation.js';` to the imports. In the `recordDrift({ … })` call, the last two properties are currently `source: …,` and `materiality`. Replace those two lines so that the call ends:

```js
      source: isOurs ? SOURCE.BASELINE : (attribution?.source ?? SOURCE.UNKNOWN),
      materiality,
      ...observationColumns({ changelogId, attributionAt: attribution?.at ?? null,
        historyComplete: !failed && !truncated, detectedVia, actorAccountId, now })
    });
```

The legacy `actor_account_id` and `occurred_at` lines stay exactly as they are. Readers still use them until step 4.

- [ ] **Step 3: Run the suite**

Run: `npm test 2>&1 | tail -6`
Expected: `ℹ fail 0`. The pure behaviour is covered by Task 3's `observationColumns` tests. `collect()` has no dependency injection, and adding it is out of scope.

- [ ] **Step 4: Commit**

```bash
git add src/lib/collect.js
git commit -m "feat(collect): store the trigger, observation time and edit status of each drift row" -- src/lib/collect.js
```

---

### Task 5: The evidence builder (pure)

**Files:**
- Create: `src/lib/evidence/versionEvidence.js`
- Test: `test/version-evidence.test.js`

**Interfaces:**
- Produces:
  - `CAUSE` = `{ OWN_TRANSITION, PARENT_CAPTURE, DRIFT_DECISION, LINK_RECORD, MIGRATED }`
  - `RULE_SOURCE` = `{ OWN, INHERITED }`
  - `UNRECORDED_ROLE` = `'UNRECORDED'`
  - `parseDigests(stringOrObject) → object`
  - `ruleKey({ source, projectId, issueTypeId, imposedByBaselineId }) → 32 hex chars`
  - `versionEvidence({ fields, digests, writable = {}, rule, signature }) → { fields: FieldRow[], rules: RuleRow[], signatures: SignatureRow[] }`
    - `fields`: controlled-field objects as in `va_controlled_field` (`field_id`, `field_name`, `field_kind`, `schema_type`, `materiality`, `store_values`, `writable`).
    - `rule` = `{ source, projectId, issueTypeId, transitionId, approvers: [{ role, assurance }], controlledFieldsHash, imposedByBaselineId?, imposedByVersion? }`
    - `signature` = `{ approvalId, signerAccountId, signerName, role, assurance, cause, causeBaselineId?, transitionId, fromStatusId, toStatusId, transitionAt, statusAtCapture, signedAt, fieldsCovered? }`
  - `derivedEvidence({ source: { fields, rules }, digests, signature }) → { recorded: boolean, fields, rules, signatures }`. `source` is `readVersionEvidence()`'s decoded shape (Task 6).
  - `linkRows({ links, otherVersions: Map }) → LinkRow[]`
  - `trackedLinks(fields, issueFields) → links[] | null`
  - `linkedIssueIds(links) → number[]`
- Row shapes match the column names in Task 2 exactly:
  - `required_by`, `approvers` and `fields_covered` are JSON strings;
  - binary ids are Buffers;
  - `store_values` is a boolean, and `restorable` is a boolean or null.

- [ ] **Step 1: Write the failing tests**

Create `test/version-evidence.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { versionEvidence, derivedEvidence, linkRows, trackedLinks, linkedIssueIds, ruleKey,
  CAUSE, RULE_SOURCE, UNRECORDED_ROLE } from '../src/lib/evidence/versionEvidence.js';

const d = c => c.repeat(64);
const FIELDS = [
  { field_id: 'summary', field_name: 'Summary', field_kind: 'TEXT', schema_type: 'string',
    materiality: 'MAJOR', store_values: true, writable: true },
  { field_id: 'issuelinks', field_name: 'Linked issues', field_kind: 'LINKS', schema_type: 'array',
    materiality: 'MAJOR', store_values: 1, writable: null }
];
const DIGESTS = { summary: d('a'), issuelinks: d('b') };
const RULE = { source: RULE_SOURCE.OWN, projectId: 2, issueTypeId: '3', transitionId: '31',
  approvers: [{ role: 'REVIEWER', assurance: 'ESIGNATURE' }], controlledFieldsHash: d('h') };
const SIGNATURE = { approvalId: Buffer.alloc(16, 1), signerAccountId: 'acc-1', signerName: 'Asha',
  role: 'REVIEWER', assurance: 'ESIGNATURE', cause: CAUSE.OWN_TRANSITION, transitionId: '31',
  fromStatusId: '3', toStatusId: '4', transitionAt: 100, statusAtCapture: '3', signedAt: 101 };

test('every field is recorded with its definition, its digest and the rule that required it', () => {
  const ev = versionEvidence({ fields: FIELDS, digests: JSON.stringify(DIGESTS), writable: { summary: false },
    rule: RULE, signature: SIGNATURE });
  const key = ruleKey(RULE);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.deepEqual(ev.fields[0], { field_id: 'summary', label: 'Summary', label_source: 'CAPTURE', kind: 'TEXT',
    schema_type: 'string', materiality: 'MAJOR', store_values: true, restorable: false, digest: d('a'),
    required_by: JSON.stringify([key]) });
  assert.equal(ev.fields[1].store_values, true);
  assert.equal(ev.fields[1].restorable, null, 'writability nobody asked about stays unknown');
  assert.deepEqual(ev.rules, [{ rule_key: key, source: 'OWN', project_id: 2, issue_type_id: '3', transition_id: '31',
    approvers: JSON.stringify([{ role: 'REVIEWER', assurance: 'ESIGNATURE' }]), controlled_fields_hash: d('h'),
    imposed_by_baseline_id: null, imposed_by_version: null }]);
  assert.equal(ev.signatures.length, 1);
  const [sig] = ev.signatures;
  assert.ok(sig.approval_id.equals(Buffer.alloc(16, 1)));
  assert.deepEqual([sig.signer_account_id, sig.signer_name, sig.role, sig.assurance, sig.cause, sig.cause_baseline_id,
    sig.decision_id, sig.transition_id, sig.from_status_id, sig.to_status_id, sig.transition_at,
    sig.status_at_capture, sig.fields_covered, sig.signed_at],
    ['acc-1', 'Asha', 'REVIEWER', 'ESIGNATURE', 'OWN_TRANSITION', null, null, '31', '3', '4', 100, '3',
      JSON.stringify(['summary', 'issuelinks']), 101]);
});

test('a missing digest, a digest for an untracked field or unreadable digests refuse the capture', () => {
  const refused = e => e.reason === 'CAPTURE_INCOMPLETE';
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: { summary: d('a') }, rule: RULE, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: FIELDS.slice(0, 1), digests: { summary: d('a'), labels: d('c') },
    rule: RULE, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: 'not json', rule: RULE, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: [], digests: {}, rule: RULE, signature: SIGNATURE }), refused);
});

test('an incomplete rule, signature or field definition refuses the capture', () => {
  const refused = e => e.reason === 'BASELINE_POLICY_INCOMPLETE';
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: { ...RULE, approvers: [] }, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS,
    rule: { ...RULE, approvers: [{ role: 'REVIEWER' }] }, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS,
    rule: { ...RULE, source: RULE_SOURCE.INHERITED }, signature: SIGNATURE }), refused, 'inherited from nowhere');
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: { ...RULE, source: 'GUESSED' }, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: [{ ...FIELDS[0], materiality: undefined }, FIELDS[1]], digests: DIGESTS,
    rule: RULE, signature: SIGNATURE }), refused);
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: RULE,
    signature: { ...SIGNATURE, signedAt: undefined } }), refused);
  assert.throws(() => versionEvidence({ fields: FIELDS, digests: DIGESTS, rule: RULE,
    signature: { ...SIGNATURE, cause: 'SOMETHING' } }), refused);
});

test('an inherited rule names the version that imposed it, and keys apart from an own rule', () => {
  const inherited = { ...RULE, source: RULE_SOURCE.INHERITED, imposedByBaselineId: Buffer.alloc(16, 9), imposedByVersion: 3 };
  const ev = versionEvidence({ fields: FIELDS.slice(0, 1), digests: { summary: d('a') }, rule: inherited,
    signature: { ...SIGNATURE, cause: CAUSE.PARENT_CAPTURE, causeBaselineId: Buffer.alloc(16, 9) } });
  assert.ok(ev.rules[0].imposed_by_baseline_id.equals(Buffer.alloc(16, 9)));
  assert.equal(ev.rules[0].imposed_by_version, 3);
  assert.notEqual(ev.rules[0].rule_key, ruleKey(RULE));
  assert.ok(ev.signatures[0].cause_baseline_id.equals(Buffer.alloc(16, 9)));
});

test('links are recorded with their direction and the other end\'s version at that moment', () => {
  const links = [
    { id: '15539', type: { id: '10022', name: 'Deployments' }, outwardIssue: { id: '43903', key: 'VAT-3' } },
    { id: '15540', type: { id: '10000', name: 'Blocks' }, inwardIssue: { id: '43927', key: 'VAT-12' } }
  ];
  assert.deepEqual(linkedIssueIds(links), [43903, 43927]);
  assert.deepEqual(linkedIssueIds(null), []);
  const rows = linkRows({ links, otherVersions: new Map([[43903, { baseline_id: Buffer.alloc(16, 5), version: 4 }]]) });
  assert.deepEqual(rows.map(r => [r.link_id, r.link_type, r.direction, r.other_issue_id, r.other_issue_key, r.other_baseline_version]),
    [['15539', '10022', 'OUTWARD', 43903, 'VAT-3', 4], ['15540', '10000', 'INWARD', 43927, 'VAT-12', null]]);
  assert.ok(rows[0].other_baseline_id.equals(Buffer.alloc(16, 5)));
  assert.equal(rows[1].other_baseline_id, null);
  assert.deepEqual(linkRows({ links: null }), []);
  assert.throws(() => linkRows({ links: [{ id: '1', type: { id: '2' } }] }), e => e.reason === 'CAPTURE_INCOMPLETE');
  assert.throws(() => linkRows({ links: [{ id: '1', outwardIssue: { id: '2', key: 'A-2' } }] }), e => e.reason === 'CAPTURE_INCOMPLETE');
});

test('links are recorded only when the version tracks a link field', () => {
  assert.equal(trackedLinks(FIELDS.slice(0, 1), { issuelinks: [{ id: '1' }] }), null);
  assert.deepEqual(trackedLinks(FIELDS, { issuelinks: [] }), []);
  assert.deepEqual(trackedLinks(FIELDS, {}), [], 'tracked but absent from the read is no links');
});

const SIGNED = {
  fields: [
    { field_id: 'summary', label: 'Summary', label_source: 'CAPTURE', kind: 'TEXT', schema_type: 'string',
      materiality: 'MAJOR', store_values: true, restorable: true, digest: d('a'), required_by: ['k1'] },
    { field_id: 'issuelinks', label: 'Linked issues', label_source: 'CAPTURE', kind: 'LINKS', schema_type: 'array',
      materiality: 'MAJOR', store_values: true, restorable: null, digest: d('b'), required_by: ['k1'] }
  ],
  rules: [{ rule_key: 'k1', source: 'OWN', project_id: 2, issue_type_id: '3', transition_id: '31',
    approvers: [{ role: 'REVIEWER', assurance: 'ESIGNATURE' }], controlled_fields_hash: d('h'),
    imposed_by_baseline_id: null, imposed_by_version: null }]
};

test('a link record copies the signed definitions and rules, with the new digests and its own signature', () => {
  const ev = derivedEvidence({ source: SIGNED, digests: { summary: d('a'), issuelinks: d('c') },
    signature: { ...SIGNATURE, role: UNRECORDED_ROLE, cause: CAUSE.LINK_RECORD, fieldsCovered: ['issuelinks'] } });
  assert.equal(ev.recorded, true);
  assert.deepEqual(ev.fields.map(f => [f.field_id, f.label, f.digest, f.required_by]),
    [['summary', 'Summary', d('a'), '["k1"]'], ['issuelinks', 'Linked issues', d('c'), '["k1"]']]);
  assert.equal(ev.rules[0].approvers, JSON.stringify([{ role: 'REVIEWER', assurance: 'ESIGNATURE' }]));
  assert.equal(ev.signatures[0].role, 'UNRECORDED');
  assert.equal(ev.signatures[0].cause, 'LINK_RECORD');
  assert.equal(ev.signatures[0].fields_covered, '["issuelinks"]');
  assert.throws(() => derivedEvidence({ source: SIGNED, digests: { summary: d('a') }, signature: SIGNATURE }),
    e => e.reason === 'CAPTURE_INCOMPLETE');
});

test('a link record on a version whose policy was never recorded records only its signature', () => {
  const ev = derivedEvidence({ source: { fields: [], rules: [] }, digests: { issuelinks: d('c') },
    signature: { ...SIGNATURE, cause: CAUSE.LINK_RECORD, fieldsCovered: ['issuelinks'] } });
  assert.equal(ev.recorded, false);
  assert.deepEqual([ev.fields, ev.rules], [[], []]);
  assert.equal(ev.signatures.length, 1);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/version-evidence.test.js`
Expected: FAIL with `Cannot find module '…/src/lib/evidence/versionEvidence.js'`.

- [ ] **Step 3: Create `src/lib/evidence/versionEvidence.js`**

```js
import { canonical, sha256Hex } from '../hash.js';
import { FailClosed } from '../errors.js';
import { FIELD_KIND } from '../content.js';

/**
 * THE EVIDENCE OF ONE BASELINE VERSION, AS ROWS
 * (docs/specs/2026-10-03-baseline-evidence-model-design.md §4).
 *
 * Pure. What a capture already knows (the fields it projected, their digests,
 * the rule it applied, who signed) becomes the rows that let a version be read
 * later exactly as it was signed, without consulting today's configuration.
 * Anything missing refuses the capture: a version is never published with
 * evidence that was guessed.
 */
export const CAUSE = Object.freeze({
  OWN_TRANSITION: 'OWN_TRANSITION',
  PARENT_CAPTURE: 'PARENT_CAPTURE',
  DRIFT_DECISION: 'DRIFT_DECISION',
  LINK_RECORD: 'LINK_RECORD',
  MIGRATED: 'MIGRATED'
});
export const RULE_SOURCE = Object.freeze({ OWN: 'OWN', INHERITED: 'INHERITED' });
/** A link record queued before signer roles travelled with the job: said, not guessed. */
export const UNRECORDED_ROLE = 'UNRECORDED';

const POLICY = 'BASELINE_POLICY_INCOMPLETE';
const INCOMPLETE = 'CAPTURE_INCOMPLETE';
const hex = id => (id == null ? null : Buffer.from(id).toString('hex'));
const present = value => typeof value === 'string' ? value.trim().length > 0 : value != null;

function bool(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

export function parseDigests(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* refused below */ }
  throw new FailClosed(INCOMPLETE);
}

/** A rule's identity within a version: its source and the version that imposed it. */
export function ruleKey({ source, projectId, issueTypeId, imposedByBaselineId = null }) {
  return sha256Hex(canonical({ s: source, p: Number(projectId), t: String(issueTypeId),
    by: hex(imposedByBaselineId) })).slice(0, 32);
}

function ruleRow(rule) {
  if (!Object.values(RULE_SOURCE).includes(rule?.source)) throw new FailClosed(POLICY);
  if (rule.source === RULE_SOURCE.INHERITED && rule.imposedByBaselineId == null) throw new FailClosed(POLICY);
  if (!Number.isFinite(Number(rule.projectId)) || !present(rule.issueTypeId)) throw new FailClosed(POLICY);
  const approvers = rule.approvers ?? [];
  if (!approvers.length || approvers.some(a => !present(a?.role) || !present(a?.assurance))) throw new FailClosed(POLICY);
  return {
    rule_key: ruleKey(rule),
    source: rule.source,
    project_id: Number(rule.projectId),
    issue_type_id: String(rule.issueTypeId),
    transition_id: rule.transitionId == null ? null : String(rule.transitionId),
    approvers: JSON.stringify(approvers.map(({ role, assurance }) => ({ role: String(role), assurance: String(assurance) }))),
    controlled_fields_hash: rule.controlledFieldsHash ?? null,
    imposed_by_baseline_id: rule.imposedByBaselineId ?? null,
    imposed_by_version: rule.imposedByVersion == null ? null : Number(rule.imposedByVersion)
  };
}

function signatureRow(signature, defaultCovered) {
  const s = signature ?? {};
  if (!s.approvalId || !present(s.signerAccountId) || !present(s.role) || !present(s.assurance)
    || !Object.values(CAUSE).includes(s.cause) || !Number.isFinite(Number(s.signedAt)) || s.signedAt == null) {
    throw new FailClosed(POLICY);
  }
  return {
    approval_id: s.approvalId,
    signer_account_id: String(s.signerAccountId),
    signer_name: String(s.signerName ?? s.signerAccountId),
    role: String(s.role),
    assurance: String(s.assurance),
    cause: s.cause,
    cause_baseline_id: s.causeBaselineId ?? null,
    decision_id: null,
    transition_id: s.transitionId == null ? null : String(s.transitionId),
    from_status_id: s.fromStatusId == null ? null : String(s.fromStatusId),
    to_status_id: s.toStatusId == null ? null : String(s.toStatusId),
    transition_at: s.transitionAt == null ? null : Number(s.transitionAt),
    status_at_capture: s.statusAtCapture == null ? null : String(s.statusAtCapture),
    fields_covered: JSON.stringify(s.fieldsCovered ?? defaultCovered),
    signed_at: Number(s.signedAt)
  };
}

function digestFor(byField, fieldId) {
  const digest = byField[fieldId];
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new FailClosed(INCOMPLETE);
  return digest;
}

export function versionEvidence({ fields, digests, writable = {}, rule, signature }) {
  if (!Array.isArray(fields) || fields.length === 0) throw new FailClosed(INCOMPLETE);
  const byField = parseDigests(digests);
  const ids = fields.map(field => String(field.field_id));
  if (Object.keys(byField).some(id => !ids.includes(id))) throw new FailClosed(INCOMPLETE);
  const rules = [ruleRow(rule)];
  const key = rules[0].rule_key;
  const fieldRows = fields.map(field => {
    const id = String(field.field_id);
    if (!present(field.field_kind) || !present(field.materiality)) throw new FailClosed(POLICY);
    const restorable = Object.prototype.hasOwnProperty.call(writable, id) ? bool(writable[id]) : bool(field.writable);
    return {
      field_id: id,
      label: String(field.field_name ?? id),
      label_source: 'CAPTURE',
      kind: String(field.field_kind),
      schema_type: field.schema_type ?? null,
      materiality: String(field.materiality),
      store_values: bool(field.store_values) === true,
      restorable,
      digest: digestFor(byField, id),
      required_by: JSON.stringify([key])
    };
  });
  return { fields: fieldRows, rules, signatures: [signatureRow(signature, ids)] };
}

/**
 * A version that re-records only links, on another issue's approval
 * (jobs/linkWorker.js): the signed definitions and rules of the version it
 * derives from, with the derived digests, and its own signature. A source whose
 * policy was never recorded gives only the signature: `recorded` says which.
 */
export function derivedEvidence({ source, digests, signature }) {
  const byField = parseDigests(digests);
  const recorded = (source?.fields?.length ?? 0) > 0 && (source?.rules?.length ?? 0) > 0;
  if (!recorded) return { recorded, fields: [], rules: [], signatures: [signatureRow(signature, Object.keys(byField))] };
  const ids = source.fields.map(field => String(field.field_id));
  if (Object.keys(byField).some(id => !ids.includes(id))) throw new FailClosed(INCOMPLETE);
  const fields = source.fields.map(field => ({
    field_id: String(field.field_id), label: field.label, label_source: field.label_source, kind: field.kind,
    schema_type: field.schema_type ?? null, materiality: field.materiality, store_values: field.store_values === true,
    restorable: field.restorable ?? null, digest: digestFor(byField, String(field.field_id)),
    required_by: JSON.stringify(field.required_by)
  }));
  const rules = source.rules.map(rule => ({ ...rule, approvers: JSON.stringify(rule.approvers) }));
  return { recorded, fields, rules, signatures: [signatureRow(signature, ids)] };
}

/** The links a version records: only when it tracks a link field. */
export function trackedLinks(fields, issueFields) {
  const field = (fields ?? []).find(f => f.field_kind === FIELD_KIND.LINKS);
  if (!field) return null;
  return issueFields?.[field.field_id] ?? [];
}

export function linkedIssueIds(links) {
  return [...new Set((links ?? [])
    .map(link => Number((link?.outwardIssue ?? link?.inwardIssue)?.id))
    .filter(Number.isSafeInteger))];
}

function versionOf(otherVersions, issueId) {
  return otherVersions.get(issueId) ?? otherVersions.get(String(issueId)) ?? null;
}

export function linkRows({ links, otherVersions = new Map() }) {
  if (links == null) return [];
  if (!Array.isArray(links)) throw new FailClosed(INCOMPLETE);
  return links.map(link => {
    const outward = link?.outwardIssue;
    const other = outward ?? link?.inwardIssue;
    const type = link?.type?.id;
    if (!present(link?.id) || !present(type) || other?.id == null || !present(other?.key)) throw new FailClosed(INCOMPLETE);
    const otherId = Number(other.id);
    const version = versionOf(otherVersions, otherId);
    return {
      link_id: String(link.id),
      link_type: String(type),
      direction: outward ? 'OUTWARD' : 'INWARD',
      other_issue_id: otherId,
      other_issue_key: String(other.key),
      other_baseline_id: version?.baseline_id ?? null,
      other_baseline_version: version ? Number(version.version) : null
    };
  });
}
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test test/version-evidence.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/evidence/versionEvidence.js test/version-evidence.test.js
git commit -m "feat(evidence): build each version's field, rule, signature and link rows" -- src/lib/evidence/versionEvidence.js test/version-evidence.test.js
```

---

### Task 6: The evidence store, and SCHEMA_PENDING that outlasts the migration gap

**Files:**
- Create: `src/db/evidenceStore.js`
- Modify: `src/lib/errors.js` (add `DENY.SCHEMA_PENDING`)
- Modify: `src/triggers/retry.js` (per-reason retry budget)
- Modify: `src/lib/capture.js` (`captureBaseline`'s catch reports a `FailClosed` reason)
- Test: `test/evidence-store.test.js`, `test/schema-pending.test.js`

**Interfaces:**
- Consumes the row shapes from Task 5.
- Produces (from `src/db/evidenceStore.js`):
  - `isMissingSchema(error) → boolean`
  - `writeVersionEvidence({ entries: [{ baselineId, evidence: { fields, rules, signatures }, links, cause }], query }) → { written }`. It throws `FailClosed('SCHEMA_PENDING')` if tables or columns are missing, and `FailClosed('CAPTURE_INCOMPLETE')` if a version isn't CAPTURING.
  - `readVersionEvidence(baselineId, query) → { fields, rules, signatures, links }`, decoded (JSON parsed, booleans, Buffers).
  - `pinChildVersions({ parentBaselineId, pins: [{ issueId, baselineId, version }], query })`
  - `recordNodeSecurity({ baselineId, levels: [{ issueId, securityLevelId }], query })`
  - `copyNodePins({ fromBaselineId, toBaselineId, query })`
- Produces (from `src/lib/capture.js`): `captureFailure(error) → { captured: false, reason, error }`.

- [ ] **Step 1: Write the failing tests**

Create `test/evidence-store.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeVersionEvidence, readVersionEvidence, pinChildVersions, recordNodeSecurity, copyNodePins,
  isMissingSchema } from '../src/db/evidenceStore.js';

const d = c => c.repeat(64);
const fieldRow = { field_id: 'summary', label: 'Summary', label_source: 'CAPTURE', kind: 'TEXT', schema_type: 'string',
  materiality: 'MAJOR', store_values: true, restorable: null, digest: d('a'), required_by: '["k1"]' };
const ruleRow = { rule_key: 'k'.repeat(32), source: 'OWN', project_id: 2, issue_type_id: '3', transition_id: '31',
  approvers: '[{"role":"REVIEWER","assurance":"ESIGNATURE"}]', controlled_fields_hash: d('h'),
  imposed_by_baseline_id: null, imposed_by_version: null };
const sigRow = { approval_id: Buffer.alloc(16, 1), signer_account_id: 'a', signer_name: 'A', role: 'REVIEWER',
  assurance: 'ESIGNATURE', cause: 'OWN_TRANSITION', cause_baseline_id: null, decision_id: null, transition_id: '31',
  from_status_id: '3', to_status_id: '4', transition_at: 1, status_at_capture: '3', fields_covered: '["summary"]', signed_at: 2 };
const entry = (n, cause, recorded = true) => ({ baselineId: Buffer.alloc(16, n), cause, links: [],
  evidence: { fields: recorded ? [fieldRow] : [], rules: recorded ? [ruleRow] : [], signatures: [sigRow] } });

function recorder({ marked } = {}) {
  const queries = [];
  const query = async (sql, params) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    queries.push({ sql: text, params });
    if (text.startsWith('SELECT COUNT(*) AS n FROM va_baseline')) return [{ n: marked ?? params.length - 2 }];
    return [];
  };
  return { queries, query };
}

test('evidence for several versions is written in a few batched statements, then each version is marked', async () => {
  const { queries, query } = recorder();
  await writeVersionEvidence({ query, entries: [entry(1, 'DRIFT_DECISION'), entry(2, 'PARENT_CAPTURE'),
    entry(3, 'PARENT_CAPTURE'), entry(4, 'LINK_RECORD', false)] });
  const fieldInserts = queries.filter(q => q.sql.startsWith('INSERT INTO va_baseline_field'));
  assert.equal(fieldInserts.length, 1, 'one statement for every version\'s fields');
  assert.equal(queries.filter(q => q.sql.startsWith('INSERT INTO va_baseline_signature')).length, 1);
  for (const q of queries.filter(q => q.sql.startsWith('INSERT'))) {
    assert.equal((q.sql.match(/\?/g) ?? []).length, q.params.length, q.sql.slice(0, 40));
    assert.match(q.sql, /ON DUPLICATE KEY UPDATE baseline_id = baseline_id$/, 'a replay writes the same rows again');
  }
  assert.equal(fieldInserts[0].params[fieldInserts[0].params.length - 4], 1, 'store_values is written as 1/0');
  const marks = queries.filter(q => q.sql.startsWith('UPDATE va_baseline SET cause'));
  assert.deepEqual(marks.map(q => q.params.slice(0, 2)),
    [['DRIFT_DECISION', 1], ['PARENT_CAPTURE', 1], ['LINK_RECORD', 0]]);
  assert.match(marks[0].sql, /WHERE state = 'CAPTURING' AND baseline_id IN \(FROM_BASE64\(\?\)\)/);
});

test('a version that is not CAPTURING, or not marked as asked, refuses the capture', async () => {
  const { query } = recorder({ marked: 0 });
  await assert.rejects(() => writeVersionEvidence({ query, entries: [entry(1, 'OWN_TRANSITION')] }),
    error => error.reason === 'CAPTURE_INCOMPLETE');
});

test('a missing evidence table or column means the migration has not run yet', async () => {
  const noTable = Object.assign(new Error("Table 'va_baseline_field' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
  const noColumn = Object.assign(new Error("Unknown column 'policy_recorded' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' });
  assert.equal(isMissingSchema(noTable), true);
  assert.equal(isMissingSchema(noColumn), true);
  assert.equal(isMissingSchema(new Error('Duplicate entry')), false);
  for (const error of [noTable, noColumn]) {
    await assert.rejects(() => writeVersionEvidence({ query: async () => { throw error; }, entries: [entry(1, 'OWN_TRANSITION')] }),
      e => e.reason === 'SCHEMA_PENDING');
  }
});

test('evidence reads back decoded', async () => {
  const query = async sql => {
    if (/FROM va_baseline_field/.test(sql)) return [{ ...fieldRow, store_values: 1, restorable: null }];
    if (/FROM va_baseline_rule/.test(sql)) return [{ ...ruleRow, imposed_by_baseline_id: Buffer.alloc(16, 9).toString('base64') }];
    if (/FROM va_baseline_signature/.test(sql)) return [{ ...sigRow, approval_id: Buffer.alloc(16, 1).toString('base64') }];
    if (/FROM va_baseline_link/.test(sql)) return [];
    return [];
  };
  const read = await readVersionEvidence(Buffer.alloc(16, 2), query);
  assert.deepEqual(read.fields[0].required_by, ['k1']);
  assert.equal(read.fields[0].store_values, true);
  assert.equal(read.fields[0].restorable, null);
  assert.deepEqual(read.rules[0].approvers, [{ role: 'REVIEWER', assurance: 'ESIGNATURE' }]);
  assert.ok(read.rules[0].imposed_by_baseline_id.equals(Buffer.alloc(16, 9)));
  assert.ok(read.signatures[0].approval_id.equals(Buffer.alloc(16, 1)));
  assert.deepEqual(read.signatures[0].fields_covered, ['summary']);
  assert.deepEqual(read.links, []);
});

test('child pins and node security levels are written in batched CASE statements, and nothing for none', async () => {
  const { queries, query } = recorder();
  await pinChildVersions({ query, parentBaselineId: Buffer.alloc(16, 7),
    pins: [{ issueId: 2, baselineId: Buffer.alloc(16, 4), version: 5 }, { issueId: 3, baselineId: Buffer.alloc(16, 6), version: 1 }] });
  await recordNodeSecurity({ query, baselineId: Buffer.alloc(16, 7), levels: [{ issueId: 3, securityLevelId: '10000' }] });
  await recordNodeSecurity({ query, baselineId: Buffer.alloc(16, 7), levels: [] });
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /SET child_baseline_id = CASE current_issue_id WHEN \? THEN FROM_BASE64\(\?\) WHEN \? THEN FROM_BASE64\(\?\) END/);
  assert.match(queries[0].sql, /current_issue_id IN \(\?, \?\)$/);
  assert.equal((queries[0].sql.match(/\?/g) ?? []).length, queries[0].params.length);
  assert.match(queries[1].sql, /SET security_level_id = CASE current_issue_id WHEN \? THEN \? END/);
});

test('a link record copies its source version\'s pins node by node', async () => {
  const { queries, query } = recorder();
  await copyNodePins({ query, fromBaselineId: Buffer.alloc(16, 1), toBaselineId: Buffer.alloc(16, 2) });
  assert.match(queries[0].sql, /UPDATE va_baseline_node d JOIN va_baseline_node s ON s.baseline_id = FROM_BASE64\(\?\) AND s.logical_node_id = d.logical_node_id/);
  assert.deepEqual(queries[0].params, [Buffer.alloc(16, 1).toString('base64'), Buffer.alloc(16, 2).toString('base64')]);
});
```

Create `test/schema-pending.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { retryEvent } from '../src/triggers/retry.js';
import { captureFailure } from '../src/lib/capture.js';
import { FailClosed, DENY } from '../src/lib/errors.js';

test('SCHEMA_PENDING keeps retrying past the five-minute migration window', () => {
  let waited = 0;
  for (let count = 0; count < 6; count += 1) {
    const retry = retryEvent({ retryContext: { retryCount: count } }, 'SCHEMA_PENDING');
    assert.ok(!retry.retryExhausted, `retry ${count}`);
    waited += Math.min(900, 15 * (2 ** count));
  }
  assert.ok(waited > 300, `waited ${waited}s`);
  assert.equal(retryEvent({ retryContext: { retryCount: 6 } }, 'SCHEMA_PENDING').retryExhausted, true);
  assert.equal(retryEvent({ retryContext: { retryCount: 4 } }, 'CAPTURE_FAILED').retryExhausted, true,
    'every other reason keeps its budget');
});

test('a governed refusal inside a capture reports its own reason, so it is retried as that', () => {
  assert.equal(captureFailure(new FailClosed('SCHEMA_PENDING')).reason, 'SCHEMA_PENDING');
  assert.equal(captureFailure(new Error('socket hang up')).reason, 'ERROR');
  assert.match(DENY.SCHEMA_PENDING, /finishing an update/);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/evidence-store.test.js test/schema-pending.test.js`
Expected: FAIL with `Cannot find module '…/src/db/evidenceStore.js'`.

- [ ] **Step 3: Create `src/db/evidenceStore.js`**

```js
import * as store from './store.js';
import { toBinaryParam, fromBinaryColumn, isUnknownColumn } from '../lib/db.js';
import { FailClosed } from '../lib/errors.js';

/**
 * THE EVIDENCE ROWS OF A BASELINE VERSION
 * (docs/specs/2026-10-03-baseline-evidence-model-design.md §4).
 *
 * Written while the version is CAPTURING, before it publishes: a new capture's
 * publication requires `policy_recorded` (db/baselineStore.js and friends).
 * Rows are written once. A replay of the same capture writes the same rows,
 * and `ON DUPLICATE KEY UPDATE baseline_id = baseline_id` makes that a no-op.
 * Batched across versions: a parent capture writes every child's evidence in a
 * few statements, not a few per child (the 25s ceiling, as in baselineTreeStore).
 */
const BATCH = 50;
const chunks = (rows, size = BATCH) => {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};
const bin = id => toBinaryParam(Buffer.from(id));
const binOrNull = id => (id == null ? null : bin(id));
const flag = value => (value == null ? null : (value ? 1 : 0));

/** The migration has not run on this site yet (deploy to five-minute job). */
export function isMissingSchema(error) {
  if (isUnknownColumn(error)) return true;
  const code = error?.code ?? error?.context?.debug?.code;
  return code === 'ER_NO_SUCH_TABLE' || /doesn't exist|does not exist/i.test(error?.message ?? '');
}

const TABLES = {
  va_baseline_field: ['baseline_id', 'field_id', 'label', 'label_source', 'kind', 'schema_type', 'materiality',
    'store_values', 'restorable', 'digest', 'required_by'],
  va_baseline_rule: ['baseline_id', 'rule_key', 'source', 'project_id', 'issue_type_id', 'transition_id', 'approvers',
    'controlled_fields_hash', 'imposed_by_baseline_id', 'imposed_by_version'],
  va_baseline_signature: ['baseline_id', 'approval_id', 'signer_account_id', 'signer_name', 'role', 'assurance', 'cause',
    'cause_baseline_id', 'decision_id', 'transition_id', 'from_status_id', 'to_status_id', 'transition_at',
    'status_at_capture', 'fields_covered', 'signed_at'],
  va_baseline_link: ['baseline_id', 'link_id', 'link_type', 'direction', 'other_issue_id', 'other_issue_key',
    'other_baseline_id', 'other_baseline_version']
};
const BINARY = new Set(['baseline_id', 'imposed_by_baseline_id', 'approval_id', 'cause_baseline_id', 'decision_id',
  'other_baseline_id']);
const FLAGS = new Set(['store_values', 'restorable']);

async function insertRows(query, table, rows) {
  const columns = TABLES[table];
  const one = `(${columns.map(c => (BINARY.has(c) ? 'FROM_BASE64(?)' : '?')).join(', ')})`;
  for (const batch of chunks(rows)) {
    await query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${batch.map(() => one).join(', ')}
       ON DUPLICATE KEY UPDATE baseline_id = baseline_id`,
      batch.flatMap(row => columns.map(c => (BINARY.has(c) ? binOrNull(row[c]) : FLAGS.has(c) ? flag(row[c]) : row[c] ?? null)))
    );
  }
}

export async function writeVersionEvidence({ entries, query = store.throwing }) {
  if (!entries?.length) return { written: 0 };
  const tagged = key => entries.flatMap(entry => (key === 'links' ? entry.links ?? [] : entry.evidence?.[key] ?? [])
    .map(row => ({ ...row, baseline_id: entry.baselineId })));
  try {
    await insertRows(query, 'va_baseline_field', tagged('fields'));
    await insertRows(query, 'va_baseline_rule', tagged('rules'));
    await insertRows(query, 'va_baseline_signature', tagged('signatures'));
    await insertRows(query, 'va_baseline_link', tagged('links'));
    const groups = new Map();
    for (const entry of entries) {
      const recorded = (entry.evidence?.fields?.length ?? 0) > 0 && (entry.evidence?.rules?.length ?? 0) > 0;
      const key = `${entry.cause}|${recorded}`;
      if (!groups.has(key)) groups.set(key, { cause: entry.cause, recorded, ids: [] });
      groups.get(key).ids.push(entry.baselineId);
    }
    for (const { cause, recorded, ids } of groups.values()) {
      for (const batch of chunks(ids)) {
        const list = batch.map(() => 'FROM_BASE64(?)').join(', ');
        const params = [cause, recorded ? 1 : 0, ...batch.map(bin)];
        await query(`UPDATE va_baseline SET cause = ?, policy_recorded = ?
          WHERE state = 'CAPTURING' AND baseline_id IN (${list})`, params);
        // Counted rather than read from affectedRows: a replay that sets the
        // same values changes no rows, and must not read as a failure.
        const [counted] = await query(`SELECT COUNT(*) AS n FROM va_baseline
          WHERE cause = ? AND policy_recorded = ? AND state = 'CAPTURING' AND baseline_id IN (${list})`, params);
        if (Number(counted?.n) !== batch.length) throw new FailClosed('CAPTURE_INCOMPLETE');
      }
    }
  } catch (error) {
    if (isMissingSchema(error)) throw new FailClosed('SCHEMA_PENDING', error);
    throw error;
  }
  return { written: entries.length };
}

const parse = text => (typeof text === 'string' ? JSON.parse(text) : text ?? null);
const asBool = value => (value == null ? null : value === true || value === 1 || value === '1');
const asNumber = value => (value == null ? null : Number(value));

export async function readVersionEvidence(baselineId, query = store.throwing) {
  const id = bin(baselineId);
  try {
    const [fields, rules, signatures, links] = await Promise.all([
      query(`SELECT field_id, label, label_source, kind, schema_type, materiality, store_values, restorable, digest, required_by
        FROM va_baseline_field WHERE baseline_id = FROM_BASE64(?) ORDER BY field_id`, [id]),
      query(`SELECT rule_key, source, project_id, issue_type_id, transition_id, approvers, controlled_fields_hash,
        TO_BASE64(imposed_by_baseline_id) AS imposed_by_baseline_id, imposed_by_version
        FROM va_baseline_rule WHERE baseline_id = FROM_BASE64(?) ORDER BY rule_key`, [id]),
      query(`SELECT TO_BASE64(approval_id) AS approval_id, signer_account_id, signer_name, role, assurance, cause,
        TO_BASE64(cause_baseline_id) AS cause_baseline_id, TO_BASE64(decision_id) AS decision_id, transition_id,
        from_status_id, to_status_id, transition_at, status_at_capture, fields_covered, signed_at
        FROM va_baseline_signature WHERE baseline_id = FROM_BASE64(?) ORDER BY signed_at, approval_id`, [id]),
      query(`SELECT link_id, link_type, direction, other_issue_id, other_issue_key,
        TO_BASE64(other_baseline_id) AS other_baseline_id, other_baseline_version
        FROM va_baseline_link WHERE baseline_id = FROM_BASE64(?) ORDER BY link_id`, [id])
    ]);
    return {
      fields: fields.map(row => ({ ...row, store_values: asBool(row.store_values) === true,
        restorable: asBool(row.restorable), required_by: parse(row.required_by) })),
      rules: rules.map(row => ({ ...row, project_id: Number(row.project_id), approvers: parse(row.approvers),
        imposed_by_baseline_id: fromBinaryColumn(row.imposed_by_baseline_id ?? null),
        imposed_by_version: asNumber(row.imposed_by_version) })),
      signatures: signatures.map(row => ({ ...row, approval_id: fromBinaryColumn(row.approval_id),
        cause_baseline_id: fromBinaryColumn(row.cause_baseline_id ?? null),
        decision_id: fromBinaryColumn(row.decision_id ?? null), transition_at: asNumber(row.transition_at),
        fields_covered: parse(row.fields_covered), signed_at: Number(row.signed_at) })),
      links: links.map(row => ({ ...row, other_issue_id: Number(row.other_issue_id),
        other_baseline_id: fromBinaryColumn(row.other_baseline_id ?? null),
        other_baseline_version: asNumber(row.other_baseline_version) }))
    };
  } catch (error) {
    if (isMissingSchema(error)) throw new FailClosed('SCHEMA_PENDING', error);
    throw error;
  }
}

// Node columns, batched as CASE updates (the same pattern as baselineStore's
// writability update). Written out per column so each statement reads on its own.
export async function pinChildVersions({ parentBaselineId, pins, query = store.throwing }) {
  for (const batch of chunks(pins ?? [])) {
    const ids = batch.map(pin => Number(pin.issueId));
    await query(
      `UPDATE va_baseline_node
       SET child_baseline_id = CASE current_issue_id ${batch.map(() => 'WHEN ? THEN FROM_BASE64(?)').join(' ')} END,
           child_version = CASE current_issue_id ${batch.map(() => 'WHEN ? THEN ?').join(' ')} END
       WHERE baseline_id = FROM_BASE64(?) AND current_issue_id IN (${ids.map(() => '?').join(', ')})`,
      [...batch.flatMap(pin => [Number(pin.issueId), bin(pin.baselineId)]),
        ...batch.flatMap(pin => [Number(pin.issueId), Number(pin.version)]),
        bin(parentBaselineId), ...ids]
    );
  }
}

export async function recordNodeSecurity({ baselineId, levels, query = store.throwing }) {
  for (const batch of chunks(levels ?? [])) {
    const ids = batch.map(level => Number(level.issueId));
    await query(
      `UPDATE va_baseline_node
       SET security_level_id = CASE current_issue_id ${batch.map(() => 'WHEN ? THEN ?').join(' ')} END
       WHERE baseline_id = FROM_BASE64(?) AND current_issue_id IN (${ids.map(() => '?').join(', ')})`,
      [...batch.flatMap(level => [Number(level.issueId), String(level.securityLevelId)]), bin(baselineId), ...ids]
    );
  }
}

/** A link record's children are copied from its source version: so are their pins. */
export async function copyNodePins({ fromBaselineId, toBaselineId, query = store.throwing }) {
  await query(
    `UPDATE va_baseline_node d JOIN va_baseline_node s ON s.baseline_id = FROM_BASE64(?) AND s.logical_node_id = d.logical_node_id
     SET d.child_baseline_id = s.child_baseline_id, d.child_version = s.child_version, d.security_level_id = s.security_level_id
     WHERE d.baseline_id = FROM_BASE64(?)`,
    [bin(fromBaselineId), bin(toBaselineId)]
  );
}
```

The file exports `isMissingSchema`, `writeVersionEvidence`, `readVersionEvidence`, `pinChildVersions`, `recordNodeSecurity` and `copyNodePins`.

- [ ] **Step 4: Add the refusal text, the retry budget and `captureFailure`**

In `src/lib/errors.js`, add this entry inside `DENY` after `CAPTURE_INCOMPLETE`:

```js
  SCHEMA_PENDING: 'VAtlassian is finishing an update, so nothing was changed. Try again in a few minutes.',
```

In `src/triggers/retry.js`, replace `retryEvent` with:

```js
// A capture refused because the five-minute migration job has not yet run
// (SCHEMA_PENDING) must outlast that window: 15+30+60+120+240+480s > 300s.
const MAX_RETRIES = { SCHEMA_PENDING: 6 };

export function retryEvent(event, reason) {
  const count = Number(event?.retryContext?.retryCount ?? 0);
  if (count >= (MAX_RETRIES[reason] ?? 4)) return { retryExhausted: true, reason };
  return new InvocationError({ retryAfter: Math.min(900, 15 * (2 ** count)),
    retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
    retryData: { reason: String(reason).slice(0, 64) } });
}
```

In `src/lib/capture.js`:
- add `import { FailClosed } from './errors.js';` (if it isn't already imported);
- replace `captureBaseline` and add `captureFailure` above it:

```js
/** A capture that threw: a governed refusal keeps its reason, so the trigger retries it as that. */
export function captureFailure(error) {
  return { captured: false, reason: error instanceof FailClosed ? error.reason : 'ERROR',
    error: String(error?.message ?? error) };
}

/** Trigger capture consumes an existing approval; it never manufactures one. */
export async function captureBaseline(args) {
  try { return await run({ now: Date.now(), ...args }); }
  catch (error) {
    console.error('capture failed', args.issueId, error);
    return captureFailure(error);
  }
}
```

`src/triggers/issue-transitioned.js` already calls `retryEvent(event, result.reason ?? 'CAPTURE_FAILED')` for any failure not in its skip list, so `SCHEMA_PENDING` now gets the longer budget there with no change to that file.

- [ ] **Step 5: Run them and see them pass**

Run: `node --test test/evidence-store.test.js test/schema-pending.test.js && npm test 2>&1 | tail -6`
Expected: PASS, and `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/db/evidenceStore.js src/lib/errors.js src/triggers/retry.js src/lib/capture.js test/evidence-store.test.js test/schema-pending.test.js
git commit -m "feat(evidence): store version evidence in batches; retry captures across the migration window" -- src/db/evidenceStore.js src/lib/errors.js src/triggers/retry.js src/lib/capture.js test/evidence-store.test.js test/schema-pending.test.js
```

---

### Task 7: A single-issue capture writes its evidence, and cannot publish without it

**Files:**
- Modify: `src/lib/tree/nodeFields.js` (`scopeForItem` returns the governing root's baseline; new `fieldScope`)
- Modify: `src/db/baselineStore.js` (`writeBaseline` takes `evidence`)
- Modify: `src/lib/capture.js` (`run`, `writeCapturedBaseline`)
- Modify: `src/usecases/panelAccess.js` (`snapshot` exposes `ruleScope`)
- Modify: `src/usecases/drift.js` (`applyApproval` passes `ruleScope` and `cause` into both captures)
- Test: `test/tree-node-fields.test.js`, `test/baseline-storage.test.js`, `test/baseline-capture-lifecycle.test.js`

**Interfaces:**
- Consumes: `versionEvidence`, `linkRows`, `trackedLinks`, `linkedIssueIds`, `CAUSE`, `RULE_SOURCE` (Task 5); `writeVersionEvidence` (Task 6).
- Produces:
  - `fieldScope(item, { activeRootsForNode, controlledFields }) → { fields, ruleScope: { source, projectId, issueTypeId, imposedByBaselineId, imposedByVersion } }`
  - `writeBaseline({ …, evidence: { evidence, links, cause, required } | null, writeEvidence })`
  - `writeCapturedBaseline({ …, cause, ruleScope }, deps + activeBaselines)`
  - `snapshot(...)` result gains `ruleScope`.

- [ ] **Step 1: Write the failing tests**

Append to `test/tree-node-fields.test.js` (add `fieldScope` to its existing import from `../src/lib/tree/nodeFields.js`):

```js
test('an item\'s fields come with the rule scope they came from, and the version that imposed it', async () => {
  const controlledFields = async ({ projectId, issueTypeId }) => [{ field_id: `${projectId}:${issueTypeId}` }];
  const own = await fieldScope({ issueId: 7, projectId: 1, issueTypeId: 'T' },
    { activeRootsForNode: async () => [], controlledFields });
  assert.deepEqual(own.fields, [{ field_id: '1:T' }]);
  assert.deepEqual(own.ruleScope, { source: 'OWN', projectId: 1, issueTypeId: 'T', imposedByBaselineId: null, imposedByVersion: null });
  const root = { rootIssueId: 1, baselineId: Buffer.alloc(16, 2), version: 4, projectId: 1, issueTypeId: 'E', capturedAt: 10 };
  const child = await fieldScope({ issueId: 7, projectId: 1, issueTypeId: 'T' },
    { activeRootsForNode: async () => [root], controlledFields });
  assert.deepEqual(child.fields, [{ field_id: '1:E' }]);
  assert.equal(child.ruleScope.source, 'INHERITED');
  assert.deepEqual([child.ruleScope.projectId, child.ruleScope.issueTypeId], [1, 'E']);
  assert.ok(child.ruleScope.imposedByBaselineId.equals(Buffer.alloc(16, 2)));
  assert.equal(child.ruleScope.imposedByVersion, 4);
});
```

Append to `test/baseline-storage.test.js`:

```js
test('a capture\'s evidence is written before publication, and publication requires it', async () => {
  const order = [];
  await writeBaseline({
    baseline: provenancedBaseline(), raw: {},
    evidence: { required: true, cause: 'OWN_TRANSITION', links: [], evidence: { fields: [], rules: [], signatures: [] } },
    writeEvidence: async ({ entries }) => { order.push(['evidence', entries[0].cause, entries[0].baselineId.length]); },
    query: async sql => {
      if (sql.includes("SET state = 'ACTIVE'")) { order.push(['publish', sql]); return { affectedRows: 1 }; }
      return [];
    },
    execute: async () => ({ result: true, data: {} })
  });
  assert.deepEqual(order[0], ['evidence', 'OWN_TRANSITION', 16]);
  assert.equal(order[1][0], 'publish');
  assert.match(order[1][1], /AND policy_recorded = TRUE/);
});

test('a version without required evidence publishes on its provenance alone', async () => {
  let publish;
  await writeBaseline({
    baseline: provenancedBaseline(), raw: {},
    evidence: { required: false, cause: 'LINK_RECORD', links: [], evidence: { fields: [], rules: [], signatures: [] } },
    writeEvidence: async () => {},
    query: async sql => { if (sql.includes("SET state = 'ACTIVE'")) { publish = sql; return { affectedRows: 1 }; } return []; },
    execute: async () => ({ result: true, data: {} })
  });
  assert.doesNotMatch(publish, /policy_recorded/);
});
```

In `test/baseline-capture-lifecycle.test.js`, change `fixture()` so that:
- `args` also contains `ruleScope: { source: 'OWN', projectId: 2, issueTypeId: '3', imposedByBaselineId: null, imposedByVersion: null }`;
- `deps` also contains `activeBaselines: async () => new Map()`.

The new `fixture()` reads:

```js
function fixture() {
  const args = { issueId: 1, issueKey: 'VA-1', projectId: 2, issueTypeId: '3', controlledFields: fields,
    issueFields: { summary: 'Approved' }, editmetaFields: { summary: {} }, transitionAt: 100, capturedAt: 100,
    transitionId: '31', fromStatusId: 'review', toStatusId: 'approved',
    requiredRole: 'Quality Reviewer', requiredAssurance: 'ESIGNATURE',
    ruleScope: { source: 'OWN', projectId: 2, issueTypeId: '3', imposedByBaselineId: null, imposedByVersion: null },
    approver: { approvalId: Buffer.alloc(16, 1), accountId: 'a', assuranceLevel: 'ESIGNATURE',
      contentHash: project({ summary: 'Approved' }, fields).contentHash } };
  const calls = [];
  let written = null;
  const deps = { baselineForApproval: async () => null, currentVersion: async () => 0,
    writeBaseline: async args => { calls.push('write'); written = args; return { baselineId: Buffer.alloc(16, 2) }; },
    assignReviewer: async () => ({ accountId: 'a' }), upsertBaselined: async () => calls.push('publish'),
    tryAppend: async () => calls.push('audit'), getReview: async () => null,
    activeBaselines: async () => new Map() };
  return { args, deps, calls, written: () => written };
}
```

Then append:

```js
test('a capture hands the write its evidence, and the write must require it', async () => {
  const { args, deps, written } = fixture();
  assert.equal((await writeCapturedBaseline(args, deps)).captured, true);
  const { evidence } = written();
  assert.equal(evidence.required, true);
  assert.equal(evidence.cause, 'OWN_TRANSITION');
  assert.deepEqual(evidence.evidence.fields.map(f => [f.field_id, f.materiality, f.restorable]), [['summary', 'MAJOR', true]]);
  assert.equal(evidence.evidence.rules[0].source, 'OWN');
  assert.equal(evidence.evidence.rules[0].approvers, JSON.stringify([{ role: 'Quality Reviewer', assurance: 'ESIGNATURE' }]));
  assert.equal(evidence.evidence.signatures[0].signer_account_id, 'a');
  assert.equal(evidence.evidence.signatures[0].transition_id, '31');
  assert.deepEqual(evidence.links, [], 'no link field tracked, no links recorded');
});

test('a capture of a child held to its parent\'s fields records that rule as inherited from that parent', async () => {
  const { args, deps, written } = fixture();
  args.ruleScope = { source: 'INHERITED', projectId: 2, issueTypeId: 'epic', imposedByBaselineId: Buffer.alloc(16, 9), imposedByVersion: 6 };
  args.cause = 'DRIFT_DECISION';
  await writeCapturedBaseline(args, deps);
  const { evidence } = written();
  assert.equal(evidence.cause, 'DRIFT_DECISION');
  assert.equal(evidence.evidence.rules[0].source, 'INHERITED');
  assert.equal(evidence.evidence.rules[0].issue_type_id, 'epic');
  assert.equal(evidence.evidence.rules[0].imposed_by_version, 6);
});

test('a capture without its rule scope is refused before anything is written', async () => {
  const { args, deps, calls } = fixture();
  args.ruleScope = null;
  assert.equal((await writeCapturedBaseline(args, deps)).reason, 'BASELINE_POLICY_INCOMPLETE');
  assert.deepEqual(calls, []);
});

test('tracked links are recorded with the other end\'s version at that moment', async () => {
  const { args, deps, written } = fixture();
  const linksField = { field_id: 'issuelinks', field_kind: 'LINKS', schema_type: 'array', materiality: 'MAJOR',
    store_values: true, writable: false };
  const links = [{ id: '15539', type: { id: '10022', name: 'Deployments' }, outwardIssue: { id: '43903', key: 'VAT-3' } }];
  args.controlledFields = [...fields, linksField];
  args.issueFields = { summary: 'Approved', issuelinks: links };
  args.approver.contentHash = project(args.issueFields, args.controlledFields).contentHash;
  const asked = [];
  deps.activeBaselines = async ids => { asked.push(ids); return new Map([[43903, { baseline_id: Buffer.alloc(16, 5), version: 4 }]]); };
  assert.equal((await writeCapturedBaseline(args, deps)).captured, true);
  assert.deepEqual(asked, [[43903]]);
  assert.deepEqual(written().evidence.links.map(l => [l.link_id, l.direction, l.other_issue_key, l.other_baseline_version]),
    [['15539', 'OUTWARD', 'VAT-3', 4]]);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/tree-node-fields.test.js test/baseline-storage.test.js test/baseline-capture-lifecycle.test.js`
Expected: FAIL. `fieldScope` is not exported, `order[0]` is undefined, and `evidence` is undefined.

- [ ] **Step 3: `fieldScope` in `src/lib/tree/nodeFields.js`**

At the top, add `import { RULE_SOURCE } from '../evidence/versionEvidence.js';`. In `scopeForItem`, replace the governing-root return line:

```js
  return { projectId: Number(governing.projectId), issueTypeId: String(governing.issueTypeId),
    source: 'governing-root', rootIssueId: Number(governing.rootIssueId) };
```

with:

```js
  return { projectId: Number(governing.projectId), issueTypeId: String(governing.issueTypeId),
    source: 'governing-root', rootIssueId: Number(governing.rootIssueId),
    rootBaselineId: governing.baselineId ?? null, rootVersion: governing.version ?? null };
```

Replace `fieldsForItem` with:

```js
/**
 * The fields an item tracks AND the rule scope they came from, from one
 * lookup: a capture records which rule required its fields
 * (docs/specs/2026-10-03-baseline-evidence-model-design.md §4). Fields held to
 * a governing root are recorded as INHERITED from that root's version.
 */
export async function fieldScope(item, deps) {
  const scope = await scopeForItem(item, deps);
  const fields = await deps.controlledFields({ projectId: scope.projectId, issueTypeId: scope.issueTypeId });
  const inherited = scope.source === 'governing-root';
  return {
    fields,
    ruleScope: {
      source: inherited ? RULE_SOURCE.INHERITED : RULE_SOURCE.OWN,
      projectId: Number(scope.projectId),
      issueTypeId: String(scope.issueTypeId),
      imposedByBaselineId: inherited ? scope.rootBaselineId : null,
      imposedByVersion: inherited && scope.rootVersion != null ? Number(scope.rootVersion) : null
    }
  };
}

export async function fieldsForItem(item, deps) {
  return (await fieldScope(item, deps)).fields;
}
```

- [ ] **Step 4: `writeBaseline` takes evidence (`src/db/baselineStore.js`)**

Add `import { writeVersionEvidence } from './evidenceStore.js';` to the imports. Change the signature to:

```js
export async function writeBaseline({ baseline, values, raw, writable, resume = null, evidence = null,
  query = throwing, execute = executeQuery, writeEvidence = writeVersionEvidence }) {
```

Immediately before `const activated = await query(`, insert:

```js
  // THE VERSION'S EVIDENCE, WHILE IT IS STILL CAPTURING (db/evidenceStore.js).
  // A new capture requires it at publication, below; a link record whose
  // source never recorded its policy passes required: false.
  if (evidence) {
    await writeEvidence({ query, entries: [{ baselineId, evidence: evidence.evidence,
      links: evidence.links ?? [], cause: evidence.cause }] });
  }
  const evidenceClause = evidence?.required === true ? ' AND policy_recorded = TRUE' : '';
```

Change the activation statement's last condition line from:

```js
       AND controlled_fields_hash IS NOT NULL`,
```

to:

```js
       AND controlled_fields_hash IS NOT NULL${evidenceClause}`,
```

- [ ] **Step 5: `writeCapturedBaseline` builds the evidence (`src/lib/capture.js`)**

1. **Imports.**
   - Replace `import { readTreeWithNodeFields, fieldsForItem } from './tree/nodeFields.js';` with `import { readTreeWithNodeFields, fieldScope } from './tree/nodeFields.js';`.
   - Replace `import { writeBaseline, currentVersion, baselineForApproval } from '../db/baselineStore.js';` with `import { writeBaseline, currentVersion, baselineForApproval, activeBaselines } from '../db/baselineStore.js';`.
   - Add:

```js
import { versionEvidence, linkRows, trackedLinks, linkedIssueIds, CAUSE } from './evidence/versionEvidence.js';
```

2. **`run()`.** Replace:

```js
  const [config, declared, gate] = await Promise.all([
    // The same set the validator's signature check hashed (approval/runtime.js).
    projectConfig(projectId),
    fieldsForItem({ issueId: Number(issue.id), projectId, issueTypeId }, { activeRootsForNode, controlledFields }),
```

with:

```js
  const [config, scoped, gate] = await Promise.all([
    // The same set the validator's signature check hashed (approval/runtime.js).
    projectConfig(projectId),
    fieldScope({ issueId: Number(issue.id), projectId, issueTypeId }, { activeRootsForNode, controlledFields }),
```

Directly after that `Promise.all` statement, add `const declared = scoped.fields;`. In the `return writeCapturedBaseline({ … })` call at the end of `run()`, add `ruleScope: scoped.ruleScope, cause: CAUSE.OWN_TRANSITION,` after `reviewerFieldId: config.reviewerFieldId ?? null`.

3. **`writeCapturedBaseline` signature.** Replace the signature with:

```js
export async function writeCapturedBaseline({ issueId, issueKey, projectId, issueTypeId,
  controlledFields: fields, issueFields, editmetaFields = {}, transitionAt, capturedAt,
  approver, transitionId = null, fromStatusId = null, toStatusId = null,
  changelogEntries = [], changelogFailed = false, requiredRole, requiredAssurance,
  reviewerFieldId = null, cause = CAUSE.OWN_TRANSITION, ruleScope = null },
  deps = { baselineForApproval, currentVersion, writeBaseline, assignReviewer, upsertBaselined, tryAppend, getReview,
    activeBaselines }) {
  if (!fields?.length) return { captured: false, reason: 'NO_TRACKED_FIELDS' };
  if (!approver?.approvalId || !approver?.assuranceLevel) return { captured: false, reason: 'NO_APPROVAL' };
  // Which rule required these fields is part of the record (evidence/versionEvidence.js).
  if (!ruleScope) return { captured: false, reason: 'BASELINE_POLICY_INCOMPLETE' };
```

The two existing guard lines are kept; only the `ruleScope` line is new.

4. **Build the evidence.** Directly before `const result = existing && existing.state !== 'CAPTURING' ? { baselineId: existing.baseline_id }`, insert:

```js
  // THE EVIDENCE THIS VERSION PUBLISHES WITH. Built from exactly what was
  // projected and checked above; writeBaseline writes it before publishing and
  // refuses to publish without it.
  const writesVersion = !existing || existing.state === 'CAPTURING';
  let evidence = null;
  if (writesVersion) {
    const links = trackedLinks(fields, issueFields);
    const others = linkedIssueIds(links);
    const otherVersions = others.length ? await deps.activeBaselines(others) : new Map();
    evidence = {
      required: true,
      cause,
      links: linkRows({ links, otherVersions }),
      evidence: versionEvidence({
        fields, digests: plan.digests, writable: plan.writable,
        rule: { ...ruleScope, transitionId, approvers: [{ role: requiredRole, assurance: requiredAssurance }],
          controlledFieldsHash: plan.baseline.controlled_fields_hash },
        signature: { approvalId: approver.approvalId, signerAccountId: approver.accountId,
          signerName: approver.displayName ?? 'Unknown', role: requiredRole, assurance: approver.assuranceLevel,
          cause, transitionId, fromStatusId, toStatusId, transitionAt,
          statusAtCapture: issueFields?.status?.id ?? null, signedAt: capturedAt }
      })
    };
  }
```

Then pass `evidence` into both `deps.writeBaseline` calls in the `result` expression:

```js
  const result = existing && existing.state !== 'CAPTURING' ? { baselineId: existing.baseline_id }
    : existing
      ? await deps.writeBaseline({ ...plan, resume: existing, evidence })
      : await writeWithVersionRetry(deps.currentVersion, issueId, version, async freshVersion => {
          version = freshVersion;
          return deps.writeBaseline({ ...plan, baseline: { ...plan.baseline, version: freshVersion }, resume: existing, evidence });
        });
```

- [ ] **Step 6: The panel snapshot exposes the rule scope (`src/usecases/panelAccess.js`)**

Change the import `import { readTreeWithNodeFields, fieldsForItem } from '../lib/tree/nodeFields.js';` to `import { readTreeWithNodeFields, fieldScope } from '../lib/tree/nodeFields.js';`. In `snapshot`, replace:

```js
  const [declared, config, baseline, review, edge, editResponse] = await Promise.all([
    fieldsForItem({ issueId, projectId, issueTypeId }, { activeRootsForNode, controlledFields }),
```

with:

```js
  const [scoped, config, baseline, review, edge, editResponse] = await Promise.all([
    fieldScope({ issueId, projectId, issueTypeId }, { activeRootsForNode, controlledFields }),
```

Directly after that statement, add `const declared = scoped.fields;`. In the final `return { … }` of `snapshot`, add `ruleScope: scoped.ruleScope,` after `coveredBy, eligible, fields,`.

- [ ] **Step 7: `applyApproval` passes the cause and the rule scope (`src/usecases/drift.js`)**

Add `import { CAUSE } from '../lib/evidence/versionEvidence.js';` to the imports. Inside `applyApproval`, directly after `let capture = { captured: false, reason: 'CAPTURE_DISABLED' };`, add:

```js
    // A workflow transition approved here is the item's own transition; an
    // approval bound to its baseline is a drift decision.
    const cause = forTransition ? CAUSE.OWN_TRANSITION : CAUSE.DRIFT_DECISION;
```

Then make three edits:
- In the `writeCapturedTreeBaseline({ … })` call, add `ruleScope: checked.ruleScope, cause,` after `controlledFields: checked.fields,`.
- In the `writeCapturedBaseline({ … })` call, add `ruleScope: checked.ruleScope, cause,` after `controlledFields: checked.fields,`.
- In the same call, replace `requiredRole: checked.gate?.required_role, reviewerFieldId: checked.config.reviewerFieldId });` with:

```js
          requiredRole: checked.gate?.required_role, requiredAssurance: checked.gate?.required_assurance,
          reviewerFieldId: checked.config.reviewerFieldId });
```

  This call never passed `requiredAssurance`, so its capture could only be refused as `BASELINE_POLICY_INCOMPLETE`. The rule's approvers need it.

- [ ] **Step 8: Run the tests and see them pass**

Run: `node --test test/tree-node-fields.test.js test/baseline-storage.test.js test/baseline-capture-lifecycle.test.js && npm test 2>&1 | tail -6`
Expected: PASS, and `ℹ fail 0`. If an existing test elsewhere calls `writeCapturedBaseline` without `ruleScope` and now gets `BASELINE_POLICY_INCOMPLETE`, add `ruleScope: { source: 'OWN', projectId: <its projectId>, issueTypeId: <its issueTypeId>, imposedByBaselineId: null, imposedByVersion: null }` to that test's arguments. Don't relax the guard.

- [ ] **Step 9: Commit**

```bash
git add src/lib/tree/nodeFields.js src/db/baselineStore.js src/lib/capture.js src/usecases/panelAccess.js src/usecases/drift.js test/tree-node-fields.test.js test/baseline-storage.test.js test/baseline-capture-lifecycle.test.js
git commit -m "feat(capture): record each single-issue version's evidence and require it to publish" -- src/lib/tree/nodeFields.js src/db/baselineStore.js src/lib/capture.js src/usecases/panelAccess.js src/usecases/drift.js test/tree-node-fields.test.js test/baseline-storage.test.js test/baseline-capture-lifecycle.test.js
```

---

### Task 8: A tree capture writes evidence for the parent and every child, pins child versions, and records security levels

**Files:**
- Modify: `src/lib/capture.js` (`writeCapturedTreeBaseline`)
- Modify: `src/db/baselineTreeStore.js` (`publishTreeBaseline` takes `requireEvidence`)
- Modify: `src/db/childBaselineStore.js` (`publishChildBaselines` takes `requireEvidence`)
- Test: `test/child-baseline-capture.test.js`, `test/tree-storage.test.js`

**Interfaces:**
- Consumes: Tasks 5–7 (`ruleScope` and `cause` are already passed in by `applyApproval` since Task 7).
- Produces:
  - `writeCapturedTreeBaseline({ …, ruleScope, cause, deps })`, with new deps `writeVersionEvidence`, `pinChildVersions`, `recordNodeSecurity`, `activeBaselines`;
  - `publishTreeBaseline({ …, requireEvidence = false })`;
  - `publishChildBaselines({ …, requireEvidence = false })`.

- [ ] **Step 1: Write the failing tests**

In `test/child-baseline-capture.test.js`:

1. Change `const F = id => ({ field_id: id, field_kind: 'TEXT', store_values: true });` to:

```js
const F = id => ({ field_id: id, field_kind: 'TEXT', store_values: true, materiality: 'MAJOR' });
```

2. In `captureFixture()`, inside `args`, add `ruleScope: { source: 'OWN', projectId: 1, issueTypeId: 'S', imposedByBaselineId: null, imposedByVersion: null },` and `cause: 'DRIFT_DECISION',` after `transitionAt: 10,`. Inside `deps`, add:

```js
        writeVersionEvidence: async ({ entries }) => { calls.push(['evidence', entries.map(e => [e.cause, e.evidence.rules[0].source])]); evidenceEntries.push(...entries); },
        pinChildVersions: async ({ pins }) => { calls.push(['pins', pins.map(p => [p.issueId, p.version])]); },
        recordNodeSecurity: async ({ levels }) => { calls.push(['security', levels.length]); },
        activeBaselines: async () => new Map(),
```

   Also declare `const evidenceEntries = [];` next to `const ledger = [];` and return it from the fixture: `return { calls, itemStates, ledger, evidenceEntries, args: { … } };`.

3. Change the `publishTreeBaseline` and `publishChildBaselines` mocks to record their option:

```js
        publishTreeBaseline: async ({ requireEvidence }) => { calls.push(['publish-tree', requireEvidence]); },
        publishChildBaselines: async ({ requireEvidence }) => { calls.push(['publish-children', requireEvidence]); return { children: [] }; },
```

4. In the test `'a parent capture writes each child\'s baseline before it publishes and publishes them after'`, replace the `assert.deepEqual(f.calls, [ … ]);` with:

```js
  assert.deepEqual(f.calls, ['begin', 'write-tree', 'verify-tree', ['next-versions', [1, 2]], ['write-children', [[2, 5]]],
    ['evidence', [['DRIFT_DECISION', 'OWN'], ['PARENT_CAPTURE', 'INHERITED']]], ['pins', [[2, 5]]], ['security', 0],
    ['publish-tree', true], ['publish-children', true], ['item-state', 1], ['item-state', 2]]);
```

5. In `'a parent with no children writes no child baselines and reads no versions'`, change `assert.ok(!f.calls.includes('publish-children'));` to `assert.ok(!f.calls.some(c => Array.isArray(c) && c[0] === 'publish-children'));`.

6. Append:

```js
test('each child\'s version records the parent\'s rule as inherited from this capture, and the parent\'s signature', async () => {
  const f = captureFixture();
  await writeCapturedTreeBaseline(f.args);
  const [root, child] = f.evidenceEntries;
  assert.ok(root.baselineId.equals(parent.baselineId));
  assert.equal(root.evidence.rules[0].source, 'OWN');
  assert.equal(root.evidence.signatures[0].status_at_capture, '3');
  assert.ok(child.baselineId.equals(Buffer.alloc(16, 4)));
  const [rule] = child.evidence.rules;
  assert.equal(rule.source, 'INHERITED');
  assert.ok(rule.imposed_by_baseline_id.equals(parent.baselineId));
  assert.equal(rule.imposed_by_version, 3);
  assert.deepEqual(child.evidence.fields.map(field => field.field_id).sort(), ['description', 'summary']);
  const [signature] = child.evidence.signatures;
  assert.equal(signature.cause, 'PARENT_CAPTURE');
  assert.ok(signature.cause_baseline_id.equals(parent.baselineId));
  assert.equal(signature.status_at_capture, '1', 'the child\'s own status when it was captured');
});

test('a node\'s security level is recorded with the parent capture', async () => {
  const f = captureFixture();
  const tree = await f.args.deps.readStableTree();
  tree.tree.nodes[1].fields.security = { id: '10000' };
  f.args.deps.readStableTree = async () => tree;
  const levels = [];
  f.args.deps.recordNodeSecurity = async ({ levels: given }) => { levels.push(...given); };
  await writeCapturedTreeBaseline(f.args);
  assert.deepEqual(levels, [{ issueId: 2, securityLevelId: '10000' }]);
});

test('a parent capture without its rule scope is refused before anything is written', async () => {
  const f = captureFixture();
  f.args.ruleScope = null;
  assert.equal((await writeCapturedTreeBaseline(f.args)).reason, 'BASELINE_POLICY_INCOMPLETE');
  assert.deepEqual(f.calls, []);
});

test('child publication can require each child\'s evidence', async () => {
  const writes = [];
  await publishChildBaselines({ parentBaselineId: parent.baselineId, requireEvidence: true,
    write: async (sql, params) => { writes.push(sql); return { result: true, data: { affectedRows: 0 } }; },
    query: async () => [] });
  assert.match(writes[0], /controlled_fields_hash IS NOT NULL AND policy_recorded = TRUE/);
});
```

In `test/tree-storage.test.js`, append (and add `publishTreeBaseline` to its import from `../src/db/baselineTreeStore.js` if it isn't there):

```js
test('tree publication can require the version\'s evidence', async () => {
  const writes = [];
  await publishTreeBaseline({ baselineId: Buffer.alloc(16, 1), issueId: 1, version: 2, requireEvidence: true,
    write: async sql => { writes.push(sql); return { result: true, data: { affectedRows: 1 } }; },
    query: async () => [] });
  assert.match(writes[0], /controlled_fields_hash IS NOT NULL AND policy_recorded = TRUE/);
  const legacy = [];
  await publishTreeBaseline({ baselineId: Buffer.alloc(16, 1), issueId: 1, version: 2,
    write: async sql => { legacy.push(sql); return { result: true, data: { affectedRows: 1 } }; },
    query: async () => [] });
  assert.doesNotMatch(legacy[0], /policy_recorded/);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/child-baseline-capture.test.js test/tree-storage.test.js`
Expected: FAIL. The calls sequence lacks `evidence`, and the publication SQL lacks `policy_recorded`.

- [ ] **Step 3: Publication can require evidence**

In `src/db/baselineTreeStore.js`, change the `publishTreeBaseline` signature to:

```js
export async function publishTreeBaseline({ baselineId, issueId, version, requireEvidence = false, query = store.throwing, write = executeQuery }) {
```

and its activation SQL's last line from `AND controlled_fields_hash IS NOT NULL\`,` to:

```js
       AND controlled_fields_hash IS NOT NULL${requireEvidence ? ' AND policy_recorded = TRUE' : ''}`,
```

In `src/db/childBaselineStore.js`, change the `publishChildBaselines` signature to:

```js
export async function publishChildBaselines({ parentBaselineId, requireEvidence = false, query = store.throwing, write = executeQuery }) {
```

and its activation SQL's last line the same way:

```js
       AND controlled_fields_hash IS NOT NULL${requireEvidence ? ' AND policy_recorded = TRUE' : ''}`,
```

- [ ] **Step 4: `writeCapturedTreeBaseline` writes the evidence (`src/lib/capture.js`)**

1. **Imports.** Extend the Task 7 import to `import { versionEvidence, linkRows, trackedLinks, linkedIssueIds, CAUSE, RULE_SOURCE } from './evidence/versionEvidence.js';`, and add:

```js
import { writeVersionEvidence, pinChildVersions, recordNodeSecurity } from '../db/evidenceStore.js';
```

2. **Signature, services, guard.** Change the signature to:

```js
export async function writeCapturedTreeBaseline({
  rootIssue, policy, approval, controlledFields, transitionAt, ruleScope = null, cause = CAUSE.OWN_TRANSITION, deps = {}
}) {
```

   Add `writeVersionEvidence, pinChildVersions, recordNodeSecurity, activeBaselines,` to the `services` object, before `...deps`. Directly after the `NO_APPROVAL` guard's closing `}`, add:

```js
  // Which rule required these fields is part of every record this writes.
  if (!ruleScope) return { captured: false, reason: 'BASELINE_POLICY_INCOMPLETE' };
```

3. **Read security levels.** In the `readTreeWithNodeFields({ … })` call, change `extraFieldIds: ['status', 'parent']` to `extraFieldIds: ['status', 'parent', 'security']`.

4. **Write evidence, pins and security before publishing.** Directly after:

```js
  const children = childRows.length
    ? await services.writeChildBaselines({ rows: childRows, parentBaselineId: reserved.baselineId })
    : [];
```

   insert:

```js
  // THE EVIDENCE OF EVERY VERSION THIS CAPTURE WRITES
  // (docs/specs/2026-10-03-baseline-evidence-model-design.md §4, §5.4): the
  // parent's own, and each child's, whose rule is the parent's, inherited from
  // this capture. Written before anything publishes; publication requires it.
  // A retried capture rewrites its children under new ids; evidence left under
  // the old ids names versions that no longer exist and is never read.
  const nodeOf = issueId => stable.tree.nodes.find(node => Number(node.id) === Number(issueId));
  const rootSource = nodeOf(rootIssue.id);
  const rootLinks = trackedLinks(controlledFields, rootSource?.fields);
  const childLinks = children.map(child => trackedLinks(fieldsFor(nodeOf(child.issue_id)), nodeOf(child.issue_id)?.fields));
  const linked = linkedIssueIds([...(rootLinks ?? []), ...childLinks.flatMap(links => links ?? [])]);
  const otherVersions = linked.length ? await services.activeBaselines(linked) : new Map();
  const approvers = [{ role: policy?.required_role, assurance: policy?.required_assurance }];
  const signer = { approvalId: approval.approvalId, signerAccountId: approval.accountId, signerName: approval.displayName,
    role: policy?.required_role, assurance: approval.assuranceLevel, transitionId: policy?.transition_id ?? null,
    fromStatusId: policy?.from_status_id ?? null, toStatusId: policy?.to_status_id ?? null, transitionAt, signedAt: capturedAt };
  await services.writeVersionEvidence({ entries: [
    { baselineId: reserved.baselineId, cause, links: linkRows({ links: rootLinks, otherVersions }),
      evidence: versionEvidence({ fields: controlledFields, digests: rootNode.fieldDigests,
        rule: { ...ruleScope, transitionId: policy?.transition_id ?? null, approvers,
          controlledFieldsHash: provenance.controlled_fields_hash },
        signature: { ...signer, cause, statusAtCapture: rootSource?.fields?.status?.id ?? null } }) },
    ...children.map((child, index) => ({ baselineId: child.baseline_id, cause: CAUSE.PARENT_CAPTURE,
      links: linkRows({ links: childLinks[index], otherVersions }),
      evidence: versionEvidence({ fields: fieldsFor(nodeOf(child.issue_id)), digests: child.field_digests,
        rule: { source: RULE_SOURCE.INHERITED, projectId: ruleScope.projectId, issueTypeId: ruleScope.issueTypeId,
          transitionId: policy?.transition_id ?? null, approvers, controlledFieldsHash: child.controlled_fields_hash,
          imposedByBaselineId: reserved.baselineId, imposedByVersion: Number(version) },
        signature: { ...signer, cause: CAUSE.PARENT_CAPTURE, causeBaselineId: reserved.baselineId,
          statusAtCapture: nodeOf(child.issue_id)?.fields?.status?.id ?? null } }) }))
  ] });
  if (children.length) {
    await services.pinChildVersions({ parentBaselineId: reserved.baselineId,
      pins: children.map(child => ({ issueId: child.issue_id, baselineId: child.baseline_id, version: child.version })) });
  }
  await services.recordNodeSecurity({ baselineId: reserved.baselineId,
    levels: stable.tree.nodes.filter(node => node.fields?.security?.id != null)
      .map(node => ({ issueId: Number(node.id), securityLevelId: String(node.fields.security.id) })) });
```

5. **Require evidence at publication.** Change the publication calls that follow from:

```js
  await services.publishTreeBaseline({
    baselineId: reserved.baselineId,
    issueId: Number(rootIssue.id),
    version: Number(version)
  });
  if (children.length) await services.publishChildBaselines({ parentBaselineId: reserved.baselineId });
```

   to:

```js
  await services.publishTreeBaseline({
    baselineId: reserved.baselineId,
    issueId: Number(rootIssue.id),
    version: Number(version),
    requireEvidence: true
  });
  if (children.length) await services.publishChildBaselines({ parentBaselineId: reserved.baselineId, requireEvidence: true });
```

   Leave the repair call in the already-published branch (`services.publishChildBaselines({ parentBaselineId: existing.baseline_id })`) **without** `requireEvidence`. It finishes publishing a capture that may have started before this deploy and has no evidence rows; step 2's job proves such versions.

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/child-baseline-capture.test.js test/tree-storage.test.js && npm test 2>&1 | tail -6`
Expected: PASS, and `ℹ fail 0`. Any other test that drives `writeCapturedTreeBaseline` (`grep -ln "writeCapturedTreeBaseline" test`) needs the same fixture additions as Step 1 (2): `ruleScope`, plus the four deps. Fields given to it need `materiality`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/capture.js src/db/baselineTreeStore.js src/db/childBaselineStore.js test/child-baseline-capture.test.js test/tree-storage.test.js
git commit -m "feat(capture): record evidence for a parent and every child, pin child versions, require evidence to publish" -- src/lib/capture.js src/db/baselineTreeStore.js src/db/childBaselineStore.js test/child-baseline-capture.test.js test/tree-storage.test.js
```

---

### Task 9: A link record carries evidence

**Files:**
- Modify: `src/lib/approval/linkPropagation.js` (`linkDecisionJobs` carries `signerRole`)
- Modify: `src/usecases/drift.js` (`queueLinkDecisions` passes `signerRole`)
- Modify: `src/db/derivedBaselineStore.js` (`writeDerivedFlat`, `writeDerivedTree`)
- Modify: `src/jobs/linkWorker.js` (approval carries `signerRole`; `SCHEMA_PENDING` retries)
- Test: `test/link-propagation.test.js`, `test/derived-evidence.test.js` (new)

**Interfaces:**
- Consumes: `derivedEvidence`, `linkRows`, `linkedIssueIds`, `CAUSE`, `UNRECORDED_ROLE` (Task 5); `readVersionEvidence`, `copyNodePins`, `writeVersionEvidence` (Task 6); `writeBaseline({ evidence })` (Task 7); `publishTreeBaseline({ requireEvidence })` (Task 8).
- Produces:
  - `writeDerivedFlat({ source, values, digests, contentHash, approval, now }, deps = { readEvidence, activeBaselines, write })`
  - `writeDerivedTree({ source, derived, approval, now, query, write }, deps = { readEvidence, activeBaselines, writeEvidence, copyPins })`
  - link jobs carry `signerRole`, and the worker's `approval` carries `signerRole`.

- [ ] **Step 1: Write the failing tests**

Create `test/derived-evidence.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeDerivedFlat } from '../src/db/derivedBaselineStore.js';

const d = c => c.repeat(64);
const source = { baseline_id: Buffer.alloc(16, 1), issue_id: 7, project_id: 2, issue_type_id: '3', version: 4,
  transition_id: '31', from_status_id: '3', to_status_id: '4', required_role: 'REVIEWER', required_assurance: 'ESIGNATURE',
  controlled_fields_hash: d('h'), fidelity: 'EXACT' };
const signed = {
  fields: [{ field_id: 'issuelinks', label: 'Linked issues', label_source: 'CAPTURE', kind: 'LINKS', schema_type: 'array',
    materiality: 'MAJOR', store_values: true, restorable: null, digest: d('b'), required_by: ['k1'] }],
  rules: [{ rule_key: 'k1', source: 'OWN', project_id: 2, issue_type_id: '3', transition_id: '31',
    approvers: [{ role: 'REVIEWER', assurance: 'ESIGNATURE' }], controlled_fields_hash: d('h'),
    imposed_by_baseline_id: null, imposed_by_version: null }],
  signatures: [], links: []
};
const links = [{ id: '15539', type: { id: '10022' }, inwardIssue: { id: '43979', key: 'VAT-30' } }];
const approval = { approvalId: Buffer.alloc(16, 2), accountId: 'signer', displayName: 'Signer', assuranceLevel: 'ESIGNATURE',
  signerRole: 'REVIEWER' };

function deps(evidence) {
  const writes = [];
  return { writes, deps: { readEvidence: async () => evidence,
    activeBaselines: async () => new Map([[43979, { baseline_id: Buffer.alloc(16, 3), version: 9 }]]),
    write: async args => { writes.push(args); return { baselineId: Buffer.alloc(16, 4) }; } } };
}

test('a link record copies its source\'s signed definitions, and records the link and the signer', async () => {
  const { writes, deps: given } = deps(signed);
  await writeDerivedFlat({ source, values: { issuelinks: links }, digests: { issuelinks: d('c') }, contentHash: d('e'),
    approval, now: 50 }, { ...given, nextVersion: async attempt => attempt(5) });
  const [{ evidence, baseline }] = writes;
  assert.equal(baseline.version, 5);
  assert.equal(evidence.required, true);
  assert.equal(evidence.cause, 'LINK_RECORD');
  assert.deepEqual(evidence.evidence.fields.map(f => [f.field_id, f.digest]), [['issuelinks', d('c')]]);
  assert.equal(evidence.evidence.signatures[0].role, 'REVIEWER');
  assert.equal(evidence.evidence.signatures[0].fields_covered, '["issuelinks"]');
  assert.deepEqual(evidence.links.map(l => [l.link_id, l.direction, l.other_issue_key, l.other_baseline_version]),
    [['15539', 'INWARD', 'VAT-30', 9]]);
});

test('a link record on a version with no recorded policy publishes without the evidence gate, and says whose role is unknown', async () => {
  const { writes, deps: given } = deps({ fields: [], rules: [], signatures: [], links: [] });
  await writeDerivedFlat({ source, values: { issuelinks: links }, digests: { issuelinks: d('c') }, contentHash: d('e'),
    approval: { ...approval, signerRole: null }, now: 50 }, { ...given, nextVersion: async attempt => attempt(5) });
  const [{ evidence }] = writes;
  assert.equal(evidence.required, false);
  assert.equal(evidence.evidence.signatures[0].role, 'UNRECORDED');
});
```

In `test/link-propagation.test.js`, the existing tests compare selected job properties, never whole job objects, so they need no change. Append:

```js
test('a link job carries the signer\'s role, so the other end records who signed as what', () => {
  const [job] = linkDecisionJobs({ issue: VAT30, tracksLinks: true, before: [],
    after: [{ id: '15539', type: deploys, outwardIssue: { id: VAT3.id, key: VAT3.key } }],
    approval: { approvalId: 'AAAA', accountId: 'a', displayName: 'A', assuranceLevel: 'ESIGNATURE', signerRole: 'QA' } });
  assert.equal(job.signerRole, 'QA');
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test test/derived-evidence.test.js test/link-propagation.test.js`
Expected: FAIL. `writes[0].evidence` is undefined, and `job.signerRole` is undefined.

- [ ] **Step 3: The job carries the signer's role**

In `src/lib/approval/linkPropagation.js`, in `linkDecisionJobs`'s returned object, change:

```js
    assuranceLevel: approval.assuranceLevel
  }));
```

to:

```js
    assuranceLevel: approval.assuranceLevel, signerRole: approval.signerRole ?? null
  }));
```

In `src/usecases/drift.js` `queueLinkDecisions`, change the `approval: { … }` argument's last line from:

```js
      assuranceLevel: approval.assurance_level }
```

to:

```js
      assuranceLevel: approval.assurance_level, signerRole: approval.signer_role ?? null }
```

In `src/jobs/linkWorker.js`, change the `approval` built in `recordLinkDecision` to:

```js
  const approval = { approvalId: Buffer.from(String(body.approvalId), 'base64'), accountId: body.approvedBy,
    displayName: body.approvedName, assuranceLevel: body.assuranceLevel, signerRole: body.signerRole ?? null };
```

In the same function's `catch (error) {` block, directly before its final `throw error;`, add:

```js
    // The new evidence tables are not there yet: wait for the migration.
    if (error?.reason === 'SCHEMA_PENDING') {
      const retry = retryEvent(eventOrBody, 'SCHEMA_PENDING');
      if (!retry?.retryExhausted) return retry;
    }
```

- [ ] **Step 4: Derived versions write evidence (`src/db/derivedBaselineStore.js`)**

1. **Imports.** Replace:

```js
import { writeBaseline, currentVersion } from './baselineStore.js';
```

with:

```js
import { writeBaseline, currentVersion, activeBaselines } from './baselineStore.js';
import { readVersionEvidence, writeVersionEvidence, copyNodePins } from './evidenceStore.js';
import { derivedEvidence, linkRows, linkedIssueIds, CAUSE, UNRECORDED_ROLE, parseDigests } from '../lib/evidence/versionEvidence.js';
```

2. **Shared helpers.** Add below `rowFor`:

```js
/**
 * THE EVIDENCE OF A LINK RECORD: the source version's signed definitions and
 * rules with the derived digests, the deciding approval as a LINK_RECORD
 * signature, and the links it now records. A source whose policy was never
 * recorded gives only the signature, and its record publishes without the
 * evidence gate (`required: false`), exactly as recorded as the source was.
 */
async function linkRecordEvidence({ source, digests, links, approval, now }, { readEvidence, activeBaselines: versions }) {
  const signed = await readEvidence(source.baseline_id);
  const others = linkedIssueIds(links);
  const otherVersions = others.length ? await versions(others) : new Map();
  const evidence = derivedEvidence({ source: signed, digests, signature: {
    approvalId: approval.approvalId, signerAccountId: approval.accountId, signerName: approval.displayName,
    role: approval.signerRole ?? UNRECORDED_ROLE, assurance: approval.assuranceLevel, cause: CAUSE.LINK_RECORD,
    transitionId: source.transition_id ?? null, fromStatusId: source.from_status_id ?? null,
    toStatusId: source.to_status_id ?? null, transitionAt: now, statusAtCapture: null, signedAt: now,
    fieldsCovered: ['issuelinks'] } });
  return { evidence: { fields: evidence.fields, rules: evidence.rules, signatures: evidence.signatures },
    links: linkRows({ links, otherVersions }), cause: CAUSE.LINK_RECORD, required: evidence.recorded };
}
```

3. **`writeDerivedFlat`.** Replace the whole function with:

```js
/** A single-issue record: values and digests already derived. */
export async function writeDerivedFlat({ source, values, digests, contentHash, approval, now },
  deps = {}) {
  const d = { readEvidence: readVersionEvidence, activeBaselines, write: writeBaseline,
    nextVersion: attempt => withNextVersion(Number(source.issue_id), attempt), ...deps };
  const evidence = await linkRecordEvidence({ source, digests, links: values?.issuelinks ?? [], approval, now }, d);
  let written;
  await d.nextVersion(async version => {
    const baseline = { ...rowFor(source, approval, now, version), content_hash: contentHash,
      field_digests: JSON.stringify(digests), field_count: Object.keys(digests).length };
    written = { ...(await d.write({ baseline, raw: values, evidence })), version };
  });
  return written;
}
```

4. **`writeDerivedTree`.** Change its signature to:

```js
export async function writeDerivedTree({ source, derived, approval, now, query = store.throwing, write = executeQuery },
  deps = {}) {
  const d = { readEvidence: readVersionEvidence, activeBaselines, writeEvidence: writeVersionEvidence,
    copyPins: copyNodePins, ...deps };
```

   Directly before its `await publishTreeBaseline({ … })`, insert:

```js
  const root = derived.nodes.find(node => node.parentLogicalNodeId == null);
  if (!root) throw new FailClosed('CAPTURE_INCOMPLETE');
  const evidence = await linkRecordEvidence({ source, digests: parseDigests(root.fieldDigests),
    links: derived.values?.[root.logicalNodeId]?.issuelinks ?? [], approval, now }, d);
  await d.copyPins({ fromBaselineId: source.baseline_id, toBaselineId: reserved.baselineId, query });
  await d.writeEvidence({ query, entries: [{ baselineId: reserved.baselineId, evidence: evidence.evidence,
    links: evidence.links, cause: evidence.cause }] });
```

   Then change that publication call to:

```js
  await publishTreeBaseline({ baselineId: reserved.baselineId, issueId: Number(source.issue_id),
    version: Number(reserved.version), requireEvidence: evidence.required, query, write });
```

   Add `import { FailClosed } from '../lib/errors.js';` to the imports.

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test test/derived-evidence.test.js test/link-propagation.test.js test/link-scenarios.test.js && npm test 2>&1 | tail -6`
Expected: PASS, and `ℹ fail 0`. `link-scenarios.test.js` injects its own `writeDerivedFlat`/`writeDerivedTree` through `workerDeps`, so the new evidence path doesn't run there.

- [ ] **Step 6: Commit**

```bash
git add src/lib/approval/linkPropagation.js src/usecases/drift.js src/db/derivedBaselineStore.js src/jobs/linkWorker.js test/derived-evidence.test.js test/link-propagation.test.js
git commit -m "feat(links): a link record carries its signed definitions, its links and who signed as what" -- src/lib/approval/linkPropagation.js src/usecases/drift.js src/db/derivedBaselineStore.js src/jobs/linkWorker.js test/derived-evidence.test.js test/link-propagation.test.js
```

---

### Task 10: Verify step 1 end to end, then deploy

**Files:** none changed.

- [ ] **Step 1: Full suites**

Run: `npm test 2>&1 | tail -8 && npm run test:ui 2>&1 | tail -8`
Expected: `ℹ fail 0` in both.

- [ ] **Step 2: Check that nothing reads the new columns yet** (step 1 changes no reader)

Run: `grep -rn "va_baseline_field\|va_baseline_rule\|va_baseline_signature\|va_baseline_link\|readVersionEvidence\|\.observation\b" src | grep -v "src/db/evidenceStore.js\|src/db/migrations.js\|src/db/derivedBaselineStore.js\|src/db/driftStore.js"`
Expected: no output. The only reader, `readVersionEvidence`, is used by the link record (Task 9). That is a writer reading its own source's evidence.

- [ ] **Step 3: Deploy to the development environment**

Run: `forge deploy -e development`, then wait for the next five-minute runner (the migration job).
Check: `forge logs -e development --since 15m | grep -i "migrat\|DDL"` shows no `Forge SQL DDL Error`. If v094/v095 report that the column does not exist, the site never ran v082. Stop and report it; do not edit v094.

- [ ] **Step 4: Live check on mgtechdemo (project VAT)**

1. In the VAT panel, approve the drift on one Story that has a Sub-task, signing with TOTP. Expect the panel to show the approval as before.
2. Run one controlled transition on a single Task. Expect the transition to succeed.
3. Add a link between two baselined VAT items and approve it on one end. Expect the other end's panel to show the link as recorded, as before.
4. Run: `forge logs -e development --since 15m | grep -E "SCHEMA_PENDING|CAPTURE_INCOMPLETE|BASELINE_POLICY_INCOMPLETE|capture failed"`
   Expected: no lines after the migration ran.

Row-level inspection of the new tables arrives with step 2, whose job reports evidence coverage on the Health page. Step 1's live check proves that captures, decisions and link records still publish with the evidence gate in place.

- [ ] **Step 5: Report**

Report in chat:
- the test counts;
- the deploy result;
- the four live checks, with their outcomes;
- anything that deviated from this plan.

Do not commit anything in this task.

---

## Roadmap after step 1

Steps 2–5 of the spec's rollout (§9.5) each get their own plan, written when the previous step has landed, because each builds on the concrete code before it.

| Step | Plan | Builds on | Also carries |
|---|---|---|---|
| 2 | One-time job: hash-proven field and rule rows, signature rows for every existing version, own versions for children of old trees (§9.2–9.3); evidence coverage on the Health page | `evidenceStore`, `versionEvidence` | Repairs the pre-deploy child-publication path left ungated in Task 8 |
| 3 | Capture leases on every version writer (§5.3) | `va_capture_lease` (v081 + v104) | A new `leaseStore.js` built to the spec, replacing the deleted draft |
| 4 | Readers switch: `resolveRules` / `recordedRules`, `toObservation`'s `.observation` everywhere, merged history, `visibleScope`, `RECORD_UNRECONSTRUCTABLE` in `baselineVersions.js` (today it falls back to an empty record) | Steps 1–3 | Deletes `fieldsForItem`, `scopeForItem`, `readTreeWithNodeFields`, `ownsItsContent`; `driftByAuthor` counts confirmed edits only |
| 5 | Decisions with signing groups, any-reject-wins, tree-wide decisions (§8.2) | Step 4, `va_decision*` (v101–v103) | Panel UI for groups; hidden-children waiting |
