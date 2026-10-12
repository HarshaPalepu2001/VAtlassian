# Continuous Review and Scope Assurance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the review timeline scrub freely in either direction, and prove baseline publication and assurance follow the field decision map and baseline that owns the decision scope.

**Architecture:** `ChangeTimeline` will convert a compact slider position to a timestamp and select the latest recorded event at or before that time. The existing backend separates restoration from publication and derives drift assurance from immutable baseline policy; focused regressions will make those contracts explicit for direct rejection, all-rejected maps, mixed maps, parent scope, and child scope.

**Tech Stack:** React and TypeScript, Node.js built-in test runner, Forge backend JavaScript.

**Spec:** `docs/superpowers/specs/2026-10-12-continuous-review-and-scope-assurance-design.md`

## Global Constraints

- The timeline is navigation only: it cannot record a decision, restore content, or create a baseline.
- A direct full-set rejection restores the standing baseline and never publishes a replacement baseline.
- A saved all-rejected field map restores as required and never publishes a replacement baseline.
- A map with one or more approved fields publishes exactly one replacement baseline only after rejected values are restored and freshly verified.
- Incomplete, ambiguous, stale, or changed evidence fails closed; current configuration cannot replace baseline authority.
- Assurance comes from the immutable active baseline owning the exact decision scope, including tree provenance for inherited descendants.

## Review Focus

- Reverse drag immediately below a later event returns to the preceding event; Task 1 adds a forward and reverse floor-semantics test.
- A cursor before the first drift displays no selected event; Task 1 adds that test.
- Several fields at one timestamp remain individually reachable after scrubbing; Task 1 extends the grouped-chip test.
- At-least-once restore delivery after every field is rejected cannot publish a baseline; Task 2 adds the duplicate-delivery test.
- A child with a newer e-signature baseline cannot change a parent decision's biometric policy; Task 3 adds parent-owned, child-owned, and inherited-child policy tests.

---

### Task 1: Replace nearest-event snapping with ordered continuous scrubbing

**Files:**
- Modify: `frontend/src/review/ChangeTimeline.tsx:1-80`
- Modify: `frontend/test/panel.test.mjs:2515-2545`

**Interfaces:**
- Consumes: `fields: DiffField[]`, `baselineAt`, `now`, and `onPick(fieldId)`.
- Produces: a normalized range with `aria-label="Scrub through changes"`; selection is the latest event timestamp less than or equal to the cursor, or no event before the first change.

- [ ] **Step 1: Replace the nearest-event test with forward and reverse cursor checks**

```js
test('the change timeline scrubs chronologically in either direction', async () => {
  const picked = [];
  const fields = [
    { ...scalarField('summary', 'Summary', 'T-1'), attribution: [{ at: 2000, authorName: 'Sam' }] },
    { ...scalarField('priority', 'Priority', 'T-1'), attribution: [{ at: 8000, authorName: 'Priya' }] }
  ];
  await renderInto(h(ChangeTimeline, { fields, baselineAt: 1000, now: 10000, onPick: id => picked.push(id) }));
  const slider = container.querySelector('input[aria-label="Scrub through changes"]');
  await act(() => typeInto(slider, '0'));
  assert.equal(container.querySelector('.va-timeline__selection'), null);
  await act(() => typeInto(slider, '7700'));
  assert.equal(picked.at(-1), 'summary');
  await act(() => typeInto(slider, '7800'));
  assert.equal(picked.at(-1), 'priority');
  await act(() => typeInto(slider, '7700'));
  assert.equal(picked.at(-1), 'summary');
});
```

Use the normalized positions defined by the component so `7700` maps immediately before the later event and `7800` maps at or after it. Keep the same-timestamp chip test and make it scrub before selecting a chip.

- [ ] **Step 2: Run the focused frontend test before changing the component**

Run: `node --test frontend/test/panel.test.mjs --test-name-pattern="change timeline"`

Expected: FAIL. The current nearest-event implementation selects the closest event instead of the event at or before the cursor.

- [ ] **Step 3: Implement normalized conversion and chronological floor selection**

In `ChangeTimeline.tsx`, introduce a fixed slider ceiling and keep dots in timestamp space:

```ts
const SCRUB_MAX = 10_000;
const positionFor = (at: number) => Math.round(Math.min(SCRUB_MAX,
  Math.max(0, ((at - start) / span) * SCRUB_MAX)));
const timeFor = (position: number) => start + ((position / SCRUB_MAX) * span);
const momentAtOrBefore = (at: number) => orderedMoments.reduce<number | null>(
  (selected, [momentAt]) => momentAt <= at ? momentAt : selected, null);
```

Store the range position, not raw epoch milliseconds. `scrubTo` converts position to a time, then calls `onPick` only when `momentAtOrBefore` changes. `pickMoment` stores the exact marker’s normalized position and timestamp. Render `min={0}`, `max={SCRUB_MAX}`, `step={1}`, `onInput`, and `aria-valuetext={formatTimestamp(cursorTime) ?? ''}`. Keep field chips unchanged.

- [ ] **Step 4: Run the focused frontend tests after implementation**

Run: `node --test frontend/test/panel.test.mjs --test-name-pattern="change timeline"`

Expected: PASS. The output covers pre-first state, forward movement, reverse movement, marker selection, and equal-timestamp fields.

- [ ] **Step 5: Commit the self-contained timeline change**

```bash
git add frontend/src/review/ChangeTimeline.tsx frontend/test/panel.test.mjs
git commit -m "fix(review): scrub change timeline chronologically"
```

### Task 2: Lock baseline publication to verified restore outcomes

**Files:**
- Modify: `test/mixed-approval.test.js:8-18`
- Modify: `test/mixed-restore-worker.test.js:48-120`
- Inspect only: `src/lib/decision.js`, `src/jobs/restoreWorker.js`

**Interfaces:**
- Consumes: `decide({ decision, diff, evidenceHash, approvedCount })` and `runRestoreWorker(body, dependencies)`.
- Produces: `cutsNewBaseline === false` for all-rejected maps; `RESTORE_COMPLETED` with `mixed.baselineCreated === false` after verified all-rejected restoration; no `captureMixed` call for direct or all-rejected rejection.

- [ ] **Step 1: Add a decision-map publication table**

```js
for (const [approvedCount, cutsNewBaseline] of [[0, false], [1, true], [2, true]]) {
  test(`mixed decision with ${approvedCount} approved field(s) publishes: ${cutsNewBaseline}`, () => {
    const result = decide({
      decision: 'MIXED', diff: { changedFieldCount: 2, evidenceHash: 'h' },
      evidenceHash: 'h', approvedCount
    });
    assert.equal(result.allow, true);
    assert.equal(result.cutsNewBaseline, cutsNewBaseline);
  });
}
```

Extend the direct `REJECT` worker test to assert `verify` runs against the standing baseline and `capture` never appears before or after `finish`, `decided`, and `release`.

- [ ] **Step 2: Add all-rejected duplicate-delivery coverage**

```js
test('duplicate delivery of an all-rejected restore cannot publish a baseline', async () => {
  const f = fixture({ detail: mixedDetail({ overlay: {}, approved: [], rejected: ['root:summary', 'root:description'] }) });
  const first = await runRestoreWorker(body, f);
  const second = await runRestoreWorker(body, f);
  assert.equal(first.state, 'COMPLETE');
  assert.notEqual(second.state, 'PARTIAL');
  assert.deepEqual(f.calls.filter(call => call === 'capture'), []);
  assert.equal(f.appended.filter(event => String(event.eventType).includes('RESTORE_COMPLETED')).length, 1);
});
```

Match the worker’s documented terminal-idempotency result for the second delivery, while keeping the no-capture and one-completion-event assertions.

- [ ] **Step 3: Run lifecycle tests before changing production code**

Run: `node --test test/mixed-approval.test.js test/mixed-restore-worker.test.js`

Expected: the new checks either pass against the existing lifecycle implementation or identify a specific idempotency or event guard violation. Do not change production code unless a check exposes a contract violation.

- [ ] **Step 4: Correct only a demonstrated lifecycle violation**

If duplicate delivery reaches publication, guard terminal state before `captureMixed` in `runRestoreWorker` and retain the durable claim as authority. If an all-rejected map reaches `captureMixed`, preserve the `mixed.approved.length === 0` `NOT_NEEDED` branch. Do not add a client-provided publication flag.

- [ ] **Step 5: Rerun lifecycle tests**

Run: `node --test test/mixed-approval.test.js test/mixed-restore-worker.test.js`

Expected: PASS. Direct rejection restores and never captures; all rejection verifies and never captures; a map with approvals captures only after verification; failed verification and capture remain non-clean.

- [ ] **Step 6: Commit lifecycle coverage and any minimal repair**

```bash
git add test/mixed-approval.test.js test/mixed-restore-worker.test.js src/lib/decision.js src/jobs/restoreWorker.js
git commit -m "test(drift): lock baseline publication to approved fields"
```

Stage only files changed by this task.

### Task 3: Prove immutable assurance follows parent, owned-child, and inherited-child scope

**Files:**
- Modify: `test/drift-functional.test.js:290-320`
- Modify: `test/child-baseline-decisions.test.js:45-170`
- Inspect only: `src/usecases/drift.js:65-145`, `src/lib/tree/childBaselines.js:20-120`, `src/jobs/restoreWorker.js:225-255`

**Interfaces:**
- Consumes: `prepareApproval({ issue, actor, decision, expectedEvidenceHash })`, `baselinePolicy(baseline)`, and `withChildBaselines({ parentBaseline, baselineTree, activeBaselines, readAllValues, readBaselineTree })`.
- Produces: a challenge and any replacement baseline policy whose `requiredAssurance` is from the active baseline governing the selected scope.

- [ ] **Step 1: Add parent-scope baseline-policy coverage**

```js
test('a parent drift decision keeps biometric policy when a child later owns e-signature content', async () => {
  const f = fixture();
  f.baselines[0].required_assurance = 'BIOMETRIC';
  f.policy = { ...f.policy, required_assurance: 'ESIGNATURE' };
  const prepared = await prepareApproval({
    issue: { ...f.issue, id: '10' }, actor: { accountId: 'trusted' }, decision: 'APPROVE'
  });
  assert.equal(prepared.approvalPolicy.required_assurance, 'BIOMETRIC');
  assert.equal(prepared.gate.required_assurance, 'BIOMETRIC');
});
```

Extend the fixture with a child-owned baseline that has `required_assurance: 'ESIGNATURE'` and a later capture time. The parent test must still prepare from the parent active baseline and ignore the mutable `f.policy`.

- [ ] **Step 2: Add direct-child and inherited-child ownership coverage**

```js
test('ownership separates a later child baseline from inherited parent content', () => {
  const parent = { ...parentBaseline, required_assurance: 'BIOMETRIC', captured_at: 1000 };
  const owned = { ...own, required_assurance: 'ESIGNATURE', captured_at: 2000, captured_by_baseline_id: null };
  const inherited = { ...own, required_assurance: 'ESIGNATURE', captured_at: 999, captured_by_baseline_id: null };
  assert.equal(ownsItsContent(owned, parent), true);
  assert.equal(ownsItsContent(inherited, parent), false);
});
```

Add direct child preparation coverage that asserts `requiredAssurance === 'ESIGNATURE'`, and inherited-child preparation coverage that asserts `requiredAssurance === 'BIOMETRIC'`. Set a conflicting live transition policy in both tests and assert it is ignored.

- [ ] **Step 3: Run scope-policy tests before modifying backend code**

Run: `node --test test/drift-functional.test.js test/child-baseline-decisions.test.js`

Expected: the tests establish the resolver’s behavior. A failure identifies whether `prepareApproval`, ownership resolution, or mixed-capture mapping loses the governing baseline.

- [ ] **Step 4: Correct only the violated policy handoff**

For parent scope, retain `baselinePolicy(active)` in `prepareApproval` and pass it to `snapshot` as `authorityPolicy`. For direct child scope, resolve the child’s active baseline before `baselinePolicy`. For inherited child scope, retain parent provenance and policy. In `defaultCaptureMixed`, continue deriving `gate.required_assurance` from `baselinePolicy(baseline)` rather than current configuration.

- [ ] **Step 5: Rerun scope-policy tests**

Run: `node --test test/drift-functional.test.js test/child-baseline-decisions.test.js`

Expected: PASS. Parent scope is biometric, direct child scope is electronic signature, inherited child scope is biometric, and conflicting live configuration changes none of them.

- [ ] **Step 6: Commit assurance scope coverage and any minimal repair**

```bash
git add test/drift-functional.test.js test/child-baseline-decisions.test.js src/usecases/drift.js src/lib/tree/childBaselines.js src/jobs/restoreWorker.js
git commit -m "test(approval): protect baseline-owned assurance scope"
```

Stage only files changed by this task.

### Task 4: Run integrated verification and inspect the change set

**Files:**
- Inspect: `frontend/src/review/ChangeTimeline.tsx`, `frontend/test/panel.test.mjs`, `test/mixed-approval.test.js`, `test/mixed-restore-worker.test.js`, `test/drift-functional.test.js`, `test/child-baseline-decisions.test.js`

**Interfaces:**
- Consumes: task outputs.
- Produces: local verification evidence only; it does not establish live Jira or assurance-provider acceptance.

- [ ] **Step 1: Run focused suites together**

Run: `node --test test/mixed-approval.test.js test/mixed-restore-worker.test.js test/drift-functional.test.js test/child-baseline-decisions.test.js && node --test frontend/test/panel.test.mjs`

Expected: PASS with no duplicate publication or changed assurance assertion.

- [ ] **Step 2: Run repository verification**

Run: `npm run verify`

Expected: PASS. Record any pre-existing warning separately from a test failure and do not expose sensitive command output.

- [ ] **Step 3: Inspect only task-owned diffs and staged files**

Run: `git diff --check && git status --short && git diff HEAD -- frontend/src/review/ChangeTimeline.tsx frontend/test/panel.test.mjs test/mixed-approval.test.js test/mixed-restore-worker.test.js test/drift-functional.test.js test/child-baseline-decisions.test.js`

Expected: no whitespace errors; unrelated workspace changes remain unstaged and untouched.

- [ ] **Step 4: Commit only a final task-owned repair, if one exists**

```bash
git add frontend/src/review/ChangeTimeline.tsx frontend/test/panel.test.mjs test/mixed-approval.test.js test/mixed-restore-worker.test.js test/drift-functional.test.js test/child-baseline-decisions.test.js
git commit -m "test(review): verify scoped decisions and restore publication"
```

Do not create an empty commit.

## Self-Review

**Spec coverage:** Task 1 covers two-way read-only navigation. Task 2 covers direct rejection, all-rejected saves, approvals, verification, publication ordering, and duplicate delivery. Task 3 covers parent, owned-child, and inherited-child policy ownership and rejects mutable-policy substitution. Task 4 provides focused and repository-wide evidence without claiming live acceptance.

**Placeholder scan:** Every task names concrete files, interfaces, commands, and expected behavior.

**Type consistency:** The timeline retains `onPick(fieldId: string)`. Backend tests use existing `decide`, `runRestoreWorker`, `prepareApproval`, `baselinePolicy`, and child-baseline ownership contracts.

**Review Focus:** Each listed interaction or failure condition is exercised by the owning task.
