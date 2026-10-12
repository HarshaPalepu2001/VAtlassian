# Recursive Field Review Implementation Plan

**Goal:** Make the existing field-by-field review and Save changes workflow available from any governed work item, with the clicked item as the review root and all visible descendants included recursively.

**Architecture:** Build an effective baseline tree for the clicked review root even when its active row is a field-level child baseline written by a parent capture. Reuse the existing tree diff, mixed decision map, restore worker, assurance ceremony, and tree capture path once that scoped baseline is available. Keep reviewer eligibility and visibility authoritative; never enable a decision from browser-only labels or a hardcoded issue.

**Tech Stack:** Node.js ESM, Forge SQL stores, Jira REST, React/TypeScript frontend, Node test runner, Forge deploy.

**Spec:** `docs/specs/2026-10-07-drift-field-decision-design.md` plus the approved recursive parent/middle/leaf review requirements in this task.

## Global Constraints

- The server remains authoritative for eligibility, visible scope, evidence, field coverage, policy, assurance, locks, writes, and verification.
- Native whole-set Approve changes and Reject and restore remain available outside the diff and keep their current meaning.
- Save changes records no Jira mutation before the existing assurance ceremony succeeds.
- A parent review includes its own fields and every visible descendant; a middle review includes its own subtree; a leaf review includes only itself.
- Hidden or unauthorized descendants must not enter the reviewer-facing field list or decision map.
- Attachment restoration remains out of the live acceptance scope, but the implementation must preserve existing attachment planning and fail-closed behavior.

## Review Focus

- A child baseline written by a parent is field-level but must still produce a recursive scoped review and mixed decision capability; regression: VAT-57-style child baseline exposes per-field controls.
- A middle review must include grandchildren without including siblings or ancestors; regression: scoped baseline tree and grouped review contain exactly the clicked subtree.
- A hidden descendant must not make Save changes appear available; regression: visibility filtering keeps mixed review unavailable when authoritative fields are hidden.
- A mixed child decision with rejected fields must use the existing tree restore worker and publish only after verification; regression: mixed preparation receives an effective tree baseline.
- A field-only legacy baseline with no governing tree must remain whole-set-only rather than fabricate descendant history; regression: no synthetic baseline is created without authoritative provenance.

### Task 1: Baseline provenance and scoped tree construction

**Files:**
- Modify: `src/db/baselineStore.js`
- Create: `src/lib/tree/scopedBaseline.js`
- Test: `test/scoped-baseline.test.js`

**Interfaces:**
- Produces `baselineById(baselineId)` for reading an active/captured baseline row by immutable identity.
- Produces pure `sliceBaselineTree(tree, rootLogicalNodeId)` that keeps the root and descendants only.
- Produces pure `effectiveScopedBaselineTree({ ownBaseline, governingTree, rootLogicalNodeId })` that overlays the clicked item's own field-level record on the governing tree root and returns `null` when provenance is insufficient.

- [ ] **Step 1: Write failing tests** for baseline lookup SQL shape and subtree slicing/overlay, including a missing provenance case.
- [ ] **Step 2: Run `node --test test/scoped-baseline.test.js` and verify the new tests fail for the missing module/behavior.
- [ ] **Step 3: Implement the store query and pure scoped-tree helpers without changing approval behavior.
- [ ] **Step 4: Run the focused test and verify it passes.
- [ ] **Step 5: Run the existing child-baseline test suite and confirm no regression.

### Task 2: Make panel evidence and authorization use the clicked subtree

**Files:**
- Modify: `src/usecases/panelAccess.js`
- Modify: `src/usecases/panelEvidence.js`
- Modify: `src/lib/approval/mixedDecision.js`
- Test: `test/panel-state.test.js`
- Test: `test/mixed-decision.test.js`

**Interfaces:**
- `snapshot()` returns `baselineTree/currentTree/treeDiff/reviewDiff` for any governed review root when authoritative baseline provenance can construct the clicked subtree.
- `mixedEligibility()` accepts an effective baseline-tree capability rather than treating `baseline.tree_hash` as the capability test.

- [ ] **Step 1: Write failing tests** proving a field-level child baseline with a captured parent tree yields a three-field child review, and a middle node includes its descendants but not siblings.
- [ ] **Step 2: Run the focused tests and verify they fail with `NOT_TREE_BASELINE` or missing descendant groups.
- [ ] **Step 3: Wire scoped baseline construction into `snapshot()` using the child’s `captured_by_baseline_id` or an active governing root, then apply existing child-baseline overlay rules.
- [ ] **Step 4: Change mixed eligibility to use the effective scoped tree and preserve the existing hidden/structure/restorability gates.
- [ ] **Step 5: Run focused panel and mixed-decision tests and verify they pass.

### Task 3: Preserve the mixed apply path and prove parent/middle/leaf controls

**Files:**
- Modify: `src/usecases/drift.js`
- Modify: `src/usecases/restoreActions.js` only if the scoped tree contract requires a narrow compatibility change
- Modify: `frontend/src/review/ReviewWindow.tsx` only if the authoritative mixed capability is not already consumed correctly
- Test: `test/mixed-approval.test.js`
- Test: `test/mixed-restore-worker.test.js`
- Test: `frontend/test/panel.test.mjs`

**Interfaces:**
- Existing `mixedPrepared()` remains the single decision-map authority and receives a scoped tree for parent, middle, and leaf reviews.
- Existing tree restore/capture and assurance paths remain the durable write boundary.

- [ ] **Step 1: Write failing regression tests** for mixed preparation from a scoped child baseline and for a map containing fields from a child and grandchild.
- [ ] **Step 2: Run the focused tests and verify the old tree-only refusal is reproduced.
- [ ] **Step 3: Make the smallest compatibility adjustment so mixed apply uses the effective scoped tree, preserving frozen overlay, exact coverage, stale evidence, and assurance checks.
- [ ] **Step 4: Run backend and frontend focused tests and verify the existing field toggles and Save changes render for eligible scoped reviews.

### Task 4: Full verification, deployment, and live acceptance preparation

**Files:**
- Modify: `docs/acceptance/2026-10-08-live-baseline-drift-approval-reject-plan.md`

- [ ] **Step 1: Run backend tests, frontend tests, frontend build, and inspect the complete outputs for failures.
- [ ] **Step 2: Deploy the verified app to the development environment and confirm the tenant install is up to date.
- [ ] **Step 3: Refresh VAT-57 and verify the live child diff shows Description, Priority, Summary, per-field controls, and Save changes without touching any decision control.
- [ ] **Step 4: Verify the parent read-only diff still groups its own fields and descendants, and record any remaining label-scope discrepancy separately.
- [ ] **Step 5: Update the acceptance table with local/deployed/live evidence, then give the user the one-case briefing and exact field decisions to make.

## Completion Checklist

- [ ] Parent, middle, and leaf review scopes are data-derived and recursively grouped.
- [ ] Eligible reviewers see per-field decisions and Save changes at every supported scope.
- [ ] Ineligible or hidden scopes remain fail-closed.
- [ ] Mixed decisions preserve the existing assurance, evidence, restore, and baseline semantics.
- [ ] Backend/frontend tests and build pass.
- [ ] Forge development deployment and live VAT-57 read-back are verified separately.
