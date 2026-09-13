# Baseline-Owned Recall and Responsive Controls Implementation Plan

**Goal:** Make the latest active baseline the server-owned authority for drift recall, drift approval, restoration, and UI actions while keeping the transition screen exact and making the issue panel and My Approvals immediately useful.

**Architecture:** Preserve the existing `va_approval` lifecycle and exact Jira transition binding. Repair recursive baseline storage first, persist immutable role/provider/edge provenance on every baseline, derive drift actions only from the latest active baseline, and journal restoration as idempotent actions continued by a Forge async-events consumer. Split the shared panel model into a compact summary and lazy evidence read; authorization paths continue to perform fresh full reads.

**Tech Stack:** Atlassian Forge Node.js 22, Jira Cloud REST API v3, Forge SQL/MySQL, Forge Async Events API (`@forge/events` 3.x), React 19, Atlaskit, UI Kit, SimpleWebAuthn, Node test runner, TypeScript 6, Vite 8.

**Spec:** `docs/specs/2026-09-13-baseline-owned-recall-and-responsive-controls-design.md`

## Global constraints

- Preserve the dirty checkout. Inspect every target before editing, stage only task-owned hunks, and never delete or sweep the existing scratch/untracked files.
- Do not add AI, co-author, or generated-with attribution to commits.
- Treat the current local suite as red: the 2026-09-13 baseline is 717 tests, 704 passes, and 13 failures. Never weaken those assertions to reach green.
- The Jira transition id is authoritative. Status ids are context and validation constraints, never substitutes.
- Only `ESIGNATURE` and `BIOMETRIC` are configurable in this release. Jira-native and JSM approvals stay deferred.
- No client-supplied role, provider, transition, destination, baseline id/version, actor identity, or policy snapshot is authoritative.
- A baseline is visible as `ACTIVE` only after its complete field/tree payload is durable. Older baselines are retained and only superseded after N+1 is published.
- Drift approval and rejection always resolve the latest `ACTIVE` baseline at decision time, not the baseline signed by the current actor.
- Rejection restores retained controlled content and tree structure, verifies the entire result plus root status from Jira, and leaves the root in the baseline review status.
- `COMPLETE_WITH_REPLACEMENTS` is a verified terminal state and must remain distinct from `COMPLETE`.
- UI summary reads are presentation optimizations only. Challenge, submit, retry, transition, and restore workers re-read authoritative state.
- Local verification, deployment, installation/migrations, and live Jira acceptance are separate checkpoints.

---

### Task 1: Repair the recursive capture contract and restore a green foundation

**Files:**

- Modify: `src/lib/tree/capturePlan.js`
- Modify: `src/lib/capture.js`
- Modify: `src/db/baselineTreeStore.js`
- Modify: `src/db/baselineStore.js`
- Modify: `test/tree-capture.test.js`
- Modify: `test/tree-storage.test.js`
- Modify: `test/controlled-transition-tree-acceptance.test.js`
- Modify: `test/drift-functional.test.js`

**Interfaces:**

- `planTreeCapture(...) -> { treeHash, nodeCount, edgeCount, totalFieldCount, nodes, values }`
- `nodes[] -> { logicalNodeId, originalIssueId, currentIssueId, issueKey, parentLogicalNodeId, projectId, issueTypeId, contentHash, fieldDigests, nodeOrder }`
- `values -> Record<logicalNodeId, Record<fieldId, rawValue>>`
- `writeTreeBaseline({ baseline, nodes, values, resume }) -> { baselineId, version, valueBytes }`

- [x] **Step 1: Replace permissive fixture shapes with failing contract tests**

```js
test('capture plan separates durable node metadata from retained values', () => {
  const plan = planTreeCapture(fixture());
  assert.deepEqual(Object.keys(plan.nodes[0]).sort(), [
    'contentHash', 'currentIssueId', 'fieldDigests', 'issueKey',
    'issueTypeId', 'logicalNodeId', 'nodeOrder', 'originalIssueId',
    'parentLogicalNodeId', 'projectId'
  ]);
  assert.deepEqual(plan.values[plan.nodes[0].logicalNodeId].summary, 'Signed root');
});

test('tree capture reserves a baseline id, writes all nodes, then publishes', async () => {
  const result = await writeCapturedTreeBaseline(fixture());
  assert.deepEqual(calls, ['find-existing', 'next-version', 'begin', 'write-tree', 'verify-durable', 'publish', 'item-state', 'ledger']);
  assert.equal(result.baselineId, 'baseline-1');
});

test('approval id is never used as a baseline id', async () => {
  await writeCapturedTreeBaseline(fixture());
  assert.equal(writeArgs.baselineId, 'baseline-1');
  assert.notEqual(writeArgs.baselineId, fixture().approval.approvalId);
});
```

- [x] **Step 2: Run the focused red tests**

Run: `node --test test/tree-capture.test.js test/tree-storage.test.js test/controlled-transition-tree-acceptance.test.js test/drift-functional.test.js`

Expected: failures reproduce the missing `nodes`, approval-id/baseline-id mix-up, and incomplete publication order.

- [x] **Step 3: Make `planTreeCapture` emit the storage contract without mutation**

```js
const nodes = planned.map((node, nodeOrder) => ({
  logicalNodeId: node.logicalNodeId,
  originalIssueId: Number(node.id),
  currentIssueId: Number(node.id),
  issueKey: String(node.key),
  parentLogicalNodeId: node.parentLogicalNodeId,
  projectId: Number(node.fields.project.id),
  issueTypeId: String(node.fields.issuetype.id),
  contentHash: node.contentHash,
  fieldDigests: JSON.stringify(node.digests),
  nodeOrder
}));
const values = Object.fromEntries(planned.map(node => [node.logicalNodeId, node.raw]));
return { treeHash, nodeCount: nodes.length, edgeCount, totalFieldCount, nodes, values };
```

Require the Jira tree reader to include `project`, `issuetype`, `status`, and `parent` even when they are not controlled fields. Reject missing roots, duplicate ids, missing parents, cycles, more than 500 nodes, or any controlled field without a retained raw value.

- [x] **Step 4: Add a hidden-until-complete tree baseline lifecycle**

Add focused store functions in `baselineTreeStore.js`:

```js
beginTreeBaseline({ baseline, resume })
writeTreeCapture({ baselineId, treeHash, nodes, values })
verifyTreeCapture({ baselineId, expectedNodeCount, expectedFieldCount, expectedTreeHash })
publishTreeBaseline({ baselineId, issueId, version })
```

`beginTreeBaseline` creates one `CAPTURING` `va_baseline` row keyed by a new baseline id (or resumes the row for the same approval). `writeTreeCapture` only writes node/value rows for that baseline id. `verifyTreeCapture` counts distinct nodes and value fields and checks stored tree metadata. `publishTreeBaseline` changes `CAPTURING -> ACTIVE` with a guarded update and only then supersedes lower versions. Readers continue to ignore `CAPTURING` rows.

- [x] **Step 5: Rewire `writeCapturedTreeBaseline` to the lifecycle**

Derive project/issue type from the root node, use `baselineForApproval` and `currentVersion` for idempotency/versioning, compare the approval hash to the complete tree hash, write with the baseline id returned by `beginTreeBaseline`, verify storage before publication, and publish item state/audit only after activation. Remove the undefined `publishTreeBaseline` import path and the `stored.version ?? 2` fallback.

- [x] **Step 6: Run the focused group, then the complete backend suite**

Run: `node --test test/tree-capture.test.js test/tree-storage.test.js test/controlled-transition-tree-acceptance.test.js test/drift-functional.test.js`

Run: `npm test`

Expected: 717/717 pass before later tasks add tests.

- [x] **Step 7: Commit only Task 1 hunks**

```bash
git add -p src/lib/tree/capturePlan.js src/lib/capture.js src/db/baselineTreeStore.js src/db/baselineStore.js test/tree-capture.test.js test/tree-storage.test.js test/controlled-transition-tree-acceptance.test.js test/drift-functional.test.js
git diff --cached --check
git commit -m "fix: complete recursive baseline publication"
```

---

### Task 2: Journal every restoration action and use real Jira mutations

**Files:**

- Modify: `src/db/migrations.js`
- Modify: `src/db/restoreTreeStore.js`
- Modify: `src/lib/tree/restorePlan.js`
- Modify: `src/lib/tree/restoreExecutor.js`
- Modify: `src/lib/tree/restoreVerifier.js`
- Modify: `src/lib/tree/jira.js`
- Create: `src/lib/tree/restoreAdapters.js`
- Modify: `src/usecases/restoreActions.js`
- Modify: `test/migrations.test.js`
- Modify: `test/tree-restore-plan.test.js`
- Modify: `test/tree-restore-execution.test.js`
- Modify: `test/tree-restore-verification.test.js`
- Modify: `test/restore-correctness.test.js`

**Interfaces:**

- Migration `v038_restore_action` creates `va_restore_action` keyed by `(restore_id, step_key)`.
- `stepKey = sha256(canonical({ kind, logicalNodeId, parentLogicalNodeId, fieldIds }))`.
- `executeTreeRestore({ ..., maxActions }) -> { state, attempted, completed, remaining, replacements }`.
- Jira adapter methods throw typed failures and return Jira ids/keys; they never return unconditional `true`.

- [x] **Step 1: Write failing plan and journal tests**

```js
test('move and field restore on one node have distinct durable keys', () => {
  const plan = planTreeRestore(fixtureWithMoveAndFieldChange());
  assert.equal(new Set(plan.steps.map(step => step.stepKey)).size, plan.steps.length);
});

test('a failed field action resumes without replaying a completed move', async () => {
  const first = await executeTreeRestore({ ...fixture(), maxActions: 2 });
  assert.equal(first.state, 'PARTIAL');
  const second = await executeTreeRestore({ ...fixture(), maxActions: 10 });
  assert.equal(mutations.move.length, 1);
  assert.equal(second.state, 'READY_TO_VERIFY');
});

test('no Jira mutation occurs when preflight cannot prove permissions', async () => {
  const result = await executeTreeRestore(fixture({ permissionResponse: 403 }));
  assert.equal(result.state, 'FAILED');
  assert.equal(mutations.length, 0);
});
```

- [x] **Step 2: Add the action journal migration**

```sql
CREATE TABLE IF NOT EXISTS va_restore_action (
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
)
```

Leave `va_restore_step` intact for historical evidence. All new work uses `va_restore_action`.

- [x] **Step 3: Make the plan deterministic and dependency-safe**

Order actions as: recreate missing baseline nodes parent-first; move surviving/recreated nodes parent-first; restore controlled values; delete added descendants deepest-first; verify. Each `RESTORE_FIELDS` step carries the raw retained value map, not field ids. Never delete the governed root. A deleted baseline root is not replaceable and fails closed.

- [x] **Step 4: Implement Jira adapters with response checking**

`restoreAdapters.js` uses `api.asApp().requestJira` for preflight permissions, issue creation, parent updates, controlled-field edits with screen overrides where supported, and added-node deletion. Parse Jira error bodies into durable action detail. Treat 404 deletion as idempotent success only when the journal proves the same `DELETE_ADDED_NODE` action was previously claimed for a node proven absent from the baseline.

- [x] **Step 5: Replace placeholder restoration and verification**

Pass `prepared.baselineTree` and `prepared.currentTree` explicitly. Use `readStableTree({ readTree, rootIssueKey, fieldIds })` with the actual signature. Map replacement ids to logical node ids, rebuild the current logical tree, run `diffTree`, and require zero node/edge/field changes. Also re-read `status` and require the root to equal `baseline.from_status_id` before terminal success.

- [x] **Step 6: Run restore and regression tests**

Run: `node --test test/migrations.test.js test/tree-restore-plan.test.js test/tree-restore-execution.test.js test/tree-restore-verification.test.js test/restore-correctness.test.js test/restore-verification.test.js`

Expected: all pass; no fake `moveIssue`/`editIssue`/permission adapter remains in production.

- [x] **Step 7: Commit only Task 2 hunks**

```bash
git add -p src/db/migrations.js src/db/restoreTreeStore.js src/lib/tree/restorePlan.js src/lib/tree/restoreExecutor.js src/lib/tree/restoreVerifier.js src/lib/tree/jira.js src/lib/tree/restoreAdapters.js src/usecases/restoreActions.js test/migrations.test.js test/tree-restore-plan.test.js test/tree-restore-execution.test.js test/tree-restore-verification.test.js test/restore-correctness.test.js
git diff --cached --check
git commit -m "fix: journal and verify recursive restoration"
```

---

### Task 3: Configure controlled rules from Jira's real workflow transitions

**Files:**

- Create: `src/lib/workflowSource.js`
- Modify: `src/jobs/gatecheck.js`
- Modify: `src/usecases/adminDirectory.js`
- Modify: `src/usecases/admin.js`
- Modify: `src/usecases/transitionsValidation.js`
- Modify: `src/resolvers/admin.js`
- Modify: `frontend/src/admin/pages/TransitionsPage.tsx`
- Modify: `test/admin-configuration.test.js`
- Modify: `test/admin-health.test.js`
- Create: `test/admin-workflow-transitions.test.js`
- Modify: `frontend/test/panel.test.mjs`

**Interfaces:**

- `readWorkflowForPair({ projectId, issueTypeId }, { request }) -> workflow | null`
- `listWorkflowTransitions(...) -> [{ transitionId, name, fromStatusId, fromStatusName, toStatusId, toStatusName, global, hasScreen, jiraRules, validatorAttached }]`
- Resolver: `admin:listWorkflowTransitions`

- [x] **Step 1: Write failing exact-picker tests**

Prove that two same-destination transitions remain two options, a global Jira transition is represented as `fromStatusId: '*'`, an edge with a screen reports `hasScreen`, and creation refuses a missing/detached VAtlassian validator or a transition no longer present in the workflow snapshot.

- [x] **Step 2: Extract the existing workflow read into one shared source**

Move `fetchWorkflowForPair` and its one-project/one-issue-type request from `gatecheck.js` into `workflowSource.js`. Keep `asApp`, `POST /rest/api/3/workflows?expand=workflows.transitions`, the one-pair-per-request attribution rule, and fail-closed `null` behavior.

- [x] **Step 3: Add server-side normalized transition discovery**

The admin resolver rechecks admin authority, reads the live workflow, normalizes source/destination/screen/rules, and marks whether the `va-gate` validator for this app identity is attached. It does not accept workflow facts from the browser.

- [x] **Step 4: Replace independent status inputs with one transition selector**

After project and issue type are selected, render a labelled transition selector. Each option label is:

```ts
`${global ? 'Any status' : fromStatusName} -> ${toStatusName} - ${name} (#${transitionId})`
```

On selection, populate `transitionId`, `fromStatusId`, and `toStatusId` from the server result and show screen/validator/Jira-rule facts read-only. Clear the selection when project or issue type changes. Disable save while discovery is loading, failed, stale, or reports a blocking finding.

- [x] **Step 5: Revalidate exact workflow facts on save**

`createControlledTransition` and `updateControlledTransition` re-read the selected live transition and compare id/from/to. They also require an eligible holder, an explicit valid provider, a retained value for every controlled field when capture is enabled, and no conflicting active exact scope.

- [x] **Step 6: Run admin/backend/frontend checks**

Run: `node --test test/admin-configuration.test.js test/admin-health.test.js test/admin-workflow-transitions.test.js test/signing-context.test.js test/transition-policy.test.js`

Run: `npm --prefix frontend test && npm --prefix frontend run build`

- [x] **Step 7: Commit only Task 3 hunks**

```bash
git add -p src/lib/workflowSource.js src/jobs/gatecheck.js src/usecases/adminDirectory.js src/usecases/admin.js src/usecases/transitionsValidation.js src/resolvers/admin.js frontend/src/admin/pages/TransitionsPage.tsx test/admin-configuration.test.js test/admin-health.test.js test/admin-workflow-transitions.test.js frontend/test/panel.test.mjs
git diff --cached --check
git commit -m "feat: configure exact Jira workflow transitions"
```

---

### Task 4: Persist immutable baseline-owned control provenance

**Files:**

- Modify: `src/db/migrations.js`
- Modify: `src/db/baselineStore.js`
- Modify: `src/db/baselineTreeStore.js`
- Modify: `src/lib/baseline.js`
- Modify: `src/lib/capture.js`
- Create: `src/lib/baselinePolicy.js`
- Modify: `test/migrations.test.js`
- Modify: `test/baseline-storage.test.js`
- Modify: `test/baseline-capture-lifecycle.test.js`
- Modify: `test/tree-capture.test.js`

**Interfaces:**

- Migration `v039_baseline_control_provenance` adds `required_role`, `required_assurance`, and `controlled_fields_hash` to `va_baseline`.
- `baselinePolicy(baseline) -> { baselineId, version, transitionId, reviewStatusId, destinationStatusId, requiredRole, requiredAssurance, controlledFieldsHash }`

- [x] **Step 1: Write failing immutable-provenance tests**

Prove that a baseline retains the original role/provider/edge after its controlled-transition row changes, `required_assurance` is distinct from achieved `assurance_level`, and a missing provenance field makes drift decisions unavailable rather than falling back to the current rule.

- [x] **Step 2: Add columns and include them in every read/write**

```sql
ALTER TABLE va_baseline
  ADD COLUMN required_role VARCHAR(32) NULL,
  ADD COLUMN required_assurance VARCHAR(24) NULL,
  ADD COLUMN controlled_fields_hash CHAR(64) NULL
```

New baselines require all three before publication. Existing baselines with null provenance remain readable as historical evidence, but a drift action against one returns `BASELINE_POLICY_INCOMPLETE` and raises an admin incident.

- [x] **Step 3: Compute the field-catalogue hash server-side**

Hash canonical ordered entries containing field id, field kind/schema, materiality, `store_values`, and writable classification. Both scalar and tree capture write the same snapshot values from the exact gate and controlled-field list used for content hashing.

- [x] **Step 4: Run storage/capture regression tests**

Run: `node --test test/migrations.test.js test/baseline-storage.test.js test/baseline-capture-lifecycle.test.js test/tree-capture.test.js test/controlled-transition-tree-acceptance.test.js`

- [x] **Step 5: Commit only Task 4 hunks**

```bash
git add -p src/db/migrations.js src/db/baselineStore.js src/db/baselineTreeStore.js src/lib/baseline.js src/lib/capture.js src/lib/baselinePolicy.js test/migrations.test.js test/baseline-storage.test.js test/baseline-capture-lifecycle.test.js test/tree-capture.test.js
git diff --cached --check
git commit -m "feat: persist baseline control provenance"
```

---

### Task 5: Recall drift to the latest baseline's review status

**Files:**

- Modify: `src/lib/recall.js`
- Modify: `src/lib/restore/recall.js`
- Modify: `src/db/configStore.js`
- Modify: `src/db/incidentStore.js`
- Modify: `src/lib/ledger.js`
- Modify: `src/lib/collect.js`
- Modify: `test/baseline-recall.test.js`
- Modify: `test/baseline-trigger-retry.test.js`
- Modify: `test/drift-functional.test.js`
- Modify: `test/admin-health.test.js`

**Interfaces:**

- `recallPlan({ currentStatusId, targetStatusId, transitions, driftCount })`
- New outcomes: `AMBIGUOUS_ROUTE`, `SCREEN_BLOCKED`, `JIRA_REFUSED` in addition to existing no-op/success outcomes.
- `recallToReview` receives `{ baselineId, baselineVersion, reviewStatusId }`; it never calls `recallTargetStatus`.

- [x] **Step 1: Write zero/one/multiple-route tests**

```js
test('latest baseline source is the only recall target', async () => {
  await recallToReview({ ...fixture, reviewStatusId: '17', baselineVersion: 4 });
  assert.equal(applied.transitionId, '301');
  assert.equal(configLookups.length, 0);
});

test('two Jira routes to review are ambiguous', () => {
  assert.equal(recallPlan({ ...fixture, transitions: [route('1', '17'), route('2', '17')] }).action, 'AMBIGUOUS_ROUTE');
});
```

- [x] **Step 2: Make route selection exact and fail closed**

Filter offered/available transitions to the baseline review status. Proceed only when exactly one remains and it has no unsatisfied screen. If already at review, do nothing. Never use another configured rule, first-match routing, or another review status.

- [x] **Step 3: Persist administrator-only incidents**

Use a dedupe key containing baseline id/version and failure type. Record offered transition ids, target status, screen fact, Jira response, and last retry time. Keep ordinary reviewer responses actionable but free of configuration-repair tasks.

- [x] **Step 4: Run recall, trigger, and admin-health tests**

Run: `node --test test/baseline-recall.test.js test/baseline-trigger-retry.test.js test/drift-functional.test.js test/admin-health.test.js test/signature-ledger.test.js`

- [x] **Step 5: Commit only Task 5 hunks**

```bash
git add -p src/lib/recall.js src/lib/restore/recall.js src/db/configStore.js src/db/incidentStore.js src/lib/ledger.js src/lib/collect.js test/baseline-recall.test.js test/baseline-trigger-retry.test.js test/drift-functional.test.js test/admin-health.test.js
git diff --cached --check
git commit -m "fix: recall drift from baseline provenance"
```

---

### Task 6: Make drift approval publish N+1 before the exact transition

**Files:**

- Modify: `src/usecases/approval.js`
- Modify: `src/usecases/drift.js`
- Modify: `src/lib/approval/challenge.js`
- Modify: `src/lib/approval/runtime.js`
- Modify: `src/db/approvalStore.js`
- Modify: `src/lib/transitions.js`
- Modify: `src/usecases/restoreActions.js`
- Modify: `test/approval-submit.test.js`
- Modify: `test/approval-assurance.test.js`
- Modify: `test/drift-functional.test.js`
- Modify: `test/gate-approval.test.js`
- Modify: `test/controlled-transition-tree-acceptance.test.js`

**Interfaces:**

- Drift challenge payload from UI: `{ issueKey, decision, expectedEvidenceHash, confirmed, proof }` only.
- Server binding includes `{ baselineId, baselineVersion, transitionId, fromStatusId, toStatusId, requiredRole, requiredAssurance, contentHash, actorAccountId, decision }`.
- Drift approve result distinguishes `{ baselinePublished, transitioned, transitionError, retryableApprovalId }`.

- [ ] **Step 1: Add baseline-owned behavior and race tests**

Prove the server ignores injected transition/role/provider values, uses the latest active baseline, rejects a challenge after N+1 appears, refuses a no-longer-eligible actor, publishes N+1 before calling Jira, never calls Jira if publication/audit fails, and makes a validator-denied transition retry require fresh review/signature.

- [ ] **Step 2: Resolve drift authority without the current rule row**

`prepareApproval` loads `baselinePolicy(activeBaseline)` and checks current role membership using the recorded `required_role`. Select the provider from recorded `required_assurance`. The current config row may be consulted only for a health incident; it cannot change the control.

- [ ] **Step 3: Bind and consume the exact baseline edge**

For drift approval, create the approval with baseline transition/from/to, capture tree/scalar baseline N+1 with the same provenance, append required audit entries, and only then call `applyTransition` with the exact stored transition id. Re-read Jira transitions first and require current status to equal review status and destination to match.

- [ ] **Step 4: Keep rejection in review and verify status**

Rejection never uses `reject_to_status_id`. Before restoration starts, require/recall the root to baseline review status. Restore content/tree, then verify fields, relationships, and status. Clear drift only for `COMPLETE` or `COMPLETE_WITH_REPLACEMENTS`; update existing `markDecided`/`release` terminal checks accordingly.

- [ ] **Step 5: Run approval, drift, gate, and tree journeys**

Run: `node --test test/approval-submit.test.js test/approval-assurance.test.js test/drift-functional.test.js test/gate-approval.test.js test/controlled-transition-tree-acceptance.test.js test/restore-correctness.test.js`

- [ ] **Step 6: Commit only Task 6 hunks**

```bash
git add -p src/usecases/approval.js src/usecases/drift.js src/lib/approval/challenge.js src/lib/approval/runtime.js src/db/approvalStore.js src/lib/transitions.js src/usecases/restoreActions.js test/approval-submit.test.js test/approval-assurance.test.js test/drift-functional.test.js test/gate-approval.test.js test/controlled-transition-tree-acceptance.test.js
git diff --cached --check
git commit -m "feat: transition approved drift from baseline policy"
```

---

### Task 7: Split the panel into compact summary and lazy evidence reads

**Files:**

- Create: `src/usecases/panelSummary.js`
- Create: `src/usecases/panelEvidence.js`
- Modify: `src/usecases/panel.js`
- Modify: `src/usecases/panelAccess.js`
- Modify: `src/db/approvalStore.js`
- Modify: `src/db/baselineStore.js`
- Modify: `src/db/incidentStore.js`
- Modify: `src/resolvers/panel.js`
- Modify: `test/panel-state.test.js`
- Modify: `test/panel-response.test.js`
- Modify: `test/resolver-wiring.test.js`
- Create: `test/panel-performance-contract.test.js`

**Interfaces:**

- Resolver `panel:getSummary` returns issue/status, every applicable controlled action, eligibility, latest approval, baseline provenance, drift counters, restore progress, and admin incident count.
- Resolver `panel:getEvidence` returns values, tree/diff details, attribution, baseline history, and restore history for an expected baseline/version.
- `panel:getState` remains temporarily as a compatibility adapter and is removed only after all callers migrate.

- [ ] **Step 1: Write dependency-boundary tests**

```js
test('summary never invokes tree, changelog, editmeta, or baseline-value readers', async () => {
  const summary = await getSummary(args, forbiddenHeavyDeps());
  assert.equal(summary.issue.key, 'VA-1');
});

test('observer sees control and provenance but no enabled actions', async () => {
  const state = await getSummary(observerFixture());
  assert.equal(state.transitions[0].requiredRole, 'QA');
  assert.equal(state.transitions[0].canApprove, false);
});
```

- [ ] **Step 2: Implement a narrow summary query path**

Read Jira with only `project,issuetype,status,summary`. Run independent SQL reads in parallel: active baseline summary, item state, latest transition approval, restore state/progress, gate rows, eligibility, and admin incident count. Resolve all Jira-offered transitions once and exact-match each gate. The summary must never call `snapshot`, `readStableTree`, `fetchChangelog`, `readAllValues`, or `editmeta`.

- [ ] **Step 3: Return one shared viewer projection**

Every viewer receives controlled status, exact scoped labels (`Any status -> Done` versus `In Progress -> Done`), role/provider/meaning, baseline capture/drift flags, latest baseline owner/time/version/method/field count, latest approval outcome/time/owner, and drift/restore state. Add `canApprove`, `canReject`, and retry flags per action; omit proof inputs and enabled actions for ineligible viewers.

- [ ] **Step 4: Move heavy reads into evidence**

`getEvidence` receives only issue identity plus expected baseline/version/selected transition. It rejects stale expectations, then uses the existing full `snapshot` mechanics to return recursive tree, values, changelog attribution, diff, baseline history, and restoration history.

- [ ] **Step 5: Run panel contracts and full backend suite**

Run: `node --test test/panel-state.test.js test/panel-response.test.js test/resolver-wiring.test.js test/panel-performance-contract.test.js test/queue.test.js test/journey.test.js`

Run: `npm test`

- [ ] **Step 6: Commit only Task 7 hunks**

```bash
git add -p src/usecases/panelSummary.js src/usecases/panelEvidence.js src/usecases/panel.js src/usecases/panelAccess.js src/db/approvalStore.js src/db/baselineStore.js src/db/incidentStore.js src/resolvers/panel.js test/panel-state.test.js test/panel-response.test.js test/resolver-wiring.test.js test/panel-performance-contract.test.js
git diff --cached --check
git commit -m "perf: split panel summary from evidence"
```

---

### Task 8: Make all three approval surfaces immediate, exact, and role-aware

**Files:**

- Modify: `frontend/src/panel/types.ts`
- Modify: `frontend/src/panel/usePanelState.ts`
- Create: `frontend/src/panel/usePanelEvidence.ts`
- Modify: `frontend/src/panel/IssuePanel.tsx`
- Modify: `frontend/src/panel/sections/ApprovalControls.tsx`
- Modify: `frontend/src/panel/sections/BaselineRecord.tsx`
- Modify: `frontend/src/panel/sections/DriftSection.tsx`
- Modify: `frontend/src/panel/sections/RestoreStatus.tsx`
- Modify: `frontend/src/panel/approvalModel.ts`
- Modify: `frontend/src/lib/issueUpdates.ts`
- Modify: `frontend/src/lib/bridge.ts`
- Modify: `frontend/src/field/ApprovalField.tsx`
- Modify: `src/ui-kit/edit.jsx`
- Modify: `frontend/test/panel.test.mjs`

**Interfaces:**

- Transition screen: exact read-only action from `context.extension.issueTransition.id`; no selector.
- Panel/My Approvals: selector appears for 2+ applicable actions and uses the shared `IssuePanel` component.
- Summary refresh is single-flight with sequence protection; evidence is lazy and keyed by selected action plus baseline version.

- [ ] **Step 1: Write rendering, reset, refresh, and timing tests**

Prove that all eligible buttons render without a disclosure; the button says `Approve -> <destination>`; drift shows `Approve changes` and `Reject and restore`; every viewer sees baseline/approval facts; switching between `Any status -> Done` and `In Progress -> Done` clears code, confirmation, WebAuthn challenge, evidence, and messages; transition screen has no selector; no interval timer exists; two refresh requests coalesce; an older response cannot replace newer state; button progress text appears synchronously.

- [ ] **Step 2: Render a useful shell before network completion**

Render issue identity when available from Forge context plus labelled skeleton rows for control state, latest baseline, latest approval, and actions. Do not render an empty panel or indefinite unlabelled spinner.

- [ ] **Step 3: Use the compact summary first and evidence on demand**

`usePanelState` invokes `panel:getSummary`. `usePanelEvidence` invokes `panel:getEvidence` only when the evidence section opens or an approval flow requires review. Existing visible controls stay rendered while evidence loads. If evidence reports a newer baseline/version, refresh summary and discard that evidence.

- [ ] **Step 4: Implement exact action selection and all visible controls**

Use `transition.label`, never only `transition.name`, for options. Keep all role-eligible actions visible. Drift actions carry no client transition/provider/role facts. Disable duplicate submits immediately and use state-specific copy: `Preparing signature`, `Checking biometric`, `Publishing baseline`, `Moving to Done`, `Starting restoration`, and `Restoration in progress`.

- [ ] **Step 5: Remove polling and duplicate events**

Delete `window.setInterval`. Retain `JIRA_ISSUE_CHANGED`, `VA_ISSUE_CHANGED`, focus, visibility return, manual Refresh, and post-action refresh. Centralize one `VA_ISSUE_CHANGED` emission in the bridge after a successful durable mutation; remove component-level duplicate emits.

- [ ] **Step 6: Run frontend tests, lint, and build**

Run: `npm --prefix frontend test`

Run: `npm --prefix frontend run lint`

Run: `npm --prefix frontend run build`

Expected: tests/build/lint pass and no production `setInterval` remains under `frontend/src`.

- [ ] **Step 7: Commit only Task 8 hunks**

```bash
git add -p frontend/src/panel/types.ts frontend/src/panel/usePanelState.ts frontend/src/panel/usePanelEvidence.ts frontend/src/panel/IssuePanel.tsx frontend/src/panel/sections/ApprovalControls.tsx frontend/src/panel/sections/BaselineRecord.tsx frontend/src/panel/sections/DriftSection.tsx frontend/src/panel/sections/RestoreStatus.tsx frontend/src/panel/approvalModel.ts frontend/src/lib/issueUpdates.ts frontend/src/lib/bridge.ts frontend/src/field/ApprovalField.tsx src/ui-kit/edit.jsx frontend/test/panel.test.mjs
git diff --cached --check
git commit -m "feat: make approval surfaces responsive"
```

---

### Task 9: Continue long restoration through an idempotent Forge queue worker

**Files:**

- Modify: `src/db/migrations.js`
- Modify: `src/db/restoreStore.js`
- Create: `src/lib/restore/queue.js`
- Create: `src/jobs/restoreWorker.js`
- Modify: `src/usecases/restoreActions.js`
- Modify: `src/usecases/restore.js`
- Modify: `src/resolvers/panel.js`
- Modify: `manifest.yml`
- Modify: `test/migrations.test.js`
- Create: `test/restore-worker.test.js`
- Modify: `test/restore-resume.test.js`
- Modify: `test/manifest-lint.test.js`
- Modify: `test/resolver-wiring.test.js`

**Interfaces:**

- Queue key: `va-restore-queue`.
- Event body: `{ restoreId: string, issueId: number, baselineId: string, baselineVersion: number }`.
- Consumer function: `restore-worker`, handler `jobs/restoreWorker.handler`, `timeoutSeconds: 600`.
- Queue push uses `{ body, concurrency: { key: `restore:${issueId}`, limit: 1 } }`.

- [ ] **Step 1: Write failing durable-worker tests**

Prove that signed rejection persists the restore and action plan before enqueueing; enqueue failure leaves a resumable `QUEUING_FAILED` operation; at-least-once delivery does not replay completed actions; a worker with stale baseline/version exits without mutation; a bounded batch republishes itself only when unfinished actions remain; terminal verification happens once; retry uses the original rejection approval.

- [ ] **Step 2: Add restore progress columns**

Migration `v040_restore_progress` adds `job_id`, `queued_at`, `heartbeat_at`, `total_steps`, `completed_steps`, `last_checkpoint`, and `last_error` to `va_restore`. Expose guarded store operations for queue claim, heartbeat, progress, failure, and terminal completion.

- [ ] **Step 3: Add the queue module and manifest consumer**

```js
import { Queue } from '@forge/events';

const restoreQueue = new Queue({ key: 'va-restore-queue' });
export function enqueueRestore(body) {
  return restoreQueue.push({
    body,
    concurrency: { key: `restore:${body.issueId}`, limit: 1 }
  });
}
```

```yaml
consumer:
  - key: va-restore-consumer
    queue: va-restore-queue
    function: restore-worker
function:
  - key: restore-worker
    handler: jobs/restoreWorker.handler
    timeoutSeconds: 600
```

- [ ] **Step 4: Return quickly after durable rejection**

The resolver authenticates, rechecks/binds evidence, acquires `RESTORING`, persists the restore and deterministic action plan, enqueues continuation, and returns `{ state: 'RESTORING', restoreId, progress }`. It may execute a small bounded first batch only if the remaining invocation budget is explicitly known; do not use a browser-held 20-second race as the coordinator.

- [ ] **Step 5: Implement at-least-once-safe consumer behavior**

The worker loads restore/approval/latest baseline, rejects stale or terminal work, heartbeats, processes a bounded count of unfinished actions, saves progress, and either enqueues the next continuation or performs fresh full verification. Platform retries and duplicate deliveries converge through `va_restore_action` claims and per-issue queue concurrency.

- [ ] **Step 6: Expose recovery without minting another signature**

`restore:getState` returns progress and last actionable failure. `restore:retry` verifies the caller owns the original approval and still holds the baseline role, checks the durable candidate-to-baseline resume invariant, and only re-enqueues the same restore id.

- [ ] **Step 7: Run worker, manifest, and restore tests**

Run: `node --test test/restore-worker.test.js test/restore-resume.test.js test/restore-correctness.test.js test/manifest-lint.test.js test/resolver-wiring.test.js test/migrations.test.js`

Run: `forge lint`

- [ ] **Step 8: Commit only Task 9 hunks**

```bash
git add -p src/db/migrations.js src/db/restoreStore.js src/lib/restore/queue.js src/jobs/restoreWorker.js src/usecases/restoreActions.js src/usecases/restore.js src/resolvers/panel.js manifest.yml test/migrations.test.js test/restore-worker.test.js test/restore-resume.test.js test/manifest-lint.test.js test/resolver-wiring.test.js
git diff --cached --check
git commit -m "feat: continue restoration in Forge queue"
```

---

### Task 10: Adversarial verification, performance evidence, and live Jira acceptance

**Files:**

- Modify: `test/controlled-transition-tree-acceptance.test.js`
- Modify: `test/drift-functional.test.js`
- Modify: `test/journey.test.js`
- Modify: `frontend/test/panel.test.mjs`
- Create: `docs/acceptance/2026-09-13-controlled-transition-demo.md`

- [ ] **Step 1: Add the connected adversarial matrix**

Cover same-destination sibling transitions, global versus directed edges, two simultaneous holders of one role, double-clicks, stale challenges, later baselines, policy edits, provider substitution, failed audit write, failed N+1 persistence, validator denial, duplicate Jira events, duplicate queue events, worker crash after each action kind, deleted-node replacement, unsupported fields, permission denial, and wrong-status read-back.

- [ ] **Step 2: Run fresh complete local verification**

Run: `npm run verify`

Run: `npm --prefix frontend run lint`

Run: `forge lint`

Run: `git diff --check`

Run: `git status --short`

Expected: every command exits 0. Record exact test counts and any unrelated dirty files; do not call existing changes clean.

- [ ] **Step 3: Review security and UX before deployment**

Review the completed branch, resolve the findings, and rerun all affected tests. Inspect transition screen, panel, My Approvals, admin picker, drift evidence, and restore progress at narrow and wide Jira panel sizes. Verify keyboard order, accessible names, focus after errors, and no layout hides an eligible action.

- [ ] **Step 4: Confirm deployment target before external mutation**

Run read-only Forge identity/environment/install checks. Confirm the manifest app id, intended environment, site, product, installed version, and pending SQL migrations. Stop and ask before deploying or installing if any target is ambiguous.

- [ ] **Step 5: Deploy and migrate only after target confirmation**

Run the repository deployment path, apply migrations through the admin authority flow, and verify the deployed version/install state. Record deployment, migration, and installation as independent results.

- [ ] **Step 6: Execute the live acceptance matrix**

Use dedicated Jira issues and record each result in `docs/acceptance/2026-09-13-controlled-transition-demo.md`:

1. E-signature with and without baseline capture from transition screen, panel, and My Approvals.
2. Biometric with and without baseline capture from supported surfaces.
3. Sibling same-destination edges plus `Any status`, proving the chosen rule's controls.
4. Drift recall to the latest baseline's source status.
5. Approve drift: N+1 first, then exact destination, then controls disappear across open surfaces.
6. Reject drift: all controlled fields/tree edges restored and root remains in review after fresh read-back.
7. Partial restore, background continuation, and retry without a new signature.
8. Two holders racing the same role.
9. Detached validator, missing role holder, provider refusal, stale evidence, audit failure, and another Jira validator denial.
10. Warm/cold `panel:getSummary` timings and sub-100 ms visible button feedback.

- [ ] **Step 7: Commit acceptance evidence without secrets**

```bash
git add -p test/controlled-transition-tree-acceptance.test.js test/drift-functional.test.js test/journey.test.js frontend/test/panel.test.mjs docs/acceptance/2026-09-13-controlled-transition-demo.md
git diff --cached --check
git commit -m "test: prove controlled transition demo journeys"
```

Do not commit TOTP values, WebAuthn assertions, tenant tokens, private account identifiers, raw exported evidence, browser profiles, screenshots containing personal data, or scratch/debug output.

## Completion gate

Implementation is complete only when all of the following are separately true:

- the full local backend, frontend, smoke, build, lint, Forge manifest, and formatting checks pass;
- the code review has no unresolved correctness or security findings;
- the intended Forge app/environment/site installation and SQL migration state are confirmed;
- both configured authentication providers pass live Jira journeys;
- latest-baseline recall, drift approve N+1, exact Jira transition, rejection restoration, and fresh read-back pass live;
- all three surfaces converge after state changes without fixed polling;
- warm/cold summary timing evidence is recorded; and
- the final report distinguishes verified local, deployed, installed, migrated, and live-accepted results.
