# Baseline evidence model: one record per fact, no substitution

**Date:** 2026-10-03
**Status:** Design agreed section by section on 2026-10-03; written spec awaiting review
**Supersedes:** the field rule of `docs/specs/2026-09-24-child-baselines-design.md` §4.1 (each node
tracks its own fields) and the 2026-09-25 rule that replaced it (every node tracks the root's fields,
`src/lib/tree/nodeFields.js`).
**Extends:** `docs/specs/2026-09-24-child-baselines-design.md` (every child has its own baseline,
parent and child decisions), `docs/specs/2026-09-12-controlled-transition-tree-baseline-design.md`.

---

## 1. The problem

Baseline and drift draw on six sources of truth:

- the signed baseline and its tree;
- current Jira content;
- the viewer's permissions;
- local drift observations;
- Jira changelog history;
- current field configuration.

Their boundaries are not explicit. When the preferred source is missing or incomplete, the code
substitutes another. Five confirmed defects follow from that, plus one race and one rule that has
changed twice.

| # | Defect | Where | Substitution |
|---|---|---|---|
| 1 | The signed record is built from `find(root) ?? nodes[0]`, and permission filtering happens after the record is built | `src/lib/baselineVersions.js:13`, `src/usecases/panelEvidence.js:90,109` | a child stands in for a missing root; a child's saved values reach a viewer who cannot browse it |
| 2 | Drift rows store `actor = changelog author ?? event user` and `occurred_at = changelog time ?? now` | `src/lib/collect.js:293` | the event user stands in for the editor, and the observation time for the edit time; `reviewAttribution.js:19` and `diff/index.js:97` then treat EVENT rows as confirmed |
| 3 | `trace = touches.length ? touches : events` | `src/lib/diff/index.js:92` | a non-empty but bounded, lossy Jira history replaces the stored observations |
| 4 | A child's drift is queried by `(issue_id, baseline_version)` using the parent's version | `src/lib/tree/reviewDiff.js:35`, `src/usecases/panelEvidence.js:112`, `driftStore.markDecided` | the version a value is compared against stands in for the version the observation was recorded against |
| 5 | Historical versions are displayed with today's configuration for each node's current scope | `src/usecases/panelEvidence.js:200` | today's field policy stands in for the policy that was signed |
| R | A parent's capture reads the tree, then reserves each child's version later. A child version captured in between (holding newer content) is superseded by the parent's older read | `src/db/childBaselineStore.js:125,188` | allocation order stands in for read order, so a signed decision is silently undone |
| F | Which fields a child tracks changed on 09-24 (its own) and again on 09-25 (the root's only). Today's `scopeForItem` picks "the most recently approved root" | `src/lib/tree/nodeFields.js` | one rule stands in for the union of rules that actually apply |

**Root cause:** missing data is handled by substitution. In a governed evidence system, a missing
identity, incomplete history, stale policy or uncertain attribution must produce explicit uncertainty
or a fail-closed result.

## 2. What the user wants

1. **Capture.** A baseline records every controlled field. Children (sub-tasks and other `parent`-link
   children) are part of the record, so structure is always captured.
2. **Hierarchy.** When an issue is baselined, every child at every depth gets its own baseline,
   authenticated by that signature. A parent's rule applies to everything below it.
3. **A child's own rules still apply.** Being under a parent adds the parent's rule. It never replaces
   the child's own.
4. **Links are dependencies, not parts of the issue.** A baseline records the link itself (type,
   direction, the issue at the other end), never the other issue's content.
5. **Versions belong to each issue.** Each version records how and at what stage it was captured.
6. **Simultaneous transitions.** Both captures are recorded, in order, each with its own provenance.
   Where compliance practice says otherwise, compliance wins (§5.1).

### 2.1 Decisions taken on 2026-10-03

| Topic | Decision |
|---|---|
| A covered child's fields | **Union** of its own rule and every inherited rule. Each field records which rule(s) required it |
| Who approves drift on a field | **Per field: the rule(s) that required it.** Roles are not ranked, so **each distinct role signs**, at the highest assurance among those rules |
| Depth | Rules add up down the tree: **every baselined ancestor, plus the issue's own** |
| Links | Record the link **plus the other end's baseline version at that moment**, for information only. Edits to the other issue are never drift here |
| Re-parenting | Inherited rules are **kept until the child's next signed capture**, then recomputed from the current parent chain |
| A decision whose fields need different roles | **Each part is signed separately.** Nothing is written until every group is decided |
| A capture whose content and rules equal the active version | **Add a signature, no new version** |
| Own fields of a child that never had its own transition | Approved by **every role named by its type's controlled transitions, at the highest assurance among them**. If none is configured: `UNCONFIGURED`, fail closed, reported on the Health page |
| Decision scope | **A decision on child A covers only A's drift. A decision on parent P covers the whole tree below P.** Each role still signs its own group |
| A configuration change after capture | Takes effect at the **next signed capture**. History is never reinterpreted |
| A signer who cannot see some drifted children | They **cannot sign groups containing them**. The decision waits for a signer who can |
| Roles disagree within a group | **Any reject wins.** Approving needs every role's approval |
| An ancestor whose rule cannot be proven after migration | **Block** (`ANCESTOR_POLICY_UNRECORDED`) until the ancestor is re-signed |

## 3. Approaches considered

- **A. Patch the current schema.** Add columns to `va_baseline` and fix each reader. This is the
  smallest migration, but the "which rule applies" logic stays spread over collect, panel, validator,
  restore and review. That spread is what produced defects 1–5 and F.
- **B. An explicit evidence model (chosen).** Each source of truth gets its own immutable record with
  one way in. One resolver decides which rules apply, and it runs only when something is about to be
  signed. Everything else reads what was signed.
- **C. A full event log.** Everything is derived from an appended log. It is the cleanest audit story,
  but it means rewriting every store and reader.

## 4. Data model

**Principle:** each fact has exactly one record, and records are written once and never changed. The
only thing ever updated is a version's state (`CAPTURING` → `ACTIVE` → `SUPERSEDED`).

| Record | Table | One row = | Key |
|---|---|---|---|
| Version | `va_baseline` (existing) | one issue at version N | `(issue_id, version)` (already unique) |
| Field policy | `va_baseline_field` (new) | one field as signed: label, kind, schema type, materiality, whether the value is stored, whether it can be restored, digest, `required_by` (rule keys), `label_source` (`CAPTURE` or `MIGRATION`) | `(baseline_id, field_id)` |
| Rule | `va_baseline_rule` (new) | one rule covering the version: `source` (`OWN` or `INHERITED`); project, issue type, transition, the approving roles and assurance (or `UNCONFIGURED`), `controlled_fields_hash`; for an inherited rule, the ancestor's baseline id and version | `(baseline_id, rule_key)` |
| Signature | `va_baseline_signature` (new) | one signed act: approval, signer, role, assurance, cause, the parent's baseline id for `PARENT_CAPTURE`, the decision id for `DRIFT_DECISION`, stage (transition id, from → to, transition time, the issue's own status at capture), the field ids it covers | `(baseline_id, approval_id)` |
| Contents | `va_baseline_node` (existing) + `child_baseline_id`, `child_version`, `security_level_id` | a parent version's node, pinned to the exact child version it covered | as today |
| Link | `va_baseline_link` (new) | one recorded link: Jira link id, link type id, direction, the other issue's id and key, the other issue's baseline version at that moment (nullable) | `(baseline_id, link_id)` |
| Observation | `va_drift` (existing) + columns (§7.1) | one detected difference, tied to the `baseline_id` it was recorded against | as today |

`va_baseline` gains `cause`, `policy_recorded` and `content_as_of` (set only by migration, §9.3).

Signature causes: `OWN_TRANSITION`, `PARENT_CAPTURE`, `DRIFT_DECISION`, `LINK_RECORD`, `MIGRATED`.

**Rules:**

- **What makes a version.** A version is its content plus its rules. If the recorded field values, the
  set of field definitions or the set of rules differs from the active version, a new version is
  created. Otherwise only a signature row is added.
- **Legacy signer columns.** `approved_by`, `approved_name`, `approval_id` and `assurance_level` on
  `va_baseline` keep holding the **first** signer, for existing readers and exports.
  `va_baseline_signature` is the authority.
- **No history from today's configuration.** History is displayed from `va_baseline_field`, never
  from `va_controlled_field`.
- **Versions without recorded policy.** These have `policy_recorded = false` and are displayed as
  "field definitions not recorded for this version". They are never filled in from today's
  configuration.

## 5. Capture and ordering

### 5.1 Compliance basis

General configuration-management practice (ISO 10007 / EIA-649 style) and FDA 21 CFR Part 11
principles, not a legal reading of any specific customer's obligations:

- **Each configuration item has its own version history.** A higher-level baseline references
  specific versions of the items it contains. It does not copy or override their history.
- **Audit trails are computer-generated and time-stamped.** Two captures are therefore never
  simultaneous in the record. They are put in order.
- **Each signature attests to exactly what its signer saw.**
- **No signature overrides another.** The later version is current, and the earlier one stays in the
  history with its own signer and stage.

### 5.2 What already holds

- An approval stores the hash of the content the signer saw. Capture re-reads Jira and refuses with
  `CONTENT_CHANGED` if the hash differs (`src/lib/capture.js:136,314`).
- `UNIQUE (issue_id, version)` plus a bounded retry prevents duplicate version numbers.

### 5.3 Per-issue capture lease

- **New table:** `va_capture_lease (issue_id PRIMARY KEY, holder, acquired_at, expires_at)`.
  - Taking a lease is an atomic insert.
  - An expired lease is taken over with a conditional `UPDATE … WHERE issue_id = ? AND
    expires_at < ?`.
  - The time-to-live is a constant longer than the longest timeout of any invocation that holds a
    lease.
- **Who holds one.** Every writer of a version holds the lease on that issue: trigger capture, a
  drift decision being applied, the link worker, and a parent capture for each of its nodes. Readers
  (validator, collector, panel) never take leases.
- **A parent capture:**
  1. Reads the tree to learn its members.
  2. Takes leases on all of them, in ascending issue-id order.
  3. If any lease is busy, releases what it took and retries through `retryEvent` (as
     `src/jobs/linkWorker.js` does for `OTHER_END_BUSY`). There is no hold-and-wait, so no deadlock.
  4. With the leases held, re-reads the tree and verifies its hash against the approval. If the
     membership changed, it releases and retries.
- **While the leases are held,** for each issue in scope:
  1. Build the record: fields from `resolveRules` (§6), definitions, stage.
  2. Compare it with the active version. If the content and rules are identical, add a signature row.
     Otherwise create a new version.
  3. Publish, then release the leases.
- **Crash.** A crash leaves `CAPTURING` rows (resumed or cleared as today), and the lease expires.

Holding leases across read → verify → write → publish makes **version order = read order = commit
order** for every issue. This closes race R.

### 5.4 Tree hash

The parent's tree hash still covers each node's content hash and the structure. Each node's content is
now projected over **that node's** resolved fields (§6), not over the root's fields. The node pins the
child version (or the version that was co-signed) that the capture produced.

### 5.5 Worked example

Task T has v1. Epic E has no baseline. Both transitions are approved together.

- **T's capture gets the leases first.**
  1. **T v2** is written: `OWN_TRANSITION`, signed by A.
  2. E's capture runs. If T's resolved record equals v2, E adds B's signature (`PARENT_CAPTURE`) to
     T v2. If E's rule adds fields to T, it writes **T v3**.
  3. **E v1** pins T at v2 or v3.
- **E's capture gets the leases first.**
  1. E v1 is written, and T gets v2 (`PARENT_CAPTURE`).
  2. T's own capture re-reads and verifies its hash.
  3. It then adds A's signature to the current version, or writes v3 if the content or rules differ.

The panel shows, for example: *"v2 · captured because EPIC-1 v1 was approved (In Review → Approved) ·
signed by B, e-signature · this task was In Progress"*.

## 6. Rule resolver

`fieldsForItem`, `scopeForItem` and `readTreeWithNodeFields` are replaced by two functions.

| Function | Question | Reads | Used by |
|---|---|---|---|
| `resolveRules(issue, cause)` | Which rules would cover this if it were signed **now**? | Today's configuration and the current parent chain | capture; the validator, to compute the hash a signer is about to sign |
| `recordedRules(baselineId)` | Which rules was this version **signed** under? | That version's `va_baseline_rule` and `va_baseline_field` rows only | collect, treeCollect, the validator's drift hold, the panel, review, restore |

Today's configuration is read **only** when something is about to be signed.

### 6.1 `resolveRules`

1. **Own rule.** The issue's Controlled Fields for its project and issue type, read now. If there are
   none, the issue has no own rule. The approver is the first of these that applies:
   - **cause `OWN_TRANSITION`:** that transition's role and assurance;
   - **any other cause, and the active version has an own rule:** the approver recorded on that rule.
     A drift decision or a parent's capture keeps the authority the issue was last signed under;
   - **no own rule on the active version:** every role named by the issue type's controlled
     transitions, at the highest assurance among them;
   - **no controlled transition configured:** `UNCONFIGURED`. The fields are still tracked, drift on
     them cannot be approved, and the Health page reports it.
2. **Inherited rules.** Walk the current Jira parent chain upward. For each ancestor with an active
   version, take its **own rule as recorded on that version**. The capturing ancestor contributes the
   rule being signed now. Rules from ancestors the issue has moved away from drop at this capture,
   because the chain is recomputed.
3. **Combine by `field_id`.** Each field's `required_by` lists its rules. Where rules define a field
   differently:
   - **materiality:** the higher wins;
   - **stored value:** stored if any rule stores it;
   - **kind** (or schema type) that disagrees: fail with `POLICY_CONFLICT` and report it on the Health
     page.
4. **Fail closed.**
   - An ancestor whose active version has `policy_recorded = false`: `ANCESTOR_POLICY_UNRECORDED`. The
     capture and the transition wait until the ancestor is re-signed. Health lists the ancestors and
     how many descendants each holds up.
   - A parent chain that cannot be read: `CAPTURE_INCOMPLETE`.
   - There is no fallback to "the first node" or "the latest root".

### 6.2 Who approves a field

- **A field's requirement** is the set of roles named by the rules in its `required_by`, at the
  highest assurance among them.
- **Signing groups.** Fields with identical requirements form one signing group. Each role in a group
  gives its own signature. One person holding several roles may sign for each of them.
- **Eligibility** is checked against the scope of the rule that requires the field. For an inherited
  field, that is the ancestor's project and issue type.

### 6.3 Configuration changes

A configuration change is never retroactive. Existing versions are judged by `recordedRules`. The
panel shows: *"Rules changed since v3: 2 fields added; they'll be recorded at the next approval."*

## 7. Drift and observations

### 7.1 An observation records what we actually know

New `va_drift` columns:

| Fact | Columns | Meaning |
|---|---|---|
| When we saw it | `observed_at` (always set) | when the collector found the difference. Never shown as the edit time |
| What made us look | `trigger_kind` (`EVENT`, `RECONCILE`, `DECISION`, `CAPTURE`; old rows may also decode as `SWEEP`), `trigger_account_id` | the user of the Jira event that triggered the check. Shown as "seen after an update by X" |
| Who made the edit | `edit_status` (`CONFIRMED`, `UNATTRIBUTED`, `HISTORY_UNAVAILABLE`); `edited_at`; the existing `actor_account_id`, `actor_name` and `changelog_id` | filled only from a matching Jira history item, and only when `CONFIRMED` |

- **One decoder.** Every reader goes through `toObservation(row)`. No code reads `actor_*` or
  `occurred_at` directly.
- **Old rows.** A row with a `changelog_id` decodes as `CONFIRMED`. A row without one decodes as
  `UNATTRIBUTED`: its `actor_account_id` becomes the trigger account and its `occurred_at` becomes
  `observed_at`.
- **The "who edits approved work" report.** `driftByAuthor` counts `CONFIRMED` edits only, and reports
  unattributed changes as a separate count.

### 7.2 Jira history and our records are combined

Each field's trace is built from both sources:

- **Matched by `changelog_id`:** one entry, `CONFIRMED`.
- **A Jira history item with no observation** (for example, an edit that was later reverted): a
  confirmed entry, marked "from Jira history".
- **An observation with no Jira match:** an `UNATTRIBUTED` entry. It is never matched by timing.

**Completeness:**

- A history read is `complete` only if it reached back to the version's `captured_at`.
- Otherwise the trace says *"Jira history available back to <time> only; earlier edits may be
  missing"*, and counts read "at least N".
- First and last changed times come from `CONFIRMED` entries only. The observed range is shown
  separately.
- The collector's `lastChangelogId` high-water mark and the reconcile cursor advance only on a complete
  read.

### 7.3 What an observation is recorded against and compared against are the same

- **The child's own version is always current enough.** A parent's capture always gives every child a
  version or a signature (§5.3), so a child's active version is never older than its parent's capture.
- **What a child is compared against.** A parent's review compares each child against **the child's
  active version**. The parent's tree only pins which child version it covered.
- **Deleted.** `ownsItsContent` and the "compare against the parent's stored node" path.
- **Lookup by baseline id.** Observations are read and settled by `baseline_id`. `baseline_version` is
  display-only. `driftForIssueVersions` and `markDecided` change accordingly.
- **Review groups.** Each review group carries `comparedAgainst: { baselineId, version }`.
  Observations recorded against an older version are history, not pending drift.

### 7.4 What stays the same

- Drift is found by comparing digests over `recordedRules` fields. A field that is not in the version
  is not drift.
- Our own restores are recorded but are `COSMETIC`, not drift.
- The validator holds drifted items and never recalls them.

## 8. Review, decisions and permissions

### 8.1 Permissions first

1. **Visible scope.** `visibleScope(viewer, issues)` runs one `asUser` permission check (browse
   projects) over every issue that the version, the live tree and the pending drift mention. It runs
   before anything else is built. If the check fails, the scope is only the opened issue, and the
   panel says so.
2. **Every projection is built from the visible scope only.** This covers the record, tree, review,
   version history, observations, attachments and version comparisons. Nothing is built and then
   filtered.
3. **No guessed root.**
   - An issue's record is read from its own version's rows.
   - For a legacy tree version, the root lookup must match `issue_id` exactly. Otherwise the result is
     `RECORD_UNRECONSTRUCTABLE`, and the panel shows that state.
   - The `?? nodes[0]` fallback is deleted.
4. **Deleted children.** Capture records each node's `security_level_id`. A deleted node's stored
   values are shown only if:
   - the viewer can browse the node's recorded project, **and**
   - the node had no security level when captured.

   Otherwise the panel shows *"1 work item removed (contents hidden)"*.

### 8.2 The decision record

New tables:

- **`va_decision`:** `decision_id`, the issue it was opened on, scope (`ISSUE` or `TREE`), the
  `(issue_id, baseline_id)` pairs it covers, state (`OPEN`, `APPLYING`, `APPLIED`, `PARTLY_APPLIED`,
  `SUPERSEDED`), opened_by, opened_at.
- **`va_decision_group`:** `(decision_id, group_key)`, the issues and fields it covers, and the roles
  and assurance it requires. A group's **evidence hash** is computed over those fields' current
  digests whenever it is needed. It is not stored on the group.
- **`va_decision_signature`:** `(decision_id, group_key, approval_id)`, the role signed for, the
  outcome (`APPROVE` or `REJECT`), and the evidence hash that was signed. A signature counts only while
  its evidence hash equals the group's current one. A re-signature is a new row, never an update.

**Scope:**

- **A decision on child A** covers A's drift only.
- **A decision on parent P** covers P's own fields and structure, plus every drifted descendant at any
  depth.

**Flow:**

1. **Open.** The decision row is created by the first signature, not by viewing.
2. **Sign.**
   - Each signer signs one group through the existing approval providers. The approval's
     `content_hash` is the group's evidence hash.
   - A signer may sign a group only if every issue in it is in their visible scope. Otherwise the panel
     says *"2 changed items you can't see need a signer who can"*, and the decision waits.
3. **A group's outcome.**
   - **APPROVE** needs every required role's approval.
   - **One REJECT from any required role settles the group as rejected.** Restoring a signed state
     needs no further approval.
4. **Content changes while open.** Only the affected groups' signatures stop counting and must be given
   again.
5. **Apply,** once every group is decided:
   1. Take the leases on every issue in scope (§5.3).
   2. Re-check each group's evidence against live content.
   3. For each issue, approved fields go into a new version or a signature (cause `DRIFT_DECISION`,
      `decision_id`).
   4. Rejected fields go into a restore plan against **that issue's own** active version, executed by
      the existing restore worker.
   5. Mark the observations settled by `(baseline_id, field_id)` with the `decision_id`.
   6. Release the leases.
6. **Overlapping decisions.** An issue whose drift was decided elsewhere, or changed since the group
   was signed, is **skipped and reported**, and the decision becomes `PARTLY_APPLIED`. One signature
   never overwrites another.

### 8.3 What the panels show

- **Version header:** cause, stage and every signature.
- **Rules:** *"Tracked under: Task rule (QA, e-signature) · inherited from EPIC-1 (Reviewer)"*. Each
  field shows a badge naming the rule(s) that require it.
- **Pending changes, grouped by who must sign:** *"Needs QA · 2 fields"*, *"Needs Reviewer · 3 fields
  across VAT-14, VAT-15"*, each with what has been signed and what is waiting.
- **Provenance:**
  - *"Edited by X, 10:02 (Jira history)"*
  - *"Seen 10:05 after an update by Y; editor not confirmed"*
  - *"Jira history available back to 14:02 only"*
- **History:** every version with its signatures. Versions without recorded policy say *"field
  definitions not recorded"*.
- **Links:** *"Blocks VAT-30 (VAT-30 was at v4 when recorded)"*.
- **Rule changes:** *"Rules changed since v3: …"*.

## 9. Migration

### 9.1 Additive schema (v075 onwards)

- **New tables:** `va_baseline_field`, `va_baseline_rule`, `va_baseline_signature`,
  `va_baseline_link`, `va_capture_lease`, `va_decision`, `va_decision_group`,
  `va_decision_signature`.
- **New columns:** as listed in §4 and §7.1.
- **Nothing is dropped or renamed.** Legacy columns keep being written.
- **The gap between deploy and migration.** If the new tables are missing:
  - reads fall back to the old path;
  - a capture refuses with `SCHEMA_PENDING` and is retried by the event retry.
  - A version is never written without its field and rule rows.

### 9.2 One-time job: fill in what can be proven

This is not a recurring sweep. The migration queues it once. It runs in batches, is resumable and
idempotent, and reports progress on the Health page. For each version:

- **Signature.** One row from the version's own columns. The cause is:
  - `PARENT_CAPTURE` if `captured_by_baseline_id` is set;
  - `LINK_RECORD` for link-worker versions;
  - `OWN_TRANSITION` for an issue's own transition;
  - `MIGRATED` otherwise.
- **Field definitions and rule.**
  1. Recompute `controlledFieldsHash` (`src/lib/baselinePolicy.js`) from today's configuration for
     each scope the version could have been captured under: its own issue type, and the root's (rule
     of 09-25).
  2. **If one matches,** today's configuration provably equals what was signed. Write the field and
     rule rows from it, with the approver from the version's `required_role` and
     `required_assurance`, and set `policy_recorded = true`.
  3. **Otherwise,** set `policy_recorded = false`.
- **Labels** are not covered by the hash. They are written from today's configuration with
  `label_source = MIGRATION`, and displayed as *"Priority (name at migration)"*.
- **Legacy child versions** keep the single rule they were signed under (the root's), recorded as
  `INHERITED`. The child's own rule is not added retroactively. It applies from the next signed
  capture (§6.3).

### 9.3 Legacy trees whose children own no content

Children captured before per-child baselines existed (`ownsItsContent = false`) each get a version.
It is written under the child's lease, at the child's next version:

- **Content:** the parent's stored node, which is what the parent's signer approved.
- **Signature:** the parent's approval, cause `MIGRATED`.
- **`content_as_of`:** the parent's capture time.
- **Rule:** the parent's proven rule, or `policy_recorded = false` if the parent's rule is unproven.
- **The parent's node** is pinned to the new version.

### 9.4 Drift rows and in-progress work

- **Drift rows are not rewritten.** `toObservation` decodes them (§7.1). Undecided rows already carry
  `baseline_id`.
- **Approvals opened but not yet signed** expire as usual.
- **Approvals signed against old evidence** fail with `STALE_EVIDENCE` and are reviewed again.
- **Running restores** continue unchanged.

### 9.5 Rollout order

1. Schema, and captures also write the new rows. Readers are unchanged, so behaviour is unchanged.
2. The one-time job (§9.2, §9.3).
3. Leases on every write of a version (§5.3). This closes race R.
4. Capture, and the validator's signing hash, switch to `resolveRules` (the union rule). Until this
   step, step 1's rows record the field set captures actually used. Readers switch to
   `recordedRules`, `toObservation` and `visibleScope`. `fieldsForItem`,
   `scopeForItem`, `readTreeWithNodeFields`, `ownsItsContent` and the `nodes[0]` fallback are deleted.
   **Behaviour changes from here. Rolling back past this step is not clean:** old code would recompute
   a child's fields from today's configuration and report false drift on versions written under the
   union rule.
5. Decisions with signing groups (§8.2).

## 10. Testing

### 10.1 Scenario world

Extend `test/helpers/validator-world.js`, which already runs the real validator, panel and link worker.
Each scenario can change every source of truth between steps:

- **Jira:** issues, parent chain, links, deletions, security levels.
- **Changelog:** complete, truncated at page N, failed, or missing particular items.
- **Per-viewer permissions:** including a failed permission check.
- **Configuration over time:** fields, kinds, materiality, labels, transitions, roles.
- **SQL:** an in-memory fake that **enforces unique keys and conditional updates**.
- **A stepper** that pauses a capture or decision at named points (after read, after version
  reservation, before publish), runs other work, then resumes it.

### 10.2 Scenarios

Each scenario that reproduces a known defect is first run against today's code and seen to fail.

- **Defect 1.**
  - Root missing from the stored tree → `RECORD_UNRECONSTRUCTABLE`, and no child values appear in the
    response.
  - Viewer cannot browse child C → the entire serialized response contains no key, value, digest,
    observation or attachment name of C (checked with sentinel strings).
  - A failed permission check, and a deleted child that had a security level.
- **Defect 2.** Event by Y with no changelog item → `UNATTRIBUTED`, triggered by Y. It is never
  displayed as "edited by Y" and is excluded from `driftByAuthor`. A failed changelog read →
  `HISTORY_UNAVAILABLE`.
- **Defect 3.**
  - Stored A, B, C with a truncated Jira history returning only B → the trace shows A, B and C, with B
    confirmed; the count reads "at least"; the cursor is not advanced.
  - A reverted edit that only Jira saw appears in the trace.
- **Defect 4.**
  - A legacy tree child, after the job, has its own pinned version, and its observations are found by
    `baseline_id`.
  - A child re-baselined by its own decision after the parent's capture is compared against its own
    version.
- **Defect 5.** After capture, a field is renamed, its kind or materiality changes, or the child
  type's configuration changes → history and diffs show the signed definitions; detection is
  unchanged; the "rules changed" notice appears.
- **Race R.**
  - The parent reads C1; T is edited to C2 and captured as v2; the parent resumes → T never gets a
    version holding C1 above v2.
  - Both lease orders → version order equals commit order; identical content gives a signature only.
  - A crash while holding leases → the lease expires and `CAPTURING` rows are recovered.
  - Overlapping parent and grandparent captures → both complete, with no deadlock.
- **Rules.**
  - A grandchild under a baselined Epic and Story has Epic + Story + own rules, with correct
    `required_by`.
  - Re-parenting keeps inherited rules until the next signed capture.
  - `UNCONFIGURED`, `POLICY_CONFLICT` and `ANCESTOR_POLICY_UNRECORDED`.
  - A configuration change is not retroactive.
- **Decisions.**
  - A decision on child A versus parent P (n children, m drifted).
  - Two roles: any reject wins; nothing is applied until every group is decided.
  - A group's evidence changes → only that group's signatures stop counting.
  - Overlap: A is decided during P's decision → P skips A and reports it.
  - A hidden child blocks only the groups containing it.
- **Links.** The other end's version is recorded; edits to the other end are not drift here.
- **Migration.**
  - Hash match or mismatch, superseded versions, the label marker.
  - The job run twice changes nothing; an interrupted job resumes.
  - `SCHEMA_PENDING` in the gap between deploy and migration.

### 10.3 Invariants checked after every scenario step

- Exactly one active version per issue, and it is the highest.
- Every version written after step 1 of §9.5 has at least one signature and its field rows, and every
  `required_by` names a rule on the version.
- Every parent node pins a child version that exists.
- No observation exposes an editor or edit time unless it is `CONFIRMED`.
- **Signatures and versions never change after they are written,** apart from a version's `state`.
  This covers versions, field, rule, signature, link and decision-signature rows. The tables are
  snapshotted before each step, and every earlier row must be unchanged afterwards.

### 10.4 UI and live checks

- **UI.** `frontend/test/panel.test.mjs` covers the version header (cause, stage), rule badges, signing
  groups and their states, provenance wording, the hidden-children notice, and "definitions not
  recorded".
- **Live, on mgtechdemo (project VAT), after rollout steps 3 and 5.**
  - Configure Epic, Story and Sub-task with different fields and roles.
  - Run Epic and Story transitions at the same time from two sessions, signing with TOTP (the
    biometric ceremony cannot complete in the in-app browser).
  - Check the panels, the history and the Health page after the job.
  - Exact interleavings are covered by §10.1, not live.

## 11. Out of scope

- **Holding a parent on structure drift.** Holding a parent when children are added or removed is a
  separate open gap in the validator, and is not changed here. Structure is still recorded and
  reviewed.
- **Retiring `fidelity` and other legacy `va_baseline` columns.** These stay.
- **AI report wording.** It reads observations through `toObservation`. Its prompts are not redesigned
  here.
