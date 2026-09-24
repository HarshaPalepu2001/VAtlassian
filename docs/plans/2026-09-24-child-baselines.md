# Child Baselines Implementation Plan

> Steps use checkbox (`- [x]`) syntax for tracking. Commits are authored as `Palepu Sai Sri Harsha <harsha.palepu@mgtechsoft.com>`.

**Goal:** When a parent is baselined, every child (through Jira's `parent` link, recursively) gets its own baseline, tracked with its own project/issue type's controlled fields. A child's drift is held and decided in the child. The parent's review groups changes by issue, and a parent decision covers the parent and every child.

**Architecture:** The parent's tree capture also writes an ordinary single-issue (flat) baseline row for each child, linked to the parent's baseline by `captured_by_baseline_id` and authenticated by the parent's approval. From then on each child is a normal baselined item, so the validator, panel and decisions work on it unchanged. The parent's own drift becomes its own fields plus the structure. Its review adds per-child sections compared against each child's own active baseline. A parent decision re-baselines (approve) or restores (reject) every child to its latest recorded baseline.

**Tech Stack:** Forge (Node 22, `@forge/api`, Forge SQL/MySQL), React 18 Custom UI, `node:test`.

**Spec:** `docs/specs/2026-09-24-child-baselines-design.md`

## Global Constraints

- Tracked fields per issue: exactly the Controlled Fields page rows for **that issue's own** project and issue type (`controlledFields({ projectId, issueTypeId })`). A child with none gets no baseline row.
- Scope: every child through `parent`, recursively (the existing tree reader). Linked issues: link only (`issuelinks`, kind `LINKS`), never their content.
- A new version is never drift if created by an authenticated act; anything else changing tracked content is drift.
- Parent is held by its own fields and structure only, never by children's drift (validator unchanged).
- Rejecting the parent restores each issue to **its own** latest recorded (active) baseline.
- Existing tree baselines: no backfill. Children get their own baselines at the parent's next capture.
- Every test command: `npm test` (backend, `node --test test/*.test.js`) and `npm run test:ui` (frontend). Both must be green at the end of every task.

## As built (2026-09-24)

Two deliberate departures from the steps below, both to meet the spec with fewer places to disagree:

1. **One effective baseline tree instead of `childTargets`.** `lib/tree/childBaselines.js` `withChildBaselines()` replaces each child node of the parent's baseline tree with that child's own latest baseline (digests and values). The panel snapshot and the queued restore worker both build it, so the grouped review, `planTreeRestore`, the executor and `verifyTreeRestore` all compare against the same record without a separate targets map. A child's baseline is its own record when this parent capture wrote it or it was captured at or after the parent's capture (`ownsItsContent`).
2. **Children without their own baseline keep today's behaviour.** `collectTree` drops a child's `FIELD_CHANGED` only when that child owns its content, so trees captured before child baselines existed still report child edits as parent drift until their next capture (spec §5).

Also added: `v062_baseline_captured_by_index` (publication selects by `captured_by_baseline_id`), `diffTree`'s `scopeFor` and `treeReviewDiff`'s `fieldsFor` take the node itself, and `verifyTreeRestore`/`executeTreeRestore` take `fieldsFor`. The parent summary counts drifted descendants from `va_baseline_node` joined to `va_item_state` rather than from `captured_by_baseline_id`, so children re-baselined on their own are counted too.

---

# Part 1: children carry their own baselines

## File map

| File | Responsibility |
|---|---|
| `src/db/migrations.js` | `v061_baseline_captured_by` column |
| `src/db/baselineStore.js` | read `captured_by_baseline_id` |
| `src/lib/tree/nodeFields.js` (new) | per-node tracked fields; read a tree with every node's fields |
| `src/lib/tree/capturePlan.js` | project each node with its own fields |
| `src/lib/tree/diff.js` | compare each node over its own fields |
| `src/db/childBaselineStore.js` (new) | write, publish and repair child baseline rows |
| `src/lib/capture.js` | materialise child baselines in `writeCapturedTreeBaseline` |
| `src/lib/treeCollect.js` | parent drift = own fields + structure; child collection |
| `src/lib/approval/runtime.js`, `src/usecases/panelAccess.js`, `src/jobs/restoreWorker.js` | use per-node fields wherever the tree is planned |

### Task 1: `captured_by_baseline_id` column

**Files:**
- Modify: `src/db/migrations.js` (append after `v060_vault_project_page`)
- Modify: `src/db/baselineStore.js:20-36` (`BASELINE_COLUMNS`, `decode`)
- Test: `test/migrations.test.js`, `test/baseline-storage.test.js`

**Interfaces:**
- Produces: `va_baseline.captured_by_baseline_id BINARY(16) NULL`; baseline rows read through `baselineStore` carry `captured_by_baseline_id` (Buffer or null).

- [x] **Step 1: Write the failing tests**

In `test/migrations.test.js` add:
```js
test('v061 adds the parent-capture link to va_baseline', async () => {
  const { MIGRATIONS } = await import('../src/db/migrations.js');
  const m = MIGRATIONS.find(x => x.id === 'v061_baseline_captured_by');
  assert.ok(m, 'migration present');
  assert.match(m.sql, /ALTER TABLE va_baseline\s+ADD COLUMN captured_by_baseline_id BINARY\(16\) NULL/);
  assert.equal(MIGRATIONS.at(-1).id, 'v061_baseline_captured_by');
});
```
(If the module exports the list under another name, use that name; check the top of `migrations.js` first.)

- [x] **Step 2: Run it and see it fail** — `node --test test/migrations.test.js` → FAIL "migration present".

- [x] **Step 3: Implement**

`src/db/migrations.js`, append to the list:
```js
  // A child's baseline captured by its parent's tree capture points at that
  // parent baseline: the child's approval IS the parent's. Null for a baseline
  // captured on the item's own controlled transition.
  { id: 'v061_baseline_captured_by', sql: `ALTER TABLE va_baseline ADD COLUMN captured_by_baseline_id BINARY(16) NULL` }
```
`src/db/baselineStore.js`: append `, TO_BASE64(captured_by_baseline_id) AS captured_by_baseline_id` to `BASELINE_COLUMNS`, and in `decode()` add `captured_by_baseline_id: row.captured_by_baseline_id == null ? null : fromBinaryColumn(row.captured_by_baseline_id)`.

- [x] **Step 4: Run** `npm test` → PASS.
- [x] **Step 5: Commit** `feat(baseline): record which parent capture produced a child baseline`

### Task 2: every node tracked with its own fields

**Files:**
- Create: `src/lib/tree/nodeFields.js`
- Modify: `src/lib/tree/capturePlan.js` (`planTreeCapture`)
- Modify: `src/lib/tree/diff.js` (`diffTree`)
- Modify callers: `src/lib/capture.js:279-288`, `src/lib/approval/runtime.js:12-25` (`approvalContentHash`), `src/usecases/panelAccess.js:108-135`, `src/lib/treeCollect.js:116-150`, `src/jobs/restoreWorker.js:70-93`
- Test: `test/tree-node-fields.test.js` (new), `test/tree-capture.test.js`, `test/tree-diff.test.js`

**Interfaces:**
- Produces:
  - `scopeKey(projectId, issueTypeId) -> string`
  - `nodeScope(node) -> { projectId: number, issueTypeId: string }` from `node.fields.project.id` / `node.fields.issuetype.id`
  - `async readTreeWithNodeFields({ readStableTree, readTree, rootIssueKey, rootFields, loadFields }) -> { tree, fieldsFor }`. `loadFields({ projectId, issueTypeId })` returns controlled-field rows. `fieldsFor(node)` returns that node's rows. Reads once with the root's fields plus `project`/`issuetype`; if any node's scope needs a field not yet read, reads again with the union.
  - `planTreeCapture({ rootIssueId, nodes, controlledFields, fieldsFor })`: `fieldsFor` is optional and defaults to `() => controlledFields`. `totalFieldCount` = sum over nodes of that node's field count.
  - `diffTree({ baselineTree, currentTree, controlledFields, scopeFor })`: `scopeFor(logicalNodeId)` returns that node's field rows, defaulting to `controlledFields`.

- [x] **Step 1: Write the failing tests** (`test/tree-node-fields.test.js`)
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTreeCapture } from '../src/lib/tree/capturePlan.js';
import { diffTree } from '../src/lib/tree/diff.js';
import { readTreeWithNodeFields, scopeKey } from '../src/lib/tree/nodeFields.js';

const F = id => ({ field_id: id, field_kind: 'TEXT', store_values: true });
const story = [F('summary'), F('customfield_1')];
const subtask = [F('summary')];
const node = (id, type, parent, fields) => ({ id, key: `K-${id}`, fields: { ...fields,
  project: { id: '1' }, issuetype: { id: type }, parent: parent ? { id: parent } : null } });
const nodes = [node('1', 'S', null, { summary: 'root', customfield_1: 'a' }), node('2', 'T', '1', { summary: 'child', customfield_1: 'ignored' })];
const fieldsFor = n => (String(n.fields.issuetype.id) === 'S' ? story : subtask);

test('each node is projected with its own issue type\'s fields', () => {
  const plan = planTreeCapture({ rootIssueId: '1', nodes, controlledFields: story, fieldsFor });
  const child = plan.nodes.find(n => n.originalIssueId === 2);
  assert.deepEqual(Object.keys(JSON.parse(child.fieldDigests)), ['summary']);
  assert.deepEqual(Object.keys(plan.values[child.logicalNodeId]), ['summary']);
  assert.equal(plan.totalFieldCount, 3);
});

test('without fieldsFor every node uses the given list, exactly as before', () => {
  const plan = planTreeCapture({ rootIssueId: '1', nodes, controlledFields: story });
  assert.equal(plan.totalFieldCount, 4);
});

test('a change to a field the child does not track is not a child change', () => {
  const base = planTreeCapture({ rootIssueId: '1', nodes, controlledFields: story, fieldsFor });
  const edited = [nodes[0], node('2', 'T', '1', { summary: 'child', customfield_1: 'changed' })];
  const now = planTreeCapture({ rootIssueId: '1', nodes: edited, controlledFields: story, fieldsFor });
  const byId = new Map(now.nodes.map(n => [n.logicalNodeId, n]));
  const { changes } = diffTree({ baselineTree: base, currentTree: now, controlledFields: story,
    scopeFor: id => fieldsFor(byId.get(id) ? { fields: { issuetype: { id: byId.get(id).issueTypeId } } } : nodes[0]) });
  assert.deepEqual(changes, []);
});

test('readTreeWithNodeFields re-reads once with the union when a child needs another field', async () => {
  const reads = [];
  const tree = { nodes: [node('1', 'S', null, { summary: 'r', customfield_1: 'a' }), node('2', 'X', '1', { summary: 'c' })] };
  const extra = [F('summary'), F('customfield_9')];
  const result = await readTreeWithNodeFields({
    readStableTree: async ({ fieldIds }) => { reads.push([...fieldIds].sort()); return { tree }; },
    readTree: null, rootIssueKey: 'K-1', rootFields: story,
    loadFields: async ({ issueTypeId }) => (issueTypeId === 'S' ? story : extra)
  });
  assert.equal(reads.length, 2);
  assert.ok(reads[1].includes('customfield_9'));
  assert.deepEqual(result.fieldsFor(tree.nodes[1]).map(f => f.field_id), ['summary', 'customfield_9']);
  assert.equal(scopeKey(1, 'S'), '1:S');
});
```

- [x] **Step 2: Run** `node --test test/tree-node-fields.test.js` → FAIL (module missing).

- [x] **Step 3: Implement `src/lib/tree/nodeFields.js`**
```js
/**
 * EVERY NODE IS TRACKED WITH ITS OWN FIELDS.
 *
 * Decided 2026-09-24: a baseline tracks exactly the Controlled Fields page rows
 * for its own project and issue type — the parent and each child alike. A tree
 * therefore needs one field list per distinct (project, issue type) among its
 * nodes, known only once the tree has been read.
 */
export const scopeKey = (projectId, issueTypeId) => `${Number(projectId)}:${String(issueTypeId)}`;

export function nodeScope(node) {
  return { projectId: Number(node?.fields?.project?.id ?? node?.projectId),
    issueTypeId: String(node?.fields?.issuetype?.id ?? node?.issueTypeId ?? '') };
}

export async function readTreeWithNodeFields({ readStableTree, readTree, rootIssueKey, rootFields, loadFields }) {
  const baseIds = [...new Set([...rootFields.map(f => f.field_id), 'project', 'issuetype'])];
  let { tree } = await readStableTree({ readTree, rootIssueKey, fieldIds: baseIds });
  const byScope = new Map();
  for (const node of tree.nodes) {
    const scope = nodeScope(node);
    const key = scopeKey(scope.projectId, scope.issueTypeId);
    if (!byScope.has(key)) byScope.set(key, await loadFields(scope));
  }
  const needed = new Set([...byScope.values()].flat().map(f => f.field_id));
  if ([...needed].some(id => !baseIds.includes(id))) {
    ({ tree } = await readStableTree({ readTree, rootIssueKey, fieldIds: [...new Set([...baseIds, ...needed])] }));
  }
  const fieldsFor = node => {
    const { projectId, issueTypeId } = nodeScope(node);
    return byScope.get(scopeKey(projectId, issueTypeId)) ?? [];
  };
  return { tree, fieldsFor };
}
```
In `planTreeCapture`: add parameter `fieldsFor = () => controlledFields`. Per node, `const own = fieldsFor(node.source ?? node)`, then `project(node.fields, own)`; `BASELINE_VALUES_REQUIRED` when `Object.keys(projection.raw).length !== own.length`; `totalFieldCount = planned.reduce((n, p) => n + p.ownCount, 0)`, keeping `ownCount` on the planned entry.
In `diffTree`: add `scopeFor = null`; per node `const scopeIds = contentFieldIds(scopeFor ? scopeFor(curr.logicalNodeId) : controlledFields)`.

- [x] **Step 4: Switch every caller to per-node fields** (same function everywhere, so the signature, capture, panel, collector and restore agree):
  - `capture.js` `writeCapturedTreeBaseline`: replace the `readStableTree` + `planTreeCapture` pair with `readTreeWithNodeFields({ readStableTree: services.readStableTree, readTree: services.readTree, rootIssueKey: rootIssue.key, rootFields: controlledFields, loadFields: services.controlledFieldsFor })` (default `services.controlledFieldsFor = controlledFields` from `configStore`), then `planTreeCapture({ ..., fieldsFor })`. Keep `fieldsFor` for Task 3.
  - `runtime.js` `approvalContentHash`: the tree branch takes an injectable `loadFields` (the gate runtime passes `config.controlledFields`) and uses `readTreeWithNodeFields` + `planTreeCapture({ fieldsFor })`.
  - `panelAccess.js` snapshot tree branch: `readTreeWithNodeFields` with `loadFields: controlledFields`; pass `fieldsFor` to `planTreeCapture`, and to `diffTree` as `scopeFor: id => fieldsFor(nodeById(id))`, where `nodeById` maps logical ids back to read nodes.
  - `treeCollect.js` and `restoreWorker.js` `defaultPrepare`: same substitution.

- [x] **Step 5: Run** `npm test` → PASS. Existing tree tests pass unchanged because a tree whose nodes share one scope projects exactly as before.
- [x] **Step 6: Commit** `feat(tree): track every node with its own project and issue type's fields`

### Task 3: materialise a baseline for each child at the parent's capture

**Files:**
- Create: `src/db/childBaselineStore.js`
- Modify: `src/lib/capture.js` (`writeCapturedTreeBaseline`)
- Test: `test/child-baseline-capture.test.js` (new)

**Interfaces:**
- Consumes: `fieldsFor` and `treePlan.nodes`/`treePlan.values` from Task 2; `captured_by_baseline_id` from Task 1.
- Produces:
  - `planChildBaselines({ treePlan, rootIssueId, fieldsFor, nodeOf, parent, nextVersion }) -> ChildRow[]` (pure). `ChildRow = { issue_id, issue_key, project_id, issue_type_id, version, content_hash, field_digests, raw, field_count, captured_by_baseline_id, transition_id, from_status_id, to_status_id, required_role, required_assurance, controlled_fields_hash, approved_by, approved_name, assurance_level, approval_id, transition_at, captured_at }`
  - `writeChildBaselines({ rows, query })`: inserts `va_baseline` rows in state `CAPTURING` with `tree_hash` NULL and `fidelity` `EXACT`, plus their `va_baseline_value` rows (same encoding as `baselineStore.writeBaseline`). Idempotent: first deletes `CAPTURING` rows (and their values) with the same `captured_by_baseline_id`.
  - `publishChildBaselines({ parentBaselineId, query, write }) -> { published: number }`: sets `ACTIVE` every `CAPTURING` row with that `captured_by_baseline_id` whose provenance is complete, then supersedes each child's older `ACTIVE` rows. Safe to call repeatedly.
  - `writeCapturedTreeBaseline` result gains `children: [{ issueId, version, baselineId }]`.

- [x] **Step 1: Write the failing tests** (`test/child-baseline-capture.test.js`)
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTreeCapture } from '../src/lib/tree/capturePlan.js';
import { planChildBaselines } from '../src/db/childBaselineStore.js';

const F = id => ({ field_id: id, field_kind: 'TEXT', store_values: true });
const nodes = [
  { id: '1', key: 'P-1', fields: { summary: 'parent', project: { id: '1' }, issuetype: { id: 'S' }, parent: null } },
  { id: '2', key: 'P-2', fields: { summary: 'sub a', project: { id: '1' }, issuetype: { id: 'T' }, parent: { id: '1' } } },
  { id: '3', key: 'P-3', fields: { summary: 'sub b', project: { id: '1' }, issuetype: { id: 'U' }, parent: { id: '2' } } }
];
const fieldsFor = n => (String((n.fields ?? n).issuetype?.id ?? n.issueTypeId) === 'U' ? [] : [F('summary')]);
const parent = { baselineId: Buffer.alloc(16, 9), approvalId: Buffer.alloc(16, 8), accountId: 'signer', displayName: 'Signer',
  assuranceLevel: 'ESIGNATURE', policy: { transition_id: '31', from_status_id: '3', to_status_id: '4',
  required_role: 'reviewer', required_assurance: 'ESIGNATURE' }, transitionAt: 10, capturedAt: 20 };

test('every child with tracked fields gets its own baseline, authenticated by the parent approval', () => {
  const treePlan = planTreeCapture({ rootIssueId: '1', nodes, controlledFields: [F('summary')], fieldsFor });
  const rows = planChildBaselines({ treePlan, rootIssueId: '1', fieldsFor, nodeOf: id => nodes.find(n => Number(n.id) === id),
    parent, nextVersion: issueId => (issueId === 2 ? 5 : 1) });
  assert.deepEqual(rows.map(r => [r.issue_id, r.version]), [[2, 5]], 'no row for the child with no tracked fields');
  const [row] = rows;
  assert.equal(row.captured_by_baseline_id, parent.baselineId);
  assert.equal(row.approval_id, parent.approvalId);
  assert.equal(row.approved_by, 'signer');
  assert.equal(row.required_role, 'reviewer');
  assert.deepEqual(JSON.parse(row.field_digests), JSON.parse(treePlan.nodes.find(n => n.originalIssueId === 2).fieldDigests));
  assert.deepEqual(row.raw, { summary: 'sub a' });
});
```
Also add store tests with a recording `query` fake: `writeChildBaselines` clears then inserts one `va_baseline` row per child plus its value rows; `publishChildBaselines` issues the activate and supersede statements scoped by `captured_by_baseline_id`.

- [x] **Step 2: Run** → FAIL (module missing).

- [x] **Step 3: Implement `src/db/childBaselineStore.js`.** `planChildBaselines` walks `treePlan.nodes`, skips the root and any node whose `fieldsFor(nodeOf(id))` is empty, and builds each `ChildRow` from the node (`contentHash`, `fieldDigests`, `treePlan.values[logicalNodeId]`) and `parent`. `controlled_fields_hash` is `controlledFieldsHash(fieldsFor(node))` from `lib/baselinePolicy.js`. The writer and publisher use `store.throwing` / `executeQuery` with the same SQL shapes as `baselineStore.writeBaseline` and `baselineTreeStore.publishTreeBaseline`, filtered on `captured_by_baseline_id = FROM_BASE64(?)`.

- [x] **Step 4: Wire into `writeCapturedTreeBaseline`** after `verifyTreeCapture` and before `publishTreeBaseline`:
```js
  const children = planChildBaselines({ treePlan, rootIssueId: rootIssue.id, fieldsFor,
    nodeOf: id => stable.tree.nodes.find(n => Number(n.id) === Number(id)),
    parent: { baselineId: reserved.baselineId, approvalId: approval.approvalId, accountId: approval.accountId,
      displayName: approval.displayName, assuranceLevel: approval.assuranceLevel, policy, transitionAt, capturedAt },
    nextVersion: await services.nextVersions(treePlan.nodes.map(n => n.originalIssueId)) });
  await services.writeChildBaselines({ rows: children });
```
After `publishTreeBaseline`: `await services.publishChildBaselines({ parentBaselineId: reserved.baselineId })`, then `upsertBaselined` for each child (its key, project, type, version, digests), then one `BASELINE_CAPTURED` ledger entry per child with `payload.capturedBy = parent version`. In the `alreadyCaptured` branch (parent already `ACTIVE`), also call `publishChildBaselines` so an interrupted publication is repaired on retry. `services.nextVersions(ids)` returns `issueId => currentVersion(issueId) + 1`, read in one query: `SELECT issue_id, MAX(version) ... GROUP BY issue_id`.

- [x] **Step 5: Run** `npm test` → PASS. Update `test/drift-functional.test.js` / `test/controlled-transition-tree-acceptance.test.js` fixtures only if they now need the new services injected (add no-op fakes).
- [x] **Step 6: Commit** `feat(capture): give every child its own baseline when its parent is baselined`

### Task 4: parent drift is its own fields and structure; children are collected on their own

**Files:**
- Modify: `src/lib/treeCollect.js` (`collectTree`, `collectAffectedTrees`)
- Test: `test/tree-drift-functional.test.js`

**Interfaces:**
- Produces: `collectTree` ignores `FIELD_CHANGED` for non-root nodes. `collectAffectedTrees(event, deps)` also runs `deps.collect({ issueId, issueKey })` (flat collector) when the event's own issue has an ACTIVE flat baseline (`deps.ownFlatBaseline(issueId)` returns truthy when the active baseline has `tree_hash` NULL).

- [x] **Step 1: Failing tests** in `test/tree-drift-functional.test.js`:
  - a child's summary changed and nothing else → `collectTree` outcome `NO_CHANGE`;
  - a child added → `DRIFT_RECORDED` with a `NODE_ADDED` row;
  - root summary changed → `DRIFT_RECORDED`;
  - `collectAffectedTrees` for a child event with `ownFlatBaseline` true → `collect` called once with that issue, plus the parent's `collectTree`.
- [x] **Step 2: Run** → FAIL.
- [x] **Step 3: Implement.** After `diffTree`, keep only `NODE_*` changes and `FIELD_CHANGED` whose `logicalNodeId` is the root's (`logicalNodeId(rootIssueId)` from `tree/model.js`). In `collectAffectedTrees`, append the flat collection result to the returned array.
- [x] **Step 4: Run** `npm test` → PASS.
- [x] **Step 5: Commit** `feat(drift): a child's changes are its own drift, not its parent's`

### Task 5: scenarios for Part 1

**Files:**
- Modify: `test/helpers/validator-world.js` (a `childOf` option on `createIssue` to set `fields.parent`; `baseline(key, { capturedBy })` to set `captured_by_baseline_id`)
- Test: `test/validator-scenarios.test.js`

- [x] **Step 1: Add scenarios** (all run the real validator and panel):
  - a parent baselined with a child baseline; editing the child holds only the child, and the child's panel can approve;
  - the parent is not held while its child is drifted;
  - child at v5 (own captures), parent at v1: a parent capture producing child v6 is not drift;
  - the child's reject restores to the child's own active baseline.
- [x] **Step 2: Run** `npm test` → PASS.
- [x] **Step 3: Commit** `test(scenarios): child baselines are held and decided on their own`

---

# Part 2: the parent's review covers its children

### Task 6: grouped review diff

**Files:**
- Create: `src/lib/tree/groupedReview.js`
- Modify: `src/usecases/panelAccess.js` (snapshot: build groups)
- Test: `test/tree-grouped-review.test.js` (new)

**Interfaces:**
- Produces: `groupReview({ root: { issueId, issueKey, summary, diff }, structural: DiffField[], children: [{ issueId, issueKey, summary, baselineVersion, diff }] }) -> { groups, fields, changedFieldCount, materialFieldCount }`.
  - Each group is `{ kind: 'ISSUE' | 'STRUCTURE', issueId, issueKey, summary, isRoot, baselineVersion, fields }`.
  - Order: root first, then structure, then children by key. Groups with no fields are omitted.
  - `fields` is the flat concatenation (existing consumers), with each child field's `fieldId` prefixed `${issueId}:` and `issueKey` set.

- [x] **Step 1: Failing test**: root with 1 changed field, 2 children (one with 2 changes, one clean), 1 structural change → groups `[root(1), structure(1), child(2)]`, `changedFieldCount === 4`, and the clean child is absent.
- [x] **Step 2: Implement `groupReview`** (pure).
- [x] **Step 3: panelAccess.** When `baseline.tree_hash`:
  - read the children's active baselines (`activeBaselines(childIds)`, one query) and their values (`readAllValues(childId, version)`);
  - build each child's diff with `diffIssue({ baseline: childBaseline, baselineValues, currentFields: childNode.fields, controlledFields: fieldsFor(childNode) })`;
  - the root diff is the root node's `FIELD_CHANGED` through `treeReviewDiff` restricted to the root;
  - structural fields are `treeReviewDiff`'s `tree:*` entries;
  - set `reviewDiff = groupReview(...)`, keep `evidenceHash = treeHash`, and have `reviewDriftCount` use the grouped count.
  - Children without their own baseline (old trees) keep today's comparison against the parent's stored node.
- [x] **Step 4: Run** `npm test` → PASS.
- [x] **Step 5: Commit** `feat(review): group a parent's changes by issue`

### Task 7: a parent decision covers its children

**Files:**
- Modify: `src/usecases/drift.js` (`prepareApproval` restore plan), `src/lib/tree/restorePlan.js` (`planTreeRestore`)
- Test: `test/tree-restore-plan.test.js`, `test/drift-functional.test.js`

**Interfaces:**
- Produces: `planTreeRestore({ baselineTree, currentTree, controlledFields, childTargets })`. `childTargets` is a Map from logicalNodeId to `{ values, changedFieldIds }`, from each child's own active baseline. For those nodes, `RESTORE_FIELDS` steps use `childTargets` in place of `baselineTree.values`.

- [x] **Step 1: Failing tests:**
  - a child whose own active baseline (v6) differs from the parent's stored node: reject restores the child to v6's values;
  - approve from the parent while a child has drifted: the parent's capture gives that child a new version (Task 3), so the child is no longer drifted.
- [x] **Step 2: Implement.** `prepareApproval` builds `childTargets` from the grouped review's child diffs (Task 6) and passes it to `planTreeRestore`. The decision diff count is the grouped `changedFieldCount`.
- [x] **Step 3: Run** `npm test` → PASS.
- [x] **Step 4: Commit** `feat(decision): a parent decision re-baselines or restores every child`

### Task 8: panel and diff view

**Files:**
- Modify: `src/usecases/panelSummary.js` (children awaiting decision), `frontend/src/review/DiffView.tsx`, `frontend/src/review/types.ts`, `frontend/src/panel/sections/DriftSection.tsx`
- Test: `test/panel-performance-contract.test.js` (no tree read in summary), `frontend/test/panel.test.mjs`

**Interfaces:**
- Produces: summary `drift.childrenAwaiting: number`, from `va_item_state` rows `DRIFTED` whose active baseline has `captured_by_baseline_id` = the parent's active baseline (one indexed query, informational only). The parent's decision is offered when its own drift count > 0 **or** `childrenAwaiting > 0`. `ReviewGroup` type `{ kind, issueKey, summary, isRoot, baselineVersion, fields }`, rendered as one section per issue, headed "KEY · summary". The child panel shows "Baselined with PARENT-1 v3".
- [x] **Step 1: Failing tests** for:
  - the summary count;
  - the performance contract (still no tree read);
  - DiffView renders a section per group with its header, and falls back to the flat list when `groups` is absent.
- [x] **Step 2: Implement.**
- [x] **Step 3: Run** `npm test` and `npm run test:ui` → PASS.
- [x] **Step 4: Commit** `feat(panel): show a parent's changes grouped by issue`

### Task 9: verify, report, deploy

- [x] `npm run verify` green.
- [x] Extend `docs/acceptance/2026-09-24-validator-scenarios.md` with the Part 1 and 2 scenarios.
- [x] `forge deploy -e development --non-interactive`; confirm `forge install list` shows the mgtechdemo installs up to date.
- [x] Commit and push to `origin` and `github` (`VAtlassian`), authored as Palepu Sai Sri Harsha.
