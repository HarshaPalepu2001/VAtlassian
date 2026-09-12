# Controlled Transition and Recursive Tree Baseline Implementation Plan

**Goal:** Route every controlled transition to its exact configured authentication provider and make baseline, drift, rejection, and read-back verification operate over the root issue's complete native Jira descendant tree.

**Architecture:** Keep the existing `va_approval` lifecycle and provider registry, but bind every call to Jira's exact transition id and require the configured provider rather than inferring one from client payload. Extend the root baseline into a versioned aggregate with node/value rows, use one stable Jira tree reader for capture, drift, and verification, and journal destructive restore steps so retries are idempotent.

**Tech Stack:** Atlassian Forge Node.js 22, Jira Cloud REST API v3, Forge SQL/MySQL, React 18, Atlaskit, UI Kit, SimpleWebAuthn, Node test runner, TypeScript, Vite.

**Spec:** `docs/specs/2026-09-12-controlled-transition-tree-baseline-design.md`

## Global Constraints

- Preserve the existing dirty worktree. Inspect each target file before editing and stage only task-owned hunks; never sweep unrelated files into a commit.
- Do not add AI, co-author, or generated-with attribution to commits.
- A controlled transition executes exactly its explicitly configured provider: `ESIGNATURE` uses TOTP and `BIOMETRIC` uses WebAuthn. There is no provider substitution or implicit default.
- `issueTransition.id` is mandatory on transition-screen signing and is rechecked by the validator.
- `capture_baseline` and `block_on_drift` are independent flags on the exact controlled transition.
- With no active complete baseline, drift is zero and no tree observation is persisted.
- A tree baseline includes at most 500 nodes and every active controlled field for every node, including explicit null and empty values.
- Every restorable controlled field must retain its raw value. Incomplete or non-restorable capture fails closed and never becomes active.
- Added descendants are permanently deleted only after proving they were absent from the baseline. Existing baseline nodes are never deleted by that rule.
- `COMPLETE` and `COMPLETE_WITH_REPLACEMENTS` require a fresh full-tree Jira read-back. Any unmatched node, edge, or field remains non-complete.
- Comments, worklogs, attachments, external assets, and immutable Jira identity/history remain outside the restore contract.
- Local verification, Forge deployment, installation/migration, and live Jira acceptance are separate checkpoints and must be reported separately.

---

### Task 1: Bind policy lookup to the exact Jira transition

**Files:**
- Modify: `src/db/configStore.js`
- Modify: `src/usecases/transitionsValidation.js`
- Modify: `src/usecases/adminAlerts.js`
- Modify: `src/lib/approval/runtime.js`
- Modify: `src/usecases/signing.js`
- Modify: `src/usecases/panel.js`
- Modify: `src/usecases/panelAccess.js`
- Modify: `src/usecases/queue.js`
- Modify: `src/db/approvalStore.js`
- Modify: `src/gate.js`
- Test: `test/signing-context.test.js`
- Test: `test/gate-approval.test.js`
- Test: `test/admin-configuration.test.js`
- Create: `test/admin-health.test.js`
- Create: `test/transition-policy.test.js`

**Interfaces:**
- Produces: `gatedTransition({ projectId, issueTypeId, fromStatusId, toStatusId, transitionId })` with exact-id matching and `transition_id` in its result.
- Produces: `pendingApprovalFor({ issueId, fromStatusId, toStatusId, transitionId, now, approvalId })`.
- Consumes: Jira transition objects shaped as `{ id, toStatusId, toStatusName, name }`.

- [ ] **Step 1: Write failing exact-edge tests**

```js
test('two transitions to the same status resolve by transition id', async () => {
  const exact = await gatedTransition({
    projectId: 1, issueTypeId: '10001', fromStatusId: '3',
    toStatusId: '5', transitionId: '102'
  });
  assert.equal(exact.transition_id, '102');
  assert.equal(exact.required_assurance, 'BIOMETRIC');
});

test('transition screen refuses a missing exact transition id', async () => {
  const result = await createSigningUsecases(fixture().deps).signingContext({
    payload: { surface: 'device-field' }, context: { accountId: 'actor-1' }
  });
  assert.equal(result.reason, 'TRANSITION_ID_REQUIRED');
});

test('validator cannot consume a receipt signed for a sibling transition', async () => {
  const f = await fixture('BIOMETRIC');
  f.payload.transition.id = '103';
  f.row.transition_id = '102';
  assert.equal((await createGate(f.deps)(f.payload)).result, false);
});

test('controlled transition configuration requires an exact Jira transition id', async () => {
  const result = await createControlledTransition(request({ transitionId: null }), fixture().deps);
  assert.equal(result.success, false);
});
```

- [ ] **Step 2: Run the focused tests and verify the new assertions fail**

Run: `node --test test/signing-context.test.js test/gate-approval.test.js test/transition-policy.test.js`

Expected: failures show that policy and pending approval lookups currently use only status pairs and signing context currently accepts a missing exact transition id.

- [ ] **Step 3: Implement exact transition selection everywhere**

```js
export async function gatedTransition({ projectId, issueTypeId, fromStatusId, toStatusId, transitionId }) {
  if (transitionId == null) return null;
  const rows = await throwing(`SELECT TO_BASE64(ct_id) AS ct_id, issue_type_id,
      from_status_id, to_status_id, transition_id, required_role, meaning,
      require_decision, block_on_drift, required_assurance, capture_baseline
    FROM va_controlled_transition
    WHERE project_id = ?
      AND (issue_type_id = ? OR issue_type_id = '*')
      AND (from_status_id = ? OR from_status_id = '*')
      AND (to_status_id = ? OR to_status_id = '*')
      AND transition_id = ? AND state = ?
    ORDER BY issue_type_id DESC, from_status_id DESC, to_status_id DESC LIMIT 1`,
    [projectId, issueTypeId, fromStatusId, toStatusId, String(transitionId), 'ACTIVE']);
  return rows[0] ? decodeControlledTransition(rows[0]) : null;
}
```

Pass `transition.id` from panel, queue, signing context, approval runtime, and gate runtime. In `createGate`, require `payload.transition.id`, pass it to `deps.load`, and compare it to `approval.transition_id` before consuming the approval. Transition-screen surfaces resolve only the one requested transition. Require a numeric transition id when controlled transitions are created or edited, and expose pre-existing active rows without one as a blocking configuration-health error rather than guessing an edge.

- [ ] **Step 4: Run exact-edge tests and the approval regression group**

Run: `node --test test/signing-context.test.js test/gate-approval.test.js test/approval-submit.test.js test/queue.test.js test/panel-state.test.js test/transition-policy.test.js test/admin-configuration.test.js test/admin-health.test.js`

Expected: all pass; a sibling edge with the same destination cannot borrow a policy or receipt.

- [ ] **Step 5: Commit only Task 1 hunks**

```bash
git add -p src/db/configStore.js src/usecases/transitionsValidation.js src/usecases/adminAlerts.js src/lib/approval/runtime.js src/usecases/signing.js src/usecases/panel.js src/usecases/panelAccess.js src/usecases/queue.js src/db/approvalStore.js src/gate.js test/signing-context.test.js test/gate-approval.test.js test/transition-policy.test.js test/admin-configuration.test.js test/admin-health.test.js
git diff --cached --check
git commit -m "fix: bind approvals to exact transitions"
```

### Task 2: Make the configured provider the only provider invoked

**Files:**
- Modify: `src/usecases/approval.js`
- Modify: `src/lib/approval/challenge.js`
- Modify: `src/lib/approval/record.js`
- Modify: `src/lib/approval/runtime.js`
- Modify: `src/lib/errors.js`
- Modify: `src/usecases/transitionsValidation.js`
- Modify: `frontend/src/lib/assurance.ts`
- Modify: `frontend/src/admin/pages/TransitionsPage.tsx`
- Test: `test/approval-submit.test.js`
- Test: `test/approval-assurance.test.js`
- Test: `test/gate-approval.test.js`
- Test: `test/admin-configuration.test.js`

**Interfaces:**
- Produces: `providerInput(required, payload)` returning only evidence accepted by the configured provider.
- Produces: approval bindings containing `transitionId` in addition to issue, actor, statuses, content hash, and decision.
- Consumes: `controlledAuthenticationMethod(policy.required_assurance)` and `providerFor(required)`.

- [ ] **Step 1: Write failing provider-dispatch tests**

```js
test('biometric policy refuses an injected TOTP code', async () => {
  const f = fixture({ requiredAssurance: 'BIOMETRIC' });
  const result = await f.submit({ code: '123456', webauthn: f.assertion });
  assert.equal(f.providers.called, undefined);
  assert.equal(result.reason, 'WRONG_AUTHENTICATION_METHOD');
});

test('electronic policy refuses WebAuthn substitution', async () => {
  const f = fixture({ requiredAssurance: 'ESIGNATURE' });
  const result = await f.submit({ webauthn: f.assertion });
  assert.equal(result.reason, 'WRONG_AUTHENTICATION_METHOD');
});

test('controlled transitions refuse implicit or weaker authentication modes', async () => {
  for (const requiredAssurance of [undefined, 'NATIVE_TRANSITION', 'JSM_APPROVAL']) {
    const result = await createControlledTransition(request({ requiredAssurance }), fixture().deps);
    assert.equal(result.success, false);
  }
});
```

- [ ] **Step 2: Run the provider tests and confirm the inference bug fails them**

Run: `node --test test/approval-submit.test.js test/approval-assurance.test.js test/gate-approval.test.js`

Expected: the biometric-with-code case selects or attempts electronic signature instead of rejecting the mismatched payload before provider execution.

- [ ] **Step 3: Dispatch by policy and bind the exact transition**

```js
function providerInput(required, payload) {
  if (required === 'BIOMETRIC') {
    if (payload.code != null) fail('WRONG_AUTHENTICATION_METHOD');
    return { webauthn: payload.webauthn };
  }
  if (payload.webauthn != null) fail('WRONG_AUTHENTICATION_METHOD');
  return { code: payload.code };
}

const required = controlledAuthenticationMethod(ct.required_assurance);
const proof = await providerFor(required).verify({
  binding: { ...binding, transitionId: transition?.id ?? null },
  confirmed: payload.confirmed,
  ...providerInput(required, payload),
  totpDeps: deps.totpDeps,
  webauthnDeps: deps.webauthnDeps,
  context
});
if (!proof.ok || proof.level !== required) fail(proof.reason ?? 'INSUFFICIENT_ASSURANCE');
```

`controlledAuthenticationMethod` accepts only the explicit values `ESIGNATURE` and `BIOMETRIC`; it has no default and no assurance-floor conversion. Limit the controlled-transition admin selector to those two values and require an explicit choice. Include `transitionId` in provider evidence and `challengeContextHash`. Keep existing challenge expiry, single-use WebAuthn challenge, TOTP attempt limits, approval CAS, and audit behavior unchanged.

- [ ] **Step 4: Run provider, WebAuthn, TOTP, and validator tests**

Run: `node --test test/approval-submit.test.js test/approval-assurance.test.js test/totp-approval.test.js test/webauthn.test.js test/gate-approval.test.js test/admin-configuration.test.js`

Expected: all pass and neither evidence type can satisfy the other transition method.

- [ ] **Step 5: Commit only Task 2 hunks**

```bash
git add -p src/usecases/approval.js src/lib/approval/challenge.js src/lib/approval/record.js src/lib/approval/runtime.js src/lib/errors.js src/usecases/transitionsValidation.js frontend/src/lib/assurance.ts frontend/src/admin/pages/TransitionsPage.tsx test/approval-submit.test.js test/approval-assurance.test.js test/gate-approval.test.js test/admin-configuration.test.js
git diff --cached --check
git commit -m "fix: dispatch configured authentication provider"
```

### Task 3: Carry exact transition and conditional consequences through all screens

**Files:**
- Modify: `src/ui-kit/edit.jsx`
- Modify: `frontend/src/field/ApprovalField.tsx`
- Modify: `frontend/src/panel/sections/ApprovalControls.tsx`
- Modify: `frontend/src/panel/approvalModel.ts`
- Modify: `frontend/src/panel/types.ts`
- Modify: `src/usecases/signing.js`
- Modify: `src/usecases/panelAccess.js`
- Test: `frontend/test/panel.test.mjs`
- Test: `test/signing-context.test.js`

**Interfaces:**
- Produces: transition action `{ transitionId, requiredAssurance, capturesBaseline, blocksOnDrift, meaning, requiredRole }`.
- Produces: a verified non-empty actor `displayName` from Jira `/myself`.
- Consumes: `context.extension.issueTransition.id` from both transition-screen implementations.

- [ ] **Step 1: Add failing screen-contract tests**

```js
test('transition field sends Jira issueTransition.id to signing context', async () => {
  await renderField({ extension: { issue: { key: 'T-1' }, issueTransition: { id: '102' } } });
  const call = calls.find(([key]) => key === 'signing:context');
  assert.equal(call[1].transitionId, '102');
});

test('non-capturing approval never promises a baseline', async () => {
  await renderPanel(stateWith({ capturesBaseline: false }));
  assert.doesNotMatch(container.textContent, /baseline will be captured/i);
});
```

- [ ] **Step 2: Run frontend and signing-context tests and observe failures**

Run: `npm --prefix frontend test && node --test test/signing-context.test.js`

Expected: fields omit `issueTransition.id`, and the panel always promises baseline capture.

- [ ] **Step 3: Implement the shared screen contract**

```tsx
const transitionId = context?.extension?.issueTransition?.id;
invoke('signing:context', {
  issueKey: contextKey,
  issueId: contextId,
  transitionId,
  surface: 'device-field'
});

const consequence = decline
  ? 'The governed issue tree will be returned to its approved content.'
  : transition?.capturesBaseline
    ? 'A recursive baseline will be captured from the approved issue tree.'
    : 'This transition records the approval without replacing the active baseline.';
```

Apply the equivalent payload and conditional copy in UI Kit. Remove field-level transition selection. Resolve `/myself` once in the shared panel loader so issue panel, My Approvals, UI Kit context, and Custom UI context receive the same printed actor name.

- [ ] **Step 4: Run frontend tests, TypeScript, and UI Kit source checks**

Run: `npm --prefix frontend test && npm --prefix frontend run build && node --test test/signing-context.test.js test/manifest-lint.test.js`

Expected: all pass; each field sends one exact transition id and consequence text follows `capturesBaseline`.

- [ ] **Step 5: Commit only Task 3 hunks**

```bash
git add -p src/ui-kit/edit.jsx frontend/src/field/ApprovalField.tsx frontend/src/panel/sections/ApprovalControls.tsx frontend/src/panel/approvalModel.ts frontend/src/panel/types.ts src/usecases/signing.js src/usecases/panelAccess.js frontend/test/panel.test.mjs test/signing-context.test.js
git diff --cached --check
git commit -m "fix: align approval surfaces with transition policy"
```

### Task 4: Add durable aggregate-tree storage

**Files:**
- Modify: `src/db/migrations.js`
- Create: `src/db/baselineTreeStore.js`
- Create: `src/db/treeDriftStore.js`
- Create: `src/db/restoreTreeStore.js`
- Modify: `src/db/baselineStore.js`
- Modify: `src/db/restoreStore.js`
- Test: `test/tree-storage.test.js`
- Create: `test/migrations.test.js`

**Interfaces:**
- Produces: `writeTreeCapture`, `readBaselineTree`, `activeRootsForNode`, `replaceTreeDrift`, `readTreeDrift`, `claimRestoreStep`, `finishRestoreStep`, and `recordReplacement`.
- Consumes: existing binary `baseline_id`, `restore_id`, chunked value encoding, and Forge SQL one-statement-per-call behavior.

- [ ] **Step 1: Write failing migration and store-query tests**

```js
test('tree values are keyed by baseline and logical node', () => {
  assert.match(sqlFor('v033_baseline_node_value'),
    /PRIMARY KEY \(baseline_id, logical_node_id, field_id, seq\)/);
});

test('activeRootsForNode returns only complete active baselines', async () => {
  const roots = await activeRootsForNode(20002);
  assert.deepEqual(roots, [{ baselineId, rootIssueId: 10001, rootIssueKey: 'FEAT-1' }]);
});
```

- [ ] **Step 2: Run storage tests and verify missing tables/functions fail**

Run: `node --test test/tree-storage.test.js test/migrations.test.js`

Expected: imports or migration-id assertions fail because aggregate tree storage does not exist.

- [ ] **Step 3: Add migrations and focused stores**

```sql
ALTER TABLE va_baseline
  ADD COLUMN tree_hash CHAR(64) NULL,
  ADD COLUMN tree_schema_version INT NOT NULL DEFAULT 1,
  ADD COLUMN node_count INT NOT NULL DEFAULT 1,
  ADD COLUMN edge_count INT NOT NULL DEFAULT 0,
  ADD COLUMN total_field_count INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS va_baseline_node (
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
);
```

`v031_workflow_snapshot` remains reserved by the preceding workflow design. Allocate tree migrations as `v032_baseline_tree_meta`, `v033_baseline_node`, `v034_baseline_node_value`, `v035_tree_drift`, `v036_restore_step`, and `v037_restore_replacement`. Store values with existing `encodeValue` and `decodeValue` chunks.

- [ ] **Step 4: Run storage tests and baseline storage regressions**

Run: `node --test test/tree-storage.test.js test/migrations.test.js test/baseline-storage.test.js test/baseline-capture-lifecycle.test.js`

Expected: all pass and legacy single-node baselines remain readable as schema version 1.

- [ ] **Step 5: Commit Task 4 files**

```bash
git add src/db/migrations.js src/db/baselineTreeStore.js src/db/treeDriftStore.js src/db/restoreTreeStore.js src/db/baselineStore.js src/db/restoreStore.js test/tree-storage.test.js test/migrations.test.js
git diff --cached --check
git commit -m "feat: store recursive baseline trees"
```

### Task 5: Build pure tree canonicalization, completeness, and drift rules

**Files:**
- Create: `src/lib/tree/model.js`
- Create: `src/lib/tree/capturePlan.js`
- Create: `src/lib/tree/diff.js`
- Test: `test/tree-model.test.js`
- Test: `test/tree-diff.test.js`

**Interfaces:**
- Produces: `TREE_LIMIT = 500`.
- Produces: `logicalNodeId(originalIssueId)`, `planTreeCapture({ rootIssueId, nodes, controlledFields })`, and `diffTree({ baselineTree, currentTree, controlledFields })`.
- Consumes: `project(issue.fields, controlledFields)` for the one canonical field digest definition.

- [ ] **Step 1: Write failing pure tests for a multi-level 16-field tree**

```js
test('capture plan covers all 16 fields on every recursive node', () => {
  const plan = planTreeCapture({
    rootIssueId: 1, nodes: threeLevelTree(), controlledFields: sixteenFields()
  });
  assert.equal(plan.nodeCount, 3);
  assert.equal(plan.edgeCount, 2);
  assert.equal(plan.totalFieldCount, 48);
  assert.equal(plan.nodes.every(node => Object.keys(node.digests).length === 16), true);
});

test('tree diff separates every drift category', () => {
  assert.deepEqual(diffTree(treeDiffFixture()).changes.map(change => change.kind).sort(),
    ['FIELD_CHANGED', 'NODE_ADDED', 'NODE_MOVED', 'NODE_REMOVED']);
});
```

- [ ] **Step 2: Run pure tests and verify missing modules fail**

Run: `node --test test/tree-model.test.js test/tree-diff.test.js`

Expected: module-not-found failure.

- [ ] **Step 3: Implement deterministic aggregate rules**

```js
export const TREE_LIMIT = 500;
export const logicalNodeId = issueId => sha256Hex(canonical({ originalIssueId: String(issueId) }));

export function planTreeCapture({ rootIssueId, nodes, controlledFields }) {
  if (!nodes.length || nodes.length > TREE_LIMIT) throw new FailClosed('TREE_LIMIT_EXCEEDED');
  const planned = nodes.map(node => {
    const projection = project(node.fields, controlledFields);
    if (Object.keys(projection.raw).length !== controlledFields.length) {
      throw new FailClosed('BASELINE_VALUES_REQUIRED');
    }
    return { ...node, logicalNodeId: logicalNodeId(node.id), ...projection };
  }).sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return aggregateTree(String(rootIssueId), planned, controlledFields.length);
}
```

Canonicalize membership and parent edges by logical node id, not traversal order. Preserve explicit null and empty values. Reject duplicate nodes, cycles, missing parents inside the subtree, incomplete field sets, and unknown field kinds.

- [ ] **Step 4: Run pure tree and existing content tests**

Run: `node --test test/tree-model.test.js test/tree-diff.test.js test/baseline-content.test.js test/baseline-diff.test.js test/baseline-integrity-regression.test.js`

Expected: all pass with deterministic hashes under shuffled node and field order.

- [ ] **Step 5: Commit Task 5 files**

```bash
git add src/lib/tree/model.js src/lib/tree/capturePlan.js src/lib/tree/diff.js test/tree-model.test.js test/tree-diff.test.js
git diff --cached --check
git commit -m "feat: model governed issue trees"
```

### Task 6: Read a stable recursive Jira tree

**Files:**
- Create: `src/lib/tree/jira.js`
- Create: `src/lib/tree/stableRead.js`
- Test: `test/tree-jira.test.js`
- Test: `test/tree-stable-read.test.js`

**Interfaces:**
- Produces: `createTreeReader({ api, route }).read(rootIssueKey, fieldIds)`.
- Produces: `readStableTree({ readTree, rootIssueKey, fieldIds, maxAttempts = 3 })`.
- Consumes: Jira `POST /rest/api/3/search/jql`, `GET /rest/api/3/issue/{key}`, and native `parent` values.

- [ ] **Step 1: Write failing Jira-adapter and race tests**

```js
test('reader walks every parent level and stops at 500 nodes', async () => {
  const tree = await reader.read('FEAT-1', sixteenFieldIds());
  assert.deepEqual(tree.nodes.map(node => node.key), ['FEAT-1', 'STORY-1', 'SUB-1']);
});

test('stable read retries when a child is added between reads', async () => {
  const result = await readStableTree({
    readTree: changingReader(), rootIssueKey: 'FEAT-1', fieldIds: sixteenFieldIds()
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.tree.nodes.length, 3);
});
```

- [ ] **Step 2: Run adapter tests and verify missing modules fail**

Run: `node --test test/tree-jira.test.js test/tree-stable-read.test.js`

Expected: module-not-found failure.

- [ ] **Step 3: Implement breadth-first traversal and stability comparison**

```js
export async function readStableTree({ readTree, rootIssueKey, fieldIds, maxAttempts = 3 }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const first = await readTree(rootIssueKey, fieldIds);
    const second = await readTree(rootIssueKey, ['parent']);
    if (relationshipHash(first) === relationshipHash(second)) return { tree: first, attempts: attempt };
  }
  throw new FailClosed('TREE_CHANGED_DURING_CAPTURE');
}
```

Page JQL child searches, escape issue keys, de-duplicate by issue id, reject cycles, and fail when Jira hides or omits a requested node or field. Make the request client injectable so tests never need Forge or network access.

- [ ] **Step 4: Run tree-reader tests and module import smoke**

Run: `node --test test/tree-jira.test.js test/tree-stable-read.test.js && npm run smoke`

Expected: all pass; unstable trees fail closed after three attempts.

- [ ] **Step 5: Commit Task 6 files**

```bash
git add src/lib/tree/jira.js src/lib/tree/stableRead.js test/tree-jira.test.js test/tree-stable-read.test.js
git diff --cached --check
git commit -m "feat: read stable Jira issue trees"
```

### Task 7: Capture and sign one complete tree baseline

**Files:**
- Modify: `src/lib/capture.js`
- Modify: `src/lib/baseline.js`
- Modify: `src/usecases/drift.js`
- Modify: `src/usecases/panelAccess.js`
- Modify: `src/lib/approval/challenge.js`
- Modify: `src/usecases/fieldsConfiguration.js`
- Modify: `src/usecases/fieldsValidation.js`
- Modify: `frontend/src/admin/pages/FieldsPage.tsx`
- Test: `test/tree-capture.test.js`
- Test: `test/baseline-capture-lifecycle.test.js`
- Test: `test/approval-submit.test.js`
- Test: `test/admin-configuration.test.js`

**Interfaces:**
- Produces: `writeCapturedTreeBaseline({ rootIssue, policy, approval, controlledFields, transitionAt })`.
- Produces: prepared approval `{ contentHash: treeHash, tree, treeDiff, evidenceHash }` whenever capture or an active tree baseline applies.
- Consumes: `readStableTree`, `planTreeCapture`, and `writeTreeCapture`.

- [ ] **Step 1: Write failing aggregate capture and retention tests**

```js
test('capture publishes only after every node and field is durable', async () => {
  const result = await writeCapturedTreeBaseline(threeNodeFixture());
  assert.equal(result.captured, true);
  assert.equal(result.nodeCount, 3);
  assert.equal(result.fieldCount, 48);
  assert.deepEqual(calls.slice(-2), ['verify-tree', 'publish-active']);
});

test('one unretained controlled field refuses the whole baseline', async () => {
  const result = await writeCapturedTreeBaseline(fixtureWithUnretainedField());
  assert.equal(result.reason, 'BASELINE_VALUES_REQUIRED');
  assert.equal(calls.includes('publish-active'), false);
});
```

- [ ] **Step 2: Run capture tests and verify root-only behavior fails them**

Run: `node --test test/tree-capture.test.js test/baseline-capture-lifecycle.test.js test/approval-submit.test.js test/admin-configuration.test.js`

Expected: capture reports one node/root field count and permits missing retained values.

- [ ] **Step 3: Integrate stable tree capture and tree-bound evidence**

```js
const stable = await readStableTree({
  readTree, rootIssueKey: issue.key, fieldIds: fields.map(field => field.field_id)
});
const treePlan = planTreeCapture({
  rootIssueId: issue.id, nodes: stable.tree.nodes, controlledFields: fields
});
if (treePlan.treeHash !== approval.content_hash) fail('CONTENT_CHANGED');
const stored = await writeTreeCapture({ baseline, treePlan });
await publishTreeBaseline({
  baselineId: stored.baselineId,
  expectedNodes: treePlan.nodeCount,
  expectedFields: treePlan.totalFieldCount,
  treeHash: treePlan.treeHash
});
```

Keep schema-version-1 reads for historical baselines. For new capture-baseline policies, reject disabled retention at admin save time and capture time; do not silently enable storage. Include the tree hash and counts in baseline audit events.

- [ ] **Step 4: Run capture, approval, admin, and legacy baseline tests**

Run: `node --test test/tree-capture.test.js test/baseline-capture-lifecycle.test.js test/baseline-baseline.test.js test/approval-submit.test.js test/admin-configuration.test.js test/baseline-storage.test.js`

Expected: all pass; a three-node, 16-field baseline publishes 48 retained field values or publishes nothing.

- [ ] **Step 5: Commit only Task 7 hunks**

```bash
git add -p src/lib/capture.js src/lib/baseline.js src/usecases/drift.js src/usecases/panelAccess.js src/lib/approval/challenge.js src/usecases/fieldsConfiguration.js src/usecases/fieldsValidation.js frontend/src/admin/pages/FieldsPage.tsx test/tree-capture.test.js test/baseline-capture-lifecycle.test.js test/approval-submit.test.js test/admin-configuration.test.js
git diff --cached --check
git commit -m "feat: capture complete recursive baselines"
```

### Task 8: Fan child events into aggregate drift detection

**Files:**
- Modify: `manifest.yml`
- Create: `src/triggers/issue-created.js`
- Modify: `src/triggers/issue-updated.js`
- Modify: `src/triggers/issue-deleted.js`
- Modify: `src/triggers/runtime.js`
- Modify: `src/lib/collect.js`
- Modify: `src/jobs/reconcile.js`
- Modify: `src/db/itemStateStore.js`
- Modify: `src/db/baselineTreeStore.js`
- Modify: `src/db/treeDriftStore.js`
- Test: `test/tree-trigger-fanout.test.js`
- Test: `test/tree-drift-functional.test.js`
- Test: `test/baseline-trigger-retry.test.js`
- Test: `test/jobs-runner.test.js`
- Test: `test/manifest-lint.test.js`

**Interfaces:**
- Produces: `affectedTreeRoots({ issueId, issueKey, eventType })` returning every active governed root affected by a node event.
- Produces: `collectTree({ rootIssueId, rootIssueKey, detectedVia, actorAccountId, eventId, eventAt, now })`.
- Consumes: the same `readStableTree` and `diffTree` definitions used by approval capture and restore verification.

- [ ] **Step 1: Write failing event fan-out and aggregate-drift tests**

```js
test('a grandchild update wakes its active governed root', async () => {
  const result = await runUpdated(grandchildEvent(), fixture().deps);
  assert.deepEqual(fixture().collectCalls, [{ rootIssueId: 1, rootIssueKey: 'FEAT-1' }]);
  assert.equal(result.outcome, 'DRIFT_RECORDED');
});

test('deleting a baseline child records NODE_REMOVED on the root', async () => {
  await runDeleted(deletedStoryEvent(), fixture().deps);
  assert.deepEqual(fixture().driftKinds, ['NODE_REMOVED']);
});

test('creating a new descendant records NODE_ADDED on the root', async () => {
  await runCreated(createdSubtaskEvent(), fixture().deps);
  assert.deepEqual(fixture().driftKinds, ['NODE_ADDED']);
});
```

- [ ] **Step 2: Run trigger and drift tests and confirm root-only collection fails**

Run: `node --test test/tree-trigger-fanout.test.js test/tree-drift-functional.test.js test/baseline-trigger-retry.test.js test/jobs-runner.test.js test/manifest-lint.test.js`

Expected: child events either collect the child as a root, return `NO_BASELINE`, or are not subscribed for creation.

- [ ] **Step 3: Implement event fan-out and one aggregate collector**

```js
export async function affectedTreeRoots({ issueId, issueKey, parentIssueId }) {
  const indexed = await activeRootsForNode(Number(issueId));
  if (indexed.length) return indexed;
  return discoverActiveRootsByAncestor
    ? discoverActiveRootsByAncestor({ issueId, issueKey, parentIssueId })
    : [];
}

export async function collectAffectedTrees(event, deps) {
  const roots = await deps.affectedTreeRoots(eventIdentity(event));
  return Promise.all(roots.map(root => deps.collectTree({
    rootIssueId: root.rootIssueId,
    rootIssueKey: root.rootIssueKey,
    detectedVia: DETECTED_VIA.EVENT,
    eventId: event?.eventId ?? event?.id ?? '',
    eventAt: eventTime(event),
    now: Date.now()
  })));
}
```

Add `avi:jira:created:issue` plus its function entry to `manifest.yml`. Treat event payloads as wake-ups only. For deletion, use the baseline node index before archiving the item. For a newly created child not yet indexed, walk the current native parent chain until an active governed root is found. Replace the root's drift set transactionally from the aggregate diff; do not append a second root-only interpretation.

Extend scheduled reconciliation to enumerate active tree roots, not every indexed descendant, and run the same aggregate collector. If a root has no active complete baseline, return `NO_BASELINE` without persisting observations or drift.

- [ ] **Step 4: Run trigger, drift, reconciliation, and retry tests**

Run: `node --test test/tree-trigger-fanout.test.js test/tree-drift-functional.test.js test/baseline-trigger-retry.test.js test/jobs-runner.test.js test/manifest-lint.test.js test/drift-functional.test.js test/signature-gate-drift.test.js`

Expected: all pass; repeated and out-of-order events converge to the same one aggregate drift set.

- [ ] **Step 5: Commit only Task 8 hunks**

```bash
git add -p manifest.yml src/triggers/issue-created.js src/triggers/issue-updated.js src/triggers/issue-deleted.js src/triggers/runtime.js src/lib/collect.js src/jobs/reconcile.js src/db/itemStateStore.js src/db/baselineTreeStore.js src/db/treeDriftStore.js test/tree-trigger-fanout.test.js test/tree-drift-functional.test.js test/baseline-trigger-retry.test.js test/jobs-runner.test.js test/manifest-lint.test.js
git diff --cached --check
git commit -m "feat: detect recursive tree drift"
```

### Task 9: Restore content, membership, and parent edges with resumable destructive steps

**Files:**
- Create: `src/lib/tree/restorePlan.js`
- Create: `src/lib/tree/restoreExecutor.js`
- Create: `src/lib/tree/restoreVerifier.js`
- Modify: `src/usecases/restoreActions.js`
- Modify: `src/usecases/restore.js`
- Modify: `src/lib/restore/outcome.js`
- Modify: `src/lib/restore/resume.js`
- Modify: `src/db/restoreStore.js`
- Modify: `src/db/restoreTreeStore.js`
- Modify: `src/db/itemStateStore.js`
- Modify: `src/db/driftStore.js`
- Modify: `src/lib/ledger.js`
- Test: `test/tree-restore-plan.test.js`
- Test: `test/tree-restore-execution.test.js`
- Test: `test/tree-restore-verification.test.js`
- Test: `test/restore-resume.test.js`
- Test: `test/restore-correctness.test.js`
- Test: `test/signature-ledger.test.js`

**Interfaces:**
- Produces: ordered restore steps `RESTORE_FIELDS`, `MOVE_NODE`, `CREATE_REPLACEMENT`, and `DELETE_ADDED_NODE`.
- Produces: `executeTreeRestore({ restoreId, rootIssueKey, baselineTree, currentTree, controlledFields })` with durable per-step claims.
- Produces: terminal states `COMPLETE`, `COMPLETE_WITH_REPLACEMENTS`, `PARTIAL`, and `FAILED` only after fresh verification.
- Consumes: Jira issue create, edit, move-by-parent, and delete operations through injectable adapters.

- [ ] **Step 1: Write failing restore-plan and idempotency tests**

```js
test('restore plan reverses fields, moves, deletions, and additions in safe order', () => {
  const plan = planTreeRestore(treeRestoreFixture());
  assert.deepEqual(plan.steps.map(step => step.kind), [
    'CREATE_REPLACEMENT', 'MOVE_NODE', 'RESTORE_FIELDS', 'DELETE_ADDED_NODE'
  ]);
});

test('an added descendant is deleted exactly once across retry', async () => {
  const first = await executeTreeRestore(fixtureThatFailsAfterDelete());
  assert.equal(first.state, 'PARTIAL');
  const second = await executeTreeRestore(fixtureThatRetriesSameRestore());
  assert.equal(fixture().deleteCalls.length, 1);
  assert.equal(second.state, 'COMPLETE');
});

test('a deleted baseline node is recreated and mapped to its logical identity', async () => {
  const result = await executeTreeRestore(deletedBaselineNodeFixture());
  assert.equal(result.state, 'COMPLETE_WITH_REPLACEMENTS');
  assert.deepEqual(result.replacements, [{ logicalNodeId: 'story-logical', issueKey: 'FEAT-22' }]);
});

test('preflight refuses a structural restore before the first Jira mutation', async () => {
  const result = await executeTreeRestore(fixtureWithoutDeletePermission());
  assert.equal(result.state, 'FAILED');
  assert.equal(fixture().mutationCalls.length, 0);
});
```

- [ ] **Step 2: Run restore tests and confirm field-only restore fails them**

Run: `node --test test/tree-restore-plan.test.js test/tree-restore-execution.test.js test/tree-restore-verification.test.js test/restore-resume.test.js test/restore-correctness.test.js`

Expected: the existing restore planner has no node creation, move, delete, or logical replacement mapping.

- [ ] **Step 3: Implement a journaled structural restore**

```js
export function planTreeRestore({ baselineTree, currentTree, controlledFields }) {
  const diff = diffTree({ baselineTree, currentTree, controlledFields });
  return orderRestoreSteps([
    ...diff.removedNodes.map(node => createReplacementStep(node)),
    ...diff.movedNodes.map(node => moveNodeStep(node)),
    ...diff.changedNodes.map(node => restoreFieldsStep(node)),
    ...diff.addedNodes.sort(deepestFirst).map(node => deleteAddedNodeStep(node))
  ]);
}
```

Preflight the visibility, edit metadata, parent moves, issue creation, and deletion required by the complete plan before its first Jira mutation. Before each mutation, claim the deterministic step id in `va_restore_step`. After the mutation, persist the result and any replacement Jira id/key. On retry, re-read Jira and treat the already-achieved postcondition as success. Treat delete `404` as success only when the target was proven to be an added node for this baseline and the step had already been claimed. Append one ledger event for the immutable restore plan, every claimed destructive step, each replacement mapping, and final read-back result without storing secrets or full raw field values.

Create missing baseline nodes parent-first with the baseline issue type, summary, description, parent, and every controlled raw field accepted by create metadata. Restore moved nodes before field writes. Delete added descendants deepest-first. Never delete the governed root. If Jira permissions, metadata, or field editability cannot satisfy a step, keep the restore non-complete with exact unmatched evidence.

- [ ] **Step 4: Verify with a fresh complete tree read, not mutation responses**

```js
const verified = await verifyTreeRestore({
  readStableTree,
  rootIssueKey,
  baselineTree,
  controlledFields,
  replacements: await readReplacements(restoreId)
});
const state = verified.matches
  ? verified.replacements.length ? 'COMPLETE_WITH_REPLACEMENTS' : 'COMPLETE'
  : verified.progress ? 'PARTIAL' : 'FAILED';
```

Verification must compare every logical node, parent edge, and controlled field after resolving replacement mappings. Only `COMPLETE` and `COMPLETE_WITH_REPLACEMENTS` clear drift and return the root to `BASELINED`; all other states retain the restore lock/evidence needed for safe resumption.

- [ ] **Step 5: Run restore, lock, and failure-injection tests**

Run: `node --test test/tree-restore-plan.test.js test/tree-restore-execution.test.js test/tree-restore-verification.test.js test/restore-resume.test.js test/restore-correctness.test.js test/baseline-restore.test.js test/lock-lease.test.js test/baseline-decision.test.js test/approval-submit.test.js test/signature-ledger.test.js`

Expected: all pass, including crash after create, crash after delete, duplicate invocation, unreadable child, stale restore lease, and failed final read-back.

- [ ] **Step 6: Commit only Task 9 hunks**

```bash
git add -p src/lib/tree/restorePlan.js src/lib/tree/restoreExecutor.js src/lib/tree/restoreVerifier.js src/usecases/restoreActions.js src/usecases/restore.js src/lib/restore/outcome.js src/lib/restore/resume.js src/db/restoreStore.js src/db/restoreTreeStore.js src/db/itemStateStore.js src/db/driftStore.js src/lib/ledger.js test/tree-restore-plan.test.js test/tree-restore-execution.test.js test/tree-restore-verification.test.js test/restore-resume.test.js test/restore-correctness.test.js test/signature-ledger.test.js
git diff --cached --check
git commit -m "feat: restore recursive issue trees"
```

### Task 10: Show aggregate evidence and obtain informed rejection confirmation

**Files:**
- Modify: `src/usecases/panel.js`
- Modify: `src/usecases/panelAccess.js`
- Modify: `src/usecases/queue.js`
- Modify: `src/usecases/restore.js`
- Modify: `frontend/src/panel/types.ts`
- Modify: `frontend/src/panel/IssuePanel.tsx`
- Modify: `frontend/src/panel/sections/BaselineRecord.tsx`
- Modify: `frontend/src/panel/sections/DriftSection.tsx`
- Modify: `frontend/src/panel/sections/ApprovalControls.tsx`
- Modify: `frontend/src/panel/sections/RestoreStatus.tsx`
- Test: `frontend/test/panel.test.mjs`
- Test: `test/panel-response.test.js`
- Test: `test/panel-state.test.js`
- Test: `test/queue.test.js`

**Interfaces:**
- Produces: baseline evidence `{ nodeCount, edgeCount, totalFieldCount, treeHash }`.
- Produces: drift evidence grouped as changed fields, added nodes, removed nodes, and moved nodes.
- Produces: rejection confirmation containing the exact issue keys that will be permanently deleted and the count of missing nodes that will be recreated.
- Consumes: the same panel model for the Jira issue panel and My Approvals; no second approval implementation.

- [ ] **Step 1: Add failing backend and frontend evidence tests**

```js
test('panel returns structural drift and exact destructive consequences', async () => {
  const state = await panelState(treeDriftFixture());
  assert.deepEqual(state.rejection.deleteIssueKeys, ['NEW-9', 'NEW-10']);
  assert.equal(state.rejection.recreateCount, 1);
  assert.equal(state.baseline.totalFieldCount, 48);
});

test('reject confirmation names every added descendant to be deleted', async () => {
  await renderPanel(treeDriftState());
  assert.match(container.textContent, /NEW-9/);
  assert.match(container.textContent, /NEW-10/);
});
```

- [ ] **Step 2: Run panel tests and verify aggregate evidence is absent**

Run: `npm --prefix frontend test && node --test test/panel-response.test.js test/panel-state.test.js test/queue.test.js`

Expected: current responses expose only root field drift and cannot enumerate structural rejection effects.

- [ ] **Step 3: Implement one shared aggregate approval model**

Show the exact configured authentication method on every controlled transition. Show baseline capture text only when `capturesBaseline` is true. Show drift blocking only when `blocksOnDrift` is true and an active baseline exists. Before rejection, require confirmation after displaying every post-baseline descendant that will be deleted; if the list changes before submit, invalidate the confirmation and require a new challenge.

After restore, show replacement issue keys beside the logical baseline nodes they replace, and label the terminal result `Complete with replacement identities`. Do not describe a recreated node as the original Jira issue.

- [ ] **Step 4: Run UI, panel, queue, and accessibility regressions**

Run: `npm --prefix frontend test && npm --prefix frontend run build && node --test test/panel-response.test.js test/panel-state.test.js test/queue.test.js test/approval-submit.test.js test/signing-context.test.js`

Expected: all pass; transition screen, issue panel, and My Approvals expose the same provider and consequence model.

- [ ] **Step 5: Commit only Task 10 hunks**

```bash
git add -p src/usecases/panel.js src/usecases/panelAccess.js src/usecases/queue.js src/usecases/restore.js frontend/src/panel/types.ts frontend/src/panel/IssuePanel.tsx frontend/src/panel/sections/BaselineRecord.tsx frontend/src/panel/sections/DriftSection.tsx frontend/src/panel/sections/ApprovalControls.tsx frontend/src/panel/sections/RestoreStatus.tsx frontend/test/panel.test.mjs test/panel-response.test.js test/panel-state.test.js test/queue.test.js
git diff --cached --check
git commit -m "feat: show recursive approval evidence"
```

### Task 11: Prove local correctness, migrate safely, and complete live Jira acceptance

**Files:**
- Create: `test/controlled-transition-tree-acceptance.test.js`
- Modify: `docs/specs/2026-09-12-controlled-transition-tree-baseline-design.md`
- Modify: `docs/plans/2026-09-12-controlled-transition-tree-baseline.md`

- [ ] **Step 1: Add a local acceptance matrix**

Cover both authentication methods across transition screen, issue panel, and My Approvals; `capture_baseline` on and off; `block_on_drift` on and off; 16 fields on root, child, and grandchild; field drift; added, moved, and removed descendants; restore with and without replacement identities; duplicate events; stale approval; replayed challenge; failed persistence; validator denial; concurrent approval; partial restore; and failed final read-back.

- [ ] **Step 2: Run focused acceptance and the complete local verification suite**

Run: `node --test test/controlled-transition-tree-acceptance.test.js`

Run: `git diff 7c9f27d..HEAD --check && npm run verify`

Expected: the focused matrix passes, then the repository's complete backend, frontend, import, manifest, and build checks pass with no skipped failure.

- [ ] **Step 3: Review the completed branch before deployment**

Inspect `git status --short`, every task commit, and `git diff` against the starting commit. Confirm no unrelated dirty-worktree files are staged. Run the repository's code-review workflow and resolve every correctness or security finding before proceeding.

- [ ] **Step 4: Verify Forge identity and installation before any remote write**

Run: `forge lint`

Run: `forge settings list`

Run: `forge install list`

Confirm the manifest app id, environment, validator ARI, SQL ownership, and the exact already-installed Jira site. If any identity or tenant is ambiguous, stop before deploy/install and ask the user for the missing exact value; never guess a site.

- [ ] **Step 5: Deploy and upgrade only the verified development installation**

Run: `forge deploy -e development`

After `forge install list` has supplied the exact site URL, run `forge install --upgrade -e development --site "$VERIFIED_JIRA_SITE" --product jira`, where `VERIFIED_JIRA_SITE` is set in the same approved terminal session from that exact listed value. Re-run `forge install list` and confirm the installed version and environment changed as intended.

- [ ] **Step 6: Execute live Jira journeys**

On a dedicated test project, configure two distinct transitions to the same destination: one `ESIGNATURE`, one `BIOMETRIC`. Exercise each from the transition screen, issue panel, and My Approvals and prove the wrong evidence cannot be substituted. Exercise policies with baseline capture enabled and disabled, and drift blocking enabled and disabled.

Create a three-level native Jira tree and capture all 16 controlled fields on every node. Then separately change a child field, add a descendant, move a baseline node, and delete a baseline node. Approve one drift and reject another. Confirm rejection restores all controlled field values, deletes every added descendant named in the confirmation, restores parent edges, recreates deleted baseline nodes with disclosed replacement keys, and reaches a terminal complete state only after fresh read-back.

Repeat rejection once during a forced partial restore and once after duplicate event delivery to prove safe resumption and idempotency. Export or record the approval, baseline, drift, restore, and audit identifiers needed to reproduce each result without copying secrets.

- [ ] **Step 7: Record evidence and commit the verified acceptance result**

Update the spec and this plan with exact local test totals, deployment environment/version, installed site, Jira issue keys, transition ids, baseline tree hash/counts, restore ids, replacement mappings, and any remaining limitation. Clearly mark any journey not executed as unverified rather than complete.

```bash
git add test/controlled-transition-tree-acceptance.test.js docs/specs/2026-09-12-controlled-transition-tree-baseline-design.md docs/plans/2026-09-12-controlled-transition-tree-baseline.md
git diff --cached --check
git commit -m "test: prove controlled tree restoration"
```
