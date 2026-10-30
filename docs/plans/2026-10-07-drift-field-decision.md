# Per-field drift decisions implementation plan

**Goal.** Let a reviewer approve or reject each changed field in the review window, authenticate that complete choice once, restore only the rejected fields, and publish the resulting state as the next baseline. Keep whole-set Approve/Reject unchanged.

**Architecture.** A pure `mixedDecision` module turns a canonical `{fieldId, decision}` map into a *target tree* (the approved baseline with every APPROVED field's digest replaced by the live one). The existing `planTreeRestore` and `verifyTreeRestore` run unchanged against that target tree, so they restore only rejected fields and verify those fields against their approved values. A new `MIXED` decision flows through the existing challenge → authenticate → record → apply path; the restore worker owns the single durable boundary and captures the next baseline only after verification.

**Technology.** Node ESM (`node --test`), Forge SQL (MySQL), Forge queues, React 19 + TypeScript frontend (`node --experimental-strip-types --test`, happy-dom).

**Spec:** `docs/specs/2026-10-07-drift-field-decision-design.md`

## Global constraints

- Whole-set Approve and Reject keep their current contracts, records and tests. Existing whole-set records are unchanged by migrations.
- The browser's field list, labels, counts and values are never trusted; the server recomputes the authoritative change set and requires an **exact one-to-one** decision map (no missing, duplicate, unknown or extra fields).
- Challenge creation performs no provider call, Jira write, lock, baseline publication or approval record. Authentication is requested once, after all decisions are recorded; a failed or cancelled authentication records nothing.
- A field whose approved value is not retained, or that Jira cannot currently write, cannot be assigned Reject; this is refused **before** authentication is spent.
- A baseline is never captured before every rejected field is verified at its approved value. A partial restore leaves the item `DRIFTED`/`ERROR` exactly as the existing restore rules say.
- Decision map is part of the challenge operation-plan hash, the signed binding, and the audited approval payload.
- Projections stay authorization-filtered: a decision map never reveals hidden descendant keys or values.
- No new authenticator, no AI deciding outcomes, no removal of whole-set actions.
- UI: keyboard- and screen-reader-operable (not colour/drag alone), reduced-motion safe, decision written in text.
- Repo rules: **no AI attribution in commit messages**; commit only when the user asks because the working tree already holds the user's uncommitted work. This plan has no commit steps. Run the checkpoint commands instead.

## Scope decisions (made from the code, flagged to the user at hand-off)

1. **Tree baselines only.** Every baseline written today is a tree baseline (`writeCapturedTreeBaseline`). A legacy field-only baseline (no `tree_hash`) reports `mixed.eligible = false` and the review keeps whole-set Approve/Reject only.
2. **Structural changes disable the mixed workflow.** Work items added/removed/moved (`tree:NODE_*` review fields) are not "fields". If any exist, `mixed.eligible = false` with reason `STRUCTURE_CHANGED`; the reviewer uses whole-set. This avoids inventing target-tree semantics for node creation/deletion that the spec does not define.
3. **Mixed restores always run through the queue worker** (the same durable path every tree restore uses), regardless of `config.restore.queue`.
4. **A mixed save publishes a new baseline only when at least one field is approved.**
   With both approved and rejected fields, rejected fields are restored first,
   then the resulting combined state is captured once as the next version. If
   every field is rejected, the restore completes against the existing active
   baseline and no new version is created; if every field is approved, the
   current state is captured directly as the next version.

## File structure

| File | Responsibility |
|---|---|
| `src/lib/approval/mixedDecision.js` (new) | Pure: canonical map, hash, coverage/restorability validation, overlay, target tree, plan |
| `src/lib/decision.js` | `decide()` learns `MIXED`; `DECISION.MIXED` |
| `src/lib/approval/challenge.js` | `MIXED` meaning; `challengeContextHash` covers mixed plan |
| `src/lib/approval/record.js` | `MIXED` decision; `decision_map`, `decision_map_hash` bound into evidence |
| `src/lib/evidence/versionEvidence.js` | `CAUSE.MIXED_DECISION` |
| `src/db/migrations.js` | v107 `va_approval.decision_map`, `decision_map_hash` |
| `src/db/approvalStore.js` | persist/read the two columns |
| `src/usecases/panelAccess.js` / `panelEvidence.js` | stamp `rawFieldId`/`logicalNodeId` (already present) + `drift.mixed` summary |
| `src/usecases/approval.js` | `DRIFT_MIXED` challenge + submit |
| `src/usecases/drift.js` | `prepareApproval` mixed plan; `applyApproval` MIXED branch; shared `captureDriftBaseline` |
| `src/usecases/restoreActions.js` | `queueRestore` accepts a mixed plan + overlay |
| `src/jobs/restoreWorker.js` | MIXED approvals, target-tree verification, capture after verify |
| `src/usecases/restore.js` | Retry understands MIXED |
| `frontend/src/review/fieldDecisions.ts` (new) | Pure decision-state reducer, counts, canonical payload |
| `frontend/src/review/FieldDecisionTrack.tsx` (new) | Accessible swipe/keyboard/button track |
| `frontend/src/review/DiffView.tsx` | decision mode: per-field track + summary bar |
| `frontend/src/review/ReviewWindow.tsx` | owns decision state, hands it to `ApprovalControls` |
| `frontend/src/panel/sections/ApprovalControls.tsx` + `approvalModel.ts` + `types.ts` | mixed ceremony, panel/receipt copy |
| tests | `test/mixed-decision.test.js`, `test/mixed-approval.test.js`, `test/mixed-restore-worker.test.js`, extensions in `test/migrations.test.js`, `frontend/test/field-decisions.test.mjs`, `frontend/test/panel.test.mjs` |

Checkpoint commands (used throughout): `npm test`, `npm run test:ui`, `npm run build:ui`, `npm run smoke`.

---

### Task 1: Pure mixed-decision core

**Files:**
- Create: `src/lib/approval/mixedDecision.js`
- Test: `test/mixed-decision.test.js`

**Interfaces:**
- Produces:
  - `canonicalDecisions(decisions) → [{fieldId, decision}]` sorted by `fieldId`; throws `FailClosed('DECISION_MAP_INVALID')` on non-array, non-string id, choice not `APPROVE|REJECT`, or duplicate id.
  - `decisionMapHash(canonical) → hex64`.
  - `validateDecisions({ decisions, reviewFields }) → { decisions, approved: DiffField[], rejected: DiffField[] }`; throws `FailClosed('MIXED_STRUCTURE_UNSUPPORTED' | 'DECISION_MAP_MISMATCH' | 'FIELD_NOT_RESTORABLE')`.
  - `targetTreeFor({ baselineTree, currentTree, approved }) → { targetTree, overlay }` where `overlay = { [logicalNodeId]: { [rawFieldId]: digest } }`.
  - `applyOverlay({ baselineTree, overlay }) → targetTree` (the worker rebuilds the same target from the frozen overlay).
  - `planMixed({ decisions, reviewFields, baselineTree, currentTree, controlledFields, fieldsFor }) → { decisions, mapHash, approved, rejected, overlay, targetTree, restore, planHash }` where `restore = planTreeRestore(...)`.
  - `mixedEligibility({ baseline, reviewFields }) → { eligible, reason, fields: [{fieldId, restorable, retained}] }` for the evidence payload.
  - `MIXED_INTENT = 'DRIFT_MIXED'`.

- [ ] **Step 1: Write the failing tests**

```js
// test/mixed-decision.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDecisions, decisionMapHash, validateDecisions, targetTreeFor, applyOverlay,
  planMixed, mixedEligibility } from '../src/lib/approval/mixedDecision.js';

const field = (logicalNodeId, rawFieldId, extra = {}) => ({
  fieldId: `${logicalNodeId}:${rawFieldId}`, rawFieldId, logicalNodeId, fieldName: rawFieldId,
  group: { kind: 'ISSUE', logicalNodeId }, restorable: 'YES', retained: true, ...extra });
const root = 'n1';
const fields = [field(root, 'summary'), field(root, 'description')];

test('canonical form is order independent and hashes stably', () => {
  const a = canonicalDecisions([{ fieldId: 'b', decision: 'REJECT' }, { fieldId: 'a', decision: 'APPROVE' }]);
  const b = canonicalDecisions([{ fieldId: 'a', decision: 'APPROVE' }, { fieldId: 'b', decision: 'REJECT' }]);
  assert.deepEqual(a, b);
  assert.equal(decisionMapHash(a), decisionMapHash(b));
  assert.notEqual(decisionMapHash(a), decisionMapHash(canonicalDecisions([
    { fieldId: 'a', decision: 'REJECT' }, { fieldId: 'b', decision: 'REJECT' }])));
});

test('malformed maps are refused', () => {
  for (const bad of [null, {}, [{ fieldId: 'a', decision: 'MAYBE' }], [{ fieldId: '', decision: 'APPROVE' }],
    [{ fieldId: 'a', decision: 'APPROVE' }, { fieldId: 'a', decision: 'REJECT' }]]) {
    assert.throws(() => canonicalDecisions(bad), { reason: 'DECISION_MAP_INVALID' });
  }
});

test('coverage must be exact', () => {
  const ok = [{ fieldId: `${root}:summary`, decision: 'APPROVE' }, { fieldId: `${root}:description`, decision: 'REJECT' }];
  const v = validateDecisions({ decisions: ok, reviewFields: fields });
  assert.deepEqual(v.approved.map(f => f.rawFieldId), ['summary']);
  assert.deepEqual(v.rejected.map(f => f.rawFieldId), ['description']);
  for (const bad of [ok.slice(0, 1), [...ok, { fieldId: 'ghost:x', decision: 'APPROVE' }]]) {
    assert.throws(() => validateDecisions({ decisions: bad, reviewFields: fields }), { reason: 'DECISION_MAP_MISMATCH' });
  }
});

test('a non-restorable field cannot be rejected but may be approved', () => {
  const locked = [field(root, 'summary', { restorable: 'NOT_RETAINED', retained: false }), field(root, 'description')];
  const reject = [{ fieldId: `${root}:summary`, decision: 'REJECT' }, { fieldId: `${root}:description`, decision: 'APPROVE' }];
  assert.throws(() => validateDecisions({ decisions: reject, reviewFields: locked }), { reason: 'FIELD_NOT_RESTORABLE' });
  const approve = reject.map(d => ({ ...d, decision: 'APPROVE' }));
  assert.doesNotThrow(() => validateDecisions({ decisions: approve, reviewFields: locked }));
});

test('structural changes make the mixed workflow unavailable', () => {
  const withStructure = [...fields, { fieldId: 'tree:NODE_ADDED:n2', group: { kind: 'STRUCTURE' }, restorable: 'SPECIAL' }];
  assert.throws(() => validateDecisions({ decisions: [], reviewFields: withStructure }), { reason: 'MIXED_STRUCTURE_UNSUPPORTED' });
  assert.deepEqual(mixedEligibility({ baseline: { tree_hash: 'x' }, reviewFields: withStructure }),
    { eligible: false, reason: 'STRUCTURE_CHANGED', fields: [] });
  assert.equal(mixedEligibility({ baseline: {}, reviewFields: fields }).reason, 'NOT_TREE_BASELINE');
  assert.equal(mixedEligibility({ baseline: { tree_hash: 'x' }, reviewFields: fields }).eligible, true);
});

const baselineTree = { nodes: [{ logicalNodeId: root, parentLogicalNodeId: null,
  digests: { summary: 'S0', description: 'D0' } }], values: { [root]: { summary: 'old', description: 'oldD' } } };
const currentTree = { nodes: [{ logicalNodeId: root, parentLogicalId: null,
  digests: { summary: 'S1', description: 'D1' } }], values: { [root]: { summary: 'new', description: 'newD' } } };

test('target tree takes live digests for approved fields only', () => {
  const approved = [fields[0]];
  const { targetTree, overlay } = targetTreeFor({ baselineTree, currentTree, approved });
  assert.deepEqual(targetTree.nodes[0].digests, { summary: 'S1', description: 'D0' });
  assert.deepEqual(overlay, { [root]: { summary: 'S1' } });
  assert.deepEqual(baselineTree.nodes[0].digests, { summary: 'S0', description: 'D0' }, 'input is not mutated');
  assert.deepEqual(applyOverlay({ baselineTree, overlay }).nodes[0].digests, targetTree.nodes[0].digests);
});

test('plan restores only rejected fields and its hash moves with every decision', () => {
  const controlledFields = [{ field_id: 'summary', field_kind: 'scalar' }, { field_id: 'description', field_kind: 'scalar' }];
  const run = decisions => planMixed({ decisions, reviewFields: fields, baselineTree, currentTree,
    controlledFields, fieldsFor: () => controlledFields });
  const a = run([{ fieldId: `${root}:summary`, decision: 'APPROVE' }, { fieldId: `${root}:description`, decision: 'REJECT' }]);
  assert.deepEqual(a.restore.steps.map(s => [s.kind, s.fieldIds]), [['RESTORE_FIELDS', ['description']]]);
  const b = run([{ fieldId: `${root}:summary`, decision: 'REJECT' }, { fieldId: `${root}:description`, decision: 'APPROVE' }]);
  assert.deepEqual(b.restore.steps.map(s => s.fieldIds), [['summary']]);
  assert.notEqual(a.planHash, b.planHash);
  assert.equal(a.planHash, run([...a.decisions].reverse()).planHash, 'input order is irrelevant');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/mixed-decision.test.js`
Expected: FAIL (`Cannot find module .../mixedDecision.js`).

- [ ] **Step 3: Implement** (`src/lib/approval/mixedDecision.js`)

```js
import { canonical, sha256Hex } from '../hash.js';
import { FailClosed } from '../errors.js';
import { planTreeRestore } from '../tree/restorePlan.js';

export const MIXED_INTENT = 'DRIFT_MIXED';
const CHOICES = new Set(['APPROVE', 'REJECT']);
const CANNOT_RESTORE = new Set(['NO', 'NOT_RETAINED']);
const bad = reason => { throw new FailClosed(reason); };
const isStructure = field => field?.group?.kind === 'STRUCTURE' || String(field?.fieldId ?? '').startsWith('tree:');

/** Sorted by stable field identity so order can never change the meaning. */
export function canonicalDecisions(decisions) {
  if (!Array.isArray(decisions)) bad('DECISION_MAP_INVALID');
  const seen = new Set();
  const out = decisions.map(entry => {
    const fieldId = entry?.fieldId;
    if (typeof fieldId !== 'string' || !fieldId || !CHOICES.has(entry?.decision) || seen.has(fieldId)) bad('DECISION_MAP_INVALID');
    seen.add(fieldId);
    return { fieldId, decision: entry.decision };
  });
  return out.sort((a, b) => (a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0));
}

export const decisionMapHash = canon => sha256Hex(canonical(canon));

/**
 * Exact one-to-one coverage of the AUTHORITATIVE review fields, and no REJECT on
 * anything that cannot be written back. `reviewFields` is the server's own
 * reviewDiff.fields — the browser's list is never consulted.
 */
export function validateDecisions({ decisions, reviewFields }) {
  if ((reviewFields ?? []).some(isStructure)) bad('MIXED_STRUCTURE_UNSUPPORTED');
  const canon = canonicalDecisions(decisions);
  const byId = new Map((reviewFields ?? []).map(field => [field.fieldId, field]));
  if (canon.length !== byId.size || canon.some(entry => !byId.has(entry.fieldId))) bad('DECISION_MAP_MISMATCH');
  const approved = [], rejected = [];
  for (const { fieldId, decision } of canon) {
    const field = byId.get(fieldId);
    if (decision === 'REJECT') {
      if (CANNOT_RESTORE.has(field.restorable) || field.retained === false) bad('FIELD_NOT_RESTORABLE');
      rejected.push(field);
    } else approved.push(field);
  }
  return { decisions: canon, approved, rejected };
}

const clone = value => JSON.parse(JSON.stringify(value));

/** The approved baseline with each APPROVED field's digest replaced by the live one. */
export function targetTreeFor({ baselineTree, currentTree, approved }) {
  const overlay = {};
  const live = new Map((currentTree?.nodes ?? []).map(node => [node.logicalNodeId, node]));
  for (const field of approved) {
    const digest = live.get(field.logicalNodeId)?.digests?.[field.rawFieldId];
    if (digest === undefined) bad('DECISION_MAP_MISMATCH');
    (overlay[field.logicalNodeId] ??= {})[field.rawFieldId] = digest;
  }
  return { targetTree: applyOverlay({ baselineTree, overlay }), overlay };
}

export function applyOverlay({ baselineTree, overlay }) {
  const targetTree = clone(baselineTree);
  for (const node of targetTree.nodes ?? []) {
    for (const [rawFieldId, digest] of Object.entries(overlay?.[node.logicalNodeId] ?? {})) {
      node.digests = { ...node.digests, [rawFieldId]: digest };
    }
  }
  return targetTree;
}

export function planMixed({ decisions, reviewFields, baselineTree, currentTree, controlledFields, fieldsFor }) {
  const valid = validateDecisions({ decisions, reviewFields });
  const { targetTree, overlay } = targetTreeFor({ baselineTree, currentTree, approved: valid.approved });
  let restore;
  try {
    restore = planTreeRestore({ baselineTree: targetTree, currentTree, controlledFields, fieldsFor });
  } catch (error) {
    if (error?.reason === 'BASELINE_VALUES_REQUIRED') bad('FIELD_NOT_RESTORABLE');
    throw error;
  }
  const mapHash = decisionMapHash(valid.decisions);
  return { ...valid, mapHash, overlay, targetTree, restore,
    planHash: sha256Hex(canonical({ mapHash, steps: restore.steps.map(step => step.stepKey) })) };
}

/** What the evidence payload tells the client about the mixed workflow. */
export function mixedEligibility({ baseline, reviewFields }) {
  if (!baseline?.tree_hash) return { eligible: false, reason: 'NOT_TREE_BASELINE', fields: [] };
  if ((reviewFields ?? []).some(isStructure)) return { eligible: false, reason: 'STRUCTURE_CHANGED', fields: [] };
  return { eligible: true, reason: null, fields: (reviewFields ?? []).map(field => ({
    fieldId: field.fieldId, restorable: field.restorable ?? null, retained: field.retained !== false })) };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/mixed-decision.test.js`
Expected: PASS. If `FailClosed` does not expose `.reason`, check `src/lib/errors.js` and adapt the assertions to its field name.

---

### Task 2: First-class MIXED decision (rules, meaning, evidence, storage)

**Files:**
- Modify: `src/lib/decision.js` (`DECISION`, `decide`, `stateAfter` untouched)
- Modify: `src/lib/approval/challenge.js` (`baselineDecisionMeaning`, `challengeContextHash`)
- Modify: `src/lib/approval/record.js` (`DECISION`, `makeApproval`, `evidenceHash`, `validEvidence`)
- Modify: `src/lib/evidence/versionEvidence.js` (`CAUSE.MIXED_DECISION`)
- Modify: `src/db/migrations.js` (append v107), `src/db/approvalStore.js` (columns)
- Test: `test/mixed-approval.test.js` (rules/record part), `test/migrations.test.js`, existing `test/baseline-decision.test.js` must still pass

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `DECISION.MIXED = 'MIXED'`; `baselineDecisionMeaning('MIXED', v) → 'Save drift decisions against baseline v{v}'`; `challengeContextHash({..., prepared})` also hashes `prepared.mixed?.planHash ?? null`; `makeApproval({..., decisionMap, decisionMapHash})` stores `decision_map` (canonical JSON string) and `decision_map_hash`; both are keys of `evidenceHash()` and `validEvidence` requires `binding.decisionMapHash === row.decision_map_hash` (null-safe); `CAUSE.MIXED_DECISION = 'MIXED_DECISION'`.

- [ ] **Step 1: Failing tests**

```js
// test/mixed-approval.test.js (first section)
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, DECISION } from '../src/lib/decision.js';
import { baselineDecisionMeaning, challengeContextHash } from '../src/lib/approval/challenge.js';
import { makeApproval, validEvidence } from '../src/lib/approval/record.js';
import { CAUSE } from '../src/lib/evidence/versionEvidence.js';

test('decide(MIXED) needs drift and always cuts a baseline', () => {
  assert.equal(decide({ decision: 'MIXED', diff: { changedFieldCount: 0 } }).allow, false);
  const r = decide({ decision: 'MIXED', diff: { changedFieldCount: 2, evidenceHash: 'h' }, evidenceHash: 'h' });
  assert.deepEqual([r.allow, r.cutsNewBaseline, r.marksDriftDecided, r.restores], [true, true, true, true]);
  assert.equal(decide({ decision: 'MIXED', diff: { changedFieldCount: 2, evidenceHash: 'h' }, evidenceHash: 'x' }).reason, 'STALE_EVIDENCE');
  assert.equal(DECISION.MIXED, 'MIXED');
});

test('mixed meaning and operation plan hash', () => {
  assert.equal(baselineDecisionMeaning('MIXED', 4), 'Save drift decisions against baseline v4');
  const base = { issue: { statusId: '1' }, transition: null, policy: { meaning: 'm', required_role: 'r', required_assurance: 'ESIGNATURE', capture_baseline: true },
    prepared: { baselineVersion: 1, evidenceHash: 'e' } };
  const a = challengeContextHash({ ...base, prepared: { ...base.prepared, mixed: { planHash: 'p1' } } });
  const b = challengeContextHash({ ...base, prepared: { ...base.prepared, mixed: { planHash: 'p2' } } });
  assert.notEqual(a, b);
  assert.equal(challengeContextHash(base), challengeContextHash({ ...base, prepared: { ...base.prepared, mixed: undefined } }));
});

const proof = (hash) => ({ ok: true, level: 'ESIGNATURE', providerId: 'esignature', evidence: { binding: {
  accountId: 'a', issueId: 1, fromStatusId: '1', toStatusId: '1', contentHash: 'a'.repeat(64), decision: 'MIXED', decisionMapHash: hash } } });
const mixedInput = hash => ({ proof: proof(hash), now: 1, accountId: 'a', contentHash: 'a'.repeat(64), decision: 'MIXED',
  issueId: 1, issueKey: 'T-1', projectId: 1, issueTypeId: '1', actorName: 'N', signerRole: 'r', meaning: 'm',
  fromStatusId: '1', toStatusId: '1', decisionMap: '[{"decision":"APPROVE","fieldId":"a"}]', decisionMapHash: hash });

test('a mixed approval binds its decision map into the evidence', () => {
  const row = makeApproval(mixedInput('h'.repeat(64)));
  assert.equal(row.decision, 'MIXED');
  assert.equal(row.decision_map_hash, 'h'.repeat(64));
  assert.equal(validEvidence(row), true);
  assert.equal(validEvidence({ ...row, decision_map_hash: 'z'.repeat(64) }), false);
  assert.notEqual(row.evidence_hash, makeApproval({ ...mixedInput('i'.repeat(64)), proof: proof('i'.repeat(64)) }).evidence_hash);
  assert.equal(CAUSE.MIXED_DECISION, 'MIXED_DECISION');
});
```

Add to `test/migrations.test.js` (follow its existing style for `v106`): assert a migration with id `v107_approval_decision_map` exists, adds `decision_map` and `decision_map_hash` to `va_approval`, and is last.

- [ ] **Step 2: Run** `node --test test/mixed-approval.test.js test/migrations.test.js` → FAIL.

- [ ] **Step 3: Implement**

`src/lib/decision.js`: `export const DECISION = { APPROVE: 'APPROVE', REJECT: 'REJECT', MIXED: 'MIXED' };` and in `decide()` before the final `return`, after the REJECT branch:

```js
  if (decision === DECISION.MIXED) {
    return { allow: diff.changedFieldCount > 0, ...(diff.changedFieldCount > 0
      ? { decision, cutsNewBaseline: true, marksDriftDecided: true, appliesTransition: false, restores: true }
      : { reason: REFUSE.NO_DRIFT }) };
  }
```

(`diff.changedFieldCount === 0` for MIXED must refuse `NO_DRIFT`; keep the stale-evidence check above it as is.)

`src/lib/approval/challenge.js`:

```js
export function baselineDecisionMeaning(decision, version) {
  if (decision === 'MIXED') return `Save drift decisions against baseline v${Number(version)}`;
  const action = decision === 'REJECT' ? 'Reject changes and restore' : 'Approve changes against';
  return `${action} baseline v${Number(version)}`;
}
```

and add `mixed: prepared.mixed?.planHash ?? null,` to the object hashed by `challengeContextHash` (key omitted-equivalent: when null the existing records' hashes change, so only add the key when present: `...(prepared.mixed ? { mixed: prepared.mixed.planHash } : {})` to keep whole-set hashes byte-identical).

`src/lib/approval/record.js`: add `MIXED: 'MIXED'` to `DECISION`; in `makeApproval` add `decision_map: input.decisionMap ?? null, decision_map_hash: input.decisionMapHash ?? null` before computing `evidenceHash`; append `'decision_map_hash'` to the `evidenceHash` key list **only contributes when non-null** (it already maps null → null; to keep existing whole-set evidence hashes byte-identical, build the key list as `[...base, ...(row.decision_map_hash != null ? ['decision_map_hash'] : [])]`); in `validEvidence` add `&& (b.decisionMapHash ?? null) === (row.decision_map_hash ?? null)`.

`src/lib/evidence/versionEvidence.js`: add `MIXED_DECISION: 'MIXED_DECISION'` to `CAUSE`.

`src/db/migrations.js` (append after v106):

```js
  // A mixed drift decision records exactly which fields were approved and which rejected.
  { id: 'v107_approval_decision_map', sql: `ALTER TABLE va_approval
    ADD COLUMN IF NOT EXISTS decision_map TEXT NULL,
    ADD COLUMN IF NOT EXISTS decision_map_hash CHAR(64) NULL` }
```

`src/db/approvalStore.js`: append `'decision_map','decision_map_hash'` to `columns`.

- [ ] **Step 4: Run** `npm test` → all green (whole-set approval, gate, decision tests must be unchanged).

---

### Task 3: `DRIFT_MIXED` challenge and submit

**Files:**
- Modify: `src/usecases/approval.js`
- Modify: `src/usecases/drift.js` (`prepareApproval` accepts `decisions`)
- Test: `test/mixed-approval.test.js` (usecase section)

**Interfaces:**
- Consumes: `planMixed`, `canonicalDecisions`, `MIXED_INTENT` (Task 1); `DECISION.MIXED`, `makeApproval` decision map (Task 2).
- Produces: `challenge({payload:{intent:'DRIFT_MIXED', decisions, expectedEvidenceHash, issueKey}})` → same `{success, challengeId, nonce, meaning, requiredAssurance, expiresAt}` shape plus `mixed: {approve:[fieldId], reject:[fieldId], evidenceHash}`; `submit` requires the same `decisions` in the payload; `prepareApproval({..., decisions})` returns `prepared.mixed = { planHash, mapHash, decisions, approvedIds, rejectedIds, overlay, restore }`.

Behaviour rules (each becomes a test):
1. `intent: 'DRIFT_MIXED'` ⇒ challenge decision `'MIXED'`, **no transition**, baseline-owned policy exactly as drift APPROVE (`decisionContext` already routes `decision !== REJECT` without a transition; MIXED must take the *no-transition* branch like APPROVE. Change the condition to `if (decision === 'REJECT')`).
2. Missing/duplicate/unknown/extra field → `DECISION_MAP_MISMATCH`/`DECISION_MAP_INVALID`; REJECT on non-restorable field → `FIELD_NOT_RESTORABLE`; structural drift → `MIXED_STRUCTURE_UNSUPPORTED`. All thrown during **challenge**, before any challenge row is written.
3. Submit: recompute the plan from the fresh read; `challengeRow.operation_plan_hash` must equal `challengeContextHash` (which includes `mixed.planHash`) else `CONTENT_CHANGED`; the verified binding gets `decisionMapHash`; `makeApproval` gets `decisionMap` (canonical JSON) and `decisionMapHash`; audit `APPROVAL_RECORDED` payload gains `decisionMap` (canonical array), `approvedCount`, `rejectedCount`.
4. A failed provider verification records nothing (reuse existing path; add the explicit test).
5. `result.mixed = applied.mixed` so the receipt can show counts.
6. Add the new reasons to `DENY` in `src/lib/errors.js` with plain-language copy.

- [ ] **Step 1: Write failing usecase tests** in `test/mixed-approval.test.js` using the `fixture()` pattern from `test/approval-submit.test.js` (copy its helper; `prepare` returns a prepared object containing `reviewDiff: { fields }`, `baselineTree`, `currentTree`, `fields`, `fieldsFor`, and `mixed` computed by calling the real `planMixed`). Add these cases:

  - A challenge followed by submit with the same map records one approval whose `decision === 'MIXED'` and whose `decision_map_hash` equals `decisionMapHash(canon)`. Apply runs once with `approval.decision === 'MIXED'`.
  - The challenge refuses a missing field, unknown field, duplicate, REJECT-on-NOT_RETAINED, and structure drift without calling `writeChallenge`.
  - Submitting a different map from the challenged map returns `CONTENT_CHANGED` and writes no approval row.
  - Replaying a consumed challenge returns `NO_DECISION`.
  - A wrong provider code is refused without calling `deps.record`.
  - Existing whole-set APPROVE/REJECT tests in `approval-submit.test.js` still pass without changes.

- [ ] **Step 2: Run** `node --test test/mixed-approval.test.js` → FAIL.

- [ ] **Step 3: Implement.**

In `approval.js`:
- `challenge`: replace the decision validation with
  ```js
  const mixed = payload.intent === MIXED_INTENT;
  const decision = mixed ? 'MIXED' : payload.decision;
  if (!['APPROVE', 'REJECT', 'MIXED'].includes(decision)) fail('NOT_CONFIGURED');
  ```
  and pass `decision`, plus `decisions: mixed ? payload.decisions : undefined` through `decisionContext → deps.prepare`.
- `decisionContext`: `requestedTransition` stays `decision === 'APPROVE' && ...` (MIXED never takes a workflow transition); change `if (decision !== 'APPROVE') transition = {...}` to `if (decision === 'REJECT') transition = {...}`. Pass `decisions` into the `deps.prepare({...})` call on the baseline-owned path and `fail('NOT_CONFIGURED')` if `decision === 'MIXED'` and `!prepared.baseline`.
- `createChallengePayload({ decision })` receives `'MIXED'`; return `mixed: { approve, reject, evidenceHash: prepared.evidenceHash }` from `prepared.mixed`.
- `submit`: derive `requested` for `decisionContext` as `{ intent: challengeRow.decision === 'MIXED' ? MIXED_INTENT : 'DRIFT' }`, pass `decisions: payload.decisions`, add `decisionMapHash: prepared.mixed?.mapHash` to `binding` (only when mixed so whole-set bindings are byte-identical), pass `decisionMap`/`decisionMapHash` to `makeApproval`, extend the audit payload, and keep `if (applied?.success !== true && !(row.decision === 'REJECT' && applied?.state))` extended to `['REJECT','MIXED'].includes(row.decision)` (a queued restore returns `success:false, state:'RESTORING'`). `result.mixed = applied?.mixed ?? null` and `result.restore = applied` for MIXED too.

In `drift.js` `prepareApproval({ …, decisions })`:

```js
    const mixedPlan = decision === 'MIXED'
      ? planMixed({ decisions, reviewFields: prepared.reviewDiff?.fields ?? [], baselineTree: prepared.baselineTree,
          currentTree: prepared.currentTree, controlledFields: prepared.fields, fieldsFor: prepared.fieldsFor })
      : null;
    if (decision === 'MIXED' && !prepared.baselineTree) fail('NOT_CONFIGURED');
    ...
    if (mixedPlan) prepared.mixed = { planHash: mixedPlan.planHash, mapHash: mixedPlan.mapHash, decisions: mixedPlan.decisions,
      approvedIds: mixedPlan.approved.map(f => f.fieldId), rejectedIds: mixedPlan.rejected.map(f => f.fieldId),
      overlay: mixedPlan.overlay, restore: mixedPlan.restore };
```

and use `decisionDiff` as for APPROVE (the `decide({ decision: 'MIXED', ... })` branch from Task 2). `prepared.plan` stays `null` for MIXED (the mixed plan lives in `prepared.mixed`).

- [ ] **Step 4: Run** `npm test` → green.

---

### Task 4: Apply a mixed decision, queue the restore, capture after verification

**Files:**
- Modify: `src/usecases/drift.js` (`applyApproval` MIXED branch; extract `captureDriftBaseline`, `publishBaselineSideEffects`)
- Modify: `src/usecases/restoreActions.js` (`queueRestore`)
- Modify: `src/jobs/restoreWorker.js`
- Modify: `src/usecases/restore.js` (Retry)
- Test: `test/mixed-restore-worker.test.js`, extend `test/restore-worker.test.js` only if its fakes need the new dep names

**Interfaces:**
- Produces:
  - `queueRestore({ prepared, actor, approval, mixed })`: when `mixed` is given, the plan is `mixed.restore` (not `planTreeRestore(prepared…)`), and `detail = { actionPlan: steps, mixed: { overlay, mapHash } }`.
  - `captureDriftBaseline({ checked, approval, actor, cause })` (extracted verbatim from the tree-capture block in `applyApproval`; returns the `capture` object) and `publishBaselineSideEffects({ capture, checked, approval, actor })` (= `queueVaulting` + `queueLinkDecisions`). `applyApproval` APPROVE keeps calling them in the same order. Keep whole-set behaviour unchanged.
  - Worker dep `captureMixed({ restore, approval, prepared, baseline })` → `{ captured, baselineVersion?, reason? }`.

Behaviour rules:
1. `applyApproval` for `approval.decision === 'MIXED'`: acquire the CAS lock (`RESTORING` when `prepared.mixed.rejectedIds.length`, else `DECIDING`), re-read with `prepareApproval({ decisions })` after the lock, require `checked.mixed.planHash === fresh.mixed.planHash` (else `STALE_EVIDENCE`).
2. **No rejected fields:** capture immediately via `captureDriftBaseline({ cause: CAUSE.MIXED_DECISION })`, `publishBaselineSideEffects`, `markDecided`, return `{ success: true, capture, mixed: counts }`. This is the all-Approve case and creates exactly one new baseline version.
3. **Rejected fields:** `queueRestore({ …, mixed })`; return its queued result (`success:false, state:'RESTORING'`) with `mixed: counts`. The item stays `RESTORING` until the worker finishes. No baseline exists yet.
4. Worker, for an approval whose `decision === 'MIXED'`: allow it (today it throws unless `REJECT`); build `prepared.targetTree = applyOverlay({ baselineTree: prepared.baselineTree, overlay: detail.mixed.overlay })` from the **frozen** overlay (never from live values, so an edit to an approved field after signing fails verification instead of being silently accepted); `defaultVerify` verifies against `prepared.targetTree ?? prepared.baselineTree`; `executeBatch` keeps using the original `baselineTree` for retained values. The finished `detail[0]` carries `mixed` so Retry can find it.
5. Worker after `COMPLETE`/`COMPLETE_WITH_REPLACEMENTS` **and** `MIXED`: if `approvedIds.length > 0`, call `deps.captureMixed`. Success → `markDecided`, release the item as `BASELINED` with zero counters, and ledger `RESTORE_COMPLETED` with `payload.mixed = { approved, rejected, baselineCreated: true }`. If `approvedIds.length === 0`, do not call `captureMixed`; keep the existing v2 baseline active, mark the restore decision complete, release the item as `BASELINED` with zero counters, and ledger `RESTORE_COMPLETED` with `payload.mixed = { approved: [], rejected, baselineCreated: false }`. Capture failure → `release(ERROR)`, ledger `RESTORE_PARTIAL` with `payload.publication = 'INCOMPLETE'`, the `va_restore` row is **not** left looking clean (finish as `PARTIAL` with `last_error: 'BASELINE_PUBLICATION_INCOMPLETE'`), and no `markDecided`.
6. Worker for a non-complete mixed restore: retain the existing `stateAfter` rules and never capture.
7. Retry (`usecases/restore.js`): accept `approval.decision === 'MIXED'`; build `baselineDigests` for `resumable()` from the overlay-applied tree: `approvedDigestsFor({ baseline, baselineTree: applyOverlay({ baselineTree: prepared.baselineTree, overlay }), issueId })`, where `overlay` is read from the restore's `detail`.

- [ ] **Step 1: Failing worker tests** (`test/mixed-restore-worker.test.js`, using the fakes from `test/restore-worker.test.js`): (a) mixed v2 with one approved and one rejected field, verify matches ⇒ `captureMixed` called once after restore verification and produces v3; (b) all-approved mixed decision captures v3 without a restore; (c) all-rejected mixed decision never calls `captureMixed`, keeps v2 active, and completes the restore; (d) verify does not match ⇒ no capture, item `DRIFTED`/`ERROR` per `stateAfter`; (e) `captureMixed` rejects ⇒ `release(ERROR)`, no `markDecided`, ledger payload says publication incomplete; (f) the verify call receives the overlay-applied tree (approved digest present) and the persisted plan, proving only rejected fields are checked against baseline; (g) a REJECT approval never calls `captureMixed` (regression).

- [ ] **Step 2: Run** `node --test test/mixed-restore-worker.test.js` → FAIL.

- [ ] **Step 3: Implement** the rules above. Extraction note: `applyApproval`'s inline `import()` block becomes `captureDriftBaseline`; keep every argument identical so `test/child-baseline-capture.test.js` and `test/drift-functional.test.js` still pass without edits. The worker's default `captureMixed` rebuilds `checked` from its own `prepared` (`issue`, `fields`, `baseline`, `baselineTree`, `projectId`, `ruleScope` from `scopeFromIssue`, `gate` from `baselinePolicy(baseline)` mapped exactly as `prepareApproval` maps it) and reads the live tree with `prepared.reader.read`.

- [ ] **Step 4: Run** `npm test` → green, then `npm run smoke`.

---

### Task 5: Evidence payload, what the client may decide

**Files:**
- Modify: `src/usecases/panelEvidence.js`
- Test: extend `test/panel-state.test.js` (or `test/panel-response.test.js`, whichever already asserts `getEvidence` shape)

**Interfaces:**
- Produces: `evidence.drift.mixed = { eligible, reason, fields:[{fieldId, restorable, retained}] }` from `mixedEligibility({ baseline, reviewFields: attributedReviewDiff.fields })`, using the **viewer-filtered** fields so a hidden descendant is never named. Each field in `drift.fields` already carries `fieldId` (`logicalNodeId:rawFieldId`) as the decision identity.

- [ ] **Step 1: Failing test:** eligible tree baseline ⇒ `mixed.eligible === true` and one entry per visible field; a `tree:NODE_ADDED:*` field ⇒ `{ eligible:false, reason:'STRUCTURE_CHANGED' }`; legacy baseline ⇒ `NOT_TREE_BASELINE`; a field the viewer cannot see is absent from `mixed.fields`.
- [ ] **Step 2: Implement** by importing `mixedEligibility` and adding `mixed:` beside `groups` in the returned `drift` object.
- [ ] **Step 3: Run** `npm test`.

> Server-side note: authorization is **not** relaxed here. Because the challenge's exact-coverage check runs against the server's own *unfiltered authoritative* `prepared.reviewDiff.fields`, a reviewer who cannot see a hidden descendant gets `DECISION_MAP_MISMATCH` for a map that omits it. If that makes the mixed workflow unusable for such a viewer, the UI shows whole-set only (`eligible:false`). Therefore `mixedEligibility` must also return `eligible:false, reason:'HIDDEN_CHANGES'` when the filtered field count differs from `prepared.reviewDiff.fields.length`. Pass both counts in (`mixedEligibility({ baseline, reviewFields, authoritativeCount })`) and add a test.

---

### Task 6: Frontend decision model (pure)

**Files:**
- Create: `frontend/src/review/fieldDecisions.ts`
- Test: `frontend/test/field-decisions.test.mjs` (plain node test importing the `.ts` via `--experimental-strip-types`; no DOM)

**Interfaces:**
- Produces:
  - `type Choice = 'APPROVE' | 'REJECT'`; `type Decisions = Record<string, Choice>` (undecided = absent).
  - `decide(state, fieldId, choice) → Decisions` (idempotent), `reset(state, fieldId)`.
  - `swipe(state, fieldId, direction: 'ltr' | 'rtl')` → `ltr` ⇒ `REJECT`, `rtl` ⇒ `APPROVE` (spec: left-to-right rejects).
  - `key(state, fieldId, key: 'ArrowRight'|'ArrowLeft'|'Enter'|' '|'Escape'|'Backspace')` → same transitions as swipe (ArrowRight = REJECT, ArrowLeft = APPROVE, Escape/Backspace = reset; Enter/Space on an undecided card do nothing, on a decided card they re-confirm).
  - `summary(fields, state) → { approve, reject, undecided, text }` with `text` like `"3 approve · 2 reject · 0 undecided"`.
  - `canSave({ fields, state, mixed, loading, error, eligible }) → { enabled, reason }` disables Save while any field is undecided, evidence is loading/failed/held, the reviewer is ineligible, `mixed.eligible === false`, or any field with `restorable ∈ {NO,NOT_RETAINED}` is set to `REJECT` (reason strings are user-facing sentences).
  - `payload(fields, state) → [{fieldId, decision}]` sorted by `fieldId` (must equal the server's canonical order).
  - `blocked(field) → string | null` the non-restorable explanation ("Its approved value was not kept, so it can't be restored.").

- [ ] **Step 1: Failing tests** covering: swipe directions; key transitions identical to swipe; reset; summary text with all-undecided and mixed; `canSave` for every disabling condition; `payload` order independence and that undecided fields are never emitted; REJECT refused on a non-restorable field (state unchanged and `blocked()` returned).
- [ ] **Step 2: Run** `npm --prefix frontend test` → the new file FAILS (module missing).
- [ ] **Step 3: Implement** as small pure functions; no React.
- [ ] **Step 4: Run** `npm --prefix frontend test` → PASS.

---

### Task 7: Decision track component and DiffView decision mode

**Files:**
- Create: `frontend/src/review/FieldDecisionTrack.tsx`
- Modify: `frontend/src/review/DiffView.tsx`, `frontend/src/ui/product.css` (track styles + `prefers-reduced-motion`)
- Modify: `frontend/src/review/types.ts` (`DiffField.rawFieldId` and `restorable`/`retained` are already present. Add nothing unless typing fails)
- Test: `frontend/test/panel.test.mjs` (render tests, existing harness)

**Interfaces:**
- Consumes: Task 6 functions.
- Produces:
  - `FieldDecisionTrack({ field, choice, onChoose, onReset, blockedReason })` has `role="group"` and an `aria-live="polite"` status line such as "Reject change selected for Summary". Provide **Approve change**, **Reject change**, and **Reset decision** buttons. Support pointer dragging with a 40 px threshold, left-to-right to reject, and right-to-left to approve. Handle `ArrowLeft/ArrowRight/Escape` and show the selected choice in text. Disable Reject for a non-restorable field and show `blockedReason`. Under `@media (prefers-reduced-motion: reduce)` the thumb jumps with no transition.
  - `DiffView` gains optional props `decisions?: { state: Decisions; onChange(next: Decisions): void; mixed: { eligible: boolean; reason: string | null } }`. When present and `mixed.eligible`, the detail pane shows **Approved value** on the left and **Current value** on the right, followed by the decision track. Keep the field name, materiality, retention/restorability badge, and last-editor attribution. The list rows show an "Approve", "Reject", or "Undecided" text badge. Whole-set controls remain outside `DiffView` in the footer `ApprovalControls`. Assert this in a test.
  - A sticky save bar inside `DiffView`: `summary().text` and a **Save changes** button (`canSave`), calling `decisions.onSave()` (added to the prop type).

- [ ] **Step 1: Failing render tests**: track renders all three buttons and live status; clicking Approve/Reject/Reset produces the Task 6 states; ArrowRight ⇒ reject, ArrowLeft ⇒ approve; pointer drag ltr/rtl; non-restorable field disables Reject and shows its reason; Save is disabled until every field is decided, enabled after, and absent when `mixed.eligible === false` (a "Review field by field isn't available: <reason>" note instead); `DiffView` without `decisions` renders exactly as before (existing tests green).
- [ ] **Step 2: Run** `npm --prefix frontend test` → FAIL.
- [ ] **Step 3: Implement** component + props + CSS; reuse existing primitives (`Badge`, `MaterialityBadge`).
- [ ] **Step 4: Run** `npm --prefix frontend test && npm run build:ui` → PASS.

---

### Task 8: Mixed ceremony in `ApprovalControls` and the review window

**Files:**
- Modify: `frontend/src/review/ReviewWindow.tsx` (owns `Decisions` state; clears it when `evidence.evidenceHash` or baseline changes)
- Modify: `frontend/src/panel/sections/ApprovalControls.tsx`, `frontend/src/panel/approvalModel.ts`, `frontend/src/panel/types.ts`
- Test: `frontend/test/panel.test.mjs`

**Interfaces:**
- `PanelEvidence.drift.mixed?: { eligible: boolean; reason: string | null; fields: { fieldId: string; restorable: string | null; retained: boolean }[] }` (types.ts).
- `approvalPayload` gains `intent?: 'WORKFLOW' | 'DRIFT' | 'DRIFT_MIXED'` and `decisions?: {fieldId, decision}[]` (included only when `intent === 'DRIFT_MIXED'`; `decision` omitted for it).
- `ApprovalControls` gains optional `mixed?: { decisions: {fieldId, decision}[]; fields: DiffField[]; evidenceHash: string | null; open: boolean; onClose(): void }`.
  - When `mixed.open` it renders the existing signing sheet in **mixed mode**: heading "Save selected drift decisions"; exact counts; the field names in the Approve set and in the Reject set; the evidence hash being signed (shortened, full in `title`); then the **unchanged** affirmation, TOTP/device control and signed receipt behaviour.
  - Opening the sheet performs **no** challenge: `requestChallenge('MIXED')` runs only from the sheet's existing "Continue"/sign action, sending `{ intent:'DRIFT_MIXED', decisions, expectedEvidenceHash }`; the submit call re-sends the same `decisions`.
  - Failure/cancel (provider error, closing the sheet) leaves `ReviewWindow`'s `Decisions` untouched and calls nothing else.
  - Receipt for a mixed signature shows `"3 approved · 2 rejected"` and both field-name lists; while the restore runs it shows the existing `PROGRESS.restoring` copy, and a baseline-publication failure from the server renders the existing not-clean outcome message (never "Changes saved").
  - Whole-set Approve/Reject buttons and flow are untouched (regression tests).

- [ ] **Step 1: Failing tests** (extend `panel.test.mjs`): clicking Save opens the sheet with no `approval:challenge` call recorded in `globalThis.panelTransport`; signing sends exactly one challenge whose payload equals `{ issueKey, intent:'DRIFT_MIXED', decisions:<sorted>, expectedEvidenceHash }` and one submit with the same `decisions`; a rejected challenge keeps the choices; the receipt text shows the counts and names; whole-set Approve still posts `{ decision:'APPROVE', intent:'DRIFT' }` exactly as before.
- [ ] **Step 2: Run** `npm --prefix frontend test` → FAIL.
- [ ] **Step 3: Implement.** In `ReviewWindow`, build `decisions` for `DiffView` and `mixed` for `ApprovalControls` from `shownEvidence.drift.mixed` and `shownEvidence.drift.fields`; Save sets `mixed.open`; `onDone` refreshes and clears decisions.
- [ ] **Step 4: Run** `npm --prefix frontend test && npm run build:ui` → PASS.

---

### Task 9: Whole-system verification and acceptance notes

**Files:**
- Modify: `docs/acceptance/`. Add `2026-10-07-drift-field-decision-run.md` (a checklist, **not** results: live Forge deploy/install and fresh Jira read-back are a separate gate the user runs).

- [ ] **Step 1:** `npm run verify` (backend tests, UI tests, smoke imports, UI build). Expected: all pass.
- [ ] **Step 2:** `git diff --check` and `npm --prefix frontend run lint`. Expected: clean.
- [ ] **Step 3:** Write the acceptance checklist mirroring the spec's "Verification gates": whole-set decision; mixed decision with ≥1 approved and ≥1 rejected field; fresh Jira read-back of every affected field, baseline version, drift count, audit record, controlled-transition blocking/clearance; failure drills (stale evidence, replay, wrong provider, partial restore, publication failure).
- [ ] **Step 4:** Self-review against the spec section by section; report gaps and the four scope decisions above to the user.

---

## Self-review (against the spec)

- **Two workflows / outside whole-set actions:** Tasks 7–8 (footer controls untouched; regression tests).
- **Comparison layout, track, text/live status, reduced motion:** Task 7.
- **Save disabled states; non-restorable not silently approved; cannot submit incomplete map:** Tasks 6, 7 (client), 1, 3 (server, before authentication).
- **Authentication once, after decisions; failed/cancelled records nothing:** Task 8 + Task 3 test (b)(e).
- **Canonical map, exact coverage, tree identity, hash in plan + audit:** Tasks 1–3.
- **First-class mixed decision, provenance, evidence binding:** Task 2, Task 4 (capture `cause`).
- **Server flow steps 1–10, including no capture before verification and one durable boundary:** Tasks 3–4.
- **Data/API changes (migration preserves whole-set rows, scoped restore, provenance, authorization-filtered):** Tasks 2, 4, 5.
- **Failure/concurrency rules (stale, replay, CAS, partial, publication failure):** Tasks 3–4 tests; the UI never shows "saved" for an incomplete publication.
- **Gaps by design (surfaced to the user):** legacy field-only baselines and structural changes fall back to whole-set; mixed restores always use the queue.

---

## Execution notes (2026-10-07)

All nine tasks are built and verified locally (`npm run verify`: backend 1717, UI 261, smoke 210/210, build ok).
Live acceptance is a separate gate: `docs/acceptance/2026-10-07-drift-field-decision-run.md`. Where the code
diverged from the plan above, and why:

- **Scope decision 4 (revised in the plan before building) is implemented as written.** All-reject creates no
  version; all-approve captures directly; mixed captures once after verification. `decide()` takes an optional
  `approvedCount` so `cutsNewBaseline` is truthful for the all-reject case.
- **Save requests a challenge; it does not open an empty sheet.** Every decision in this app opens its signing
  sheet only once the server has answered a challenge. Doing the same keeps one ceremony and means the whole
  map is validated server-side *before* the reviewer is asked to authenticate. A challenge records nothing.
- **`writeCapturedTreeBaseline` gained `expectedTreeHash`.** It refused to capture unless the live tree hash
  equalled `approval.content_hash`, which for a mixed decision is the signed *candidate*, not the post-restore
  state. The restore worker re-reads the verified tree, names its hash, and the capture is refused if the tree
  moves again before it reads. Whole-set captures never pass it, so they are unchanged.
- **The capture runs before `finishRestore`, inside the worker.** A publication failure therefore finishes the
  restore as `PARTIAL` (with an explanatory `unmatched` entry and `publication: 'INCOMPLETE'`) and the item as
  `ERROR`; it is never recorded as a clean `COMPLETE`. A Retry re-runs verification and the capture.
- **Retry needed no overlay handling** (plan Task 4, rule 7): an approved field's live value equals the signed
  candidate, which `resumable()` already permits, so only the accepted decision kind changed.
- **`mixedPrepared()` was added to the pure module** so `prepareApproval` and the tests share one shape.
- **Node copy preserves non-enumerable `parentLogicalId`.** A JSON/spread copy of a baseline node drops it and
  makes the diff report every node as moved; found by a test fixture, now covered.
- **UI:** the two sides are rendered per field kind (`TwoSided`/`SideBody`); the choices live in `ReviewWindow`
  keyed to the evidence hash; the Save bar is `.va-savebar` (`.va-decision-bar` was already the footer).
