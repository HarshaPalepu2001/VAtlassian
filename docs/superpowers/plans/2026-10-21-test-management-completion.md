# Test Management Manual Scope Completion Implementation Plan

> **For agentic workers:** Use test-driven implementation and independent review. The user authorized continuing implementation and explicitly confirmed the remaining manual-testing scope on 21 October 2026.

**Goal:** Repair the reviewed safety failures and deliver the remaining Jira-native manual workflow: plans/sets, datasets/iterations, selective reruns, signed source coverage and execution summary export.

**Architecture:** Extend the existing Forge SQL/Jira-issue implementation. Immutable test versions and runs remain the signing subjects; source and planning snapshots are pinned into records and no later edit rewrites an executed record. All services enforce the viewer's issue access, project mapping, action permissions and revisions. Evidence is retained in the existing Forge Object Store and verified before signing/export.

**Tech Stack:** Existing Node ESM, Forge SQL/Object Store, Jira REST, React/TypeScript, Node test runner. No new external service or dependency is needed.

**Spec:** `docs/superpowers/specs/2026-10-20-test-management-first-design.md`, owner decisions 1–13, and `docs/reviews/2026-10-21-test-management-readiness.md` findings F1–F8.

## Global Constraints

- Preserve the current dirty/untracked implementation; no reset, broad staging, automatic commit, deployment, install or live Jira mutation.
- Work in the existing `VAtlassian` branch because the implementation under review is uncommitted here. A complete pre-edit source snapshot is at `/private/tmp/vat-tm-implementation-baseline`; review only the delta against it.
- Reuse Forge/Jira compute, storage, audit and permissions; no external service or direct user credentials.
- Every official run uses a signed immutable version. Only audit-confirmed signatures count; an uncertain/partial write blocks progression and is recoverable.
- A signed final run never changes; reruns create new executions/runs with provenance.
- Incomplete, hidden, stale or broken evidence never gives a green coverage or complete export result.
- CI/JUnit, imports/migration, AI, the ten-report center and the separate biometric/egress solution remain deferred by the existing owner decisions.
- Local, deploy, install/migration, eligibility and live acceptance remain independent gates.

## Review Focus

1. A signature audit or state write failing mid-request cannot produce an unsigned terminal run or let a countersigner advance.
2. Hidden/cross-project sources, collection members or retest targets must not leak data or count as covered.
3. Dataset, plan, source and test edits preserve old snapshots and make affected coverage stale/suspect.
4. Evidence deletion/corruption and truncated record lists produce explicit blocked/incomplete results.
5. Duplicate requests, uncertain Jira creates and removed workflow validators cannot silently bypass the required proof.

### Task 1: Signature durability and recoverable outcomes

**Files:** `src/testmgmt/signing.js`, `store.js`, `chain.js`, `executionGuard.js`; `src/usecases/testAuthoring.js`, `testRunSigning.js`; signature migration additions; `test/helpers/tm-world.js`, focused signing tests.

**Interfaces:** `recordSignature` inserts PENDING records and promotes to ACTIVE only after the ledger succeeds. Chain readers count ACTIVE signatures; pending attempts are explicitly refused/recoverable. Closure uses CLOSING before NOT_EXECUTED. Outcome settlement is idempotent for versions and runs.

- [x] Write regression cases for F1, F2, F5, pending promotion failure, duplicate signer, signature gap and failed rollback; observe meaningful failures.
- [x] Implement audit-confirmed signature visibility, guarded terminal reads and recoverable version/run outcomes, preserving historic rows without silently asserting old audit proof.
- [x] Replace exhaustive signer matching with bounded matching and test an impossible six-step chain with many holders.
- [x] Run focused tests and the backend suite; record results in the implementation ledger.

### Task 2: Planning and data workflow

**Files:** new `src/testmgmt/planning.js`, `planningStore.js`, `planningMigrations.js`, `src/usecases/testPlanning.js`; `frontend/src/testmgmt/PlanningView.tsx`, `DatasetEditor.tsx`; focused tests and helpers. Shared authoring/execution integration belongs to the root implementer.

**Interfaces:** `normaliseDataset(input)` and `expandDatasetSteps(content)` return bounded, deterministic immutable iterations. `createTestPlanning(deps)` exposes collection view/save/publish/sign and selected-run creation inputs. Collections use mapped Jira PLAN/SET/PRECONDITION identities and canonical SQL revisions. Migrations are exported in a standalone list for root integration.

- [x] Write failing tests for duplicate/invalid parameters, bounded expansion, substitution, stale drafts, collection permissions, cross-project/hidden members and immutable signed selection.
- [x] Implement dataset/editor and collection storage/use case/UI. Plans pin signed test versions, selected release/environment/configurations and ordered required membership; Sets organize tests; reusable preconditions resolve into plan snapshots.
- [x] Include the actual React interfaces and consumer-visible tests; no placeholder controls.
- [x] Run focused verification and report exact integration contracts.

### Task 3: Signed source coverage and summary export

**Files:** new source/coverage modules and SQL store/migrations, `src/usecases/testCoverage.js`, `testSummary.js`, `frontend/src/testmgmt/CoverageView.tsx`, `ExecutionSummary.tsx`, focused tests. Shared resolver/runtime wiring is root-owned.

**Interfaces:** source references in a signed version contain issue/project/site identity, optional baseline ID/version/hash, and source digest. `resolveTestSources(refs, context)` verifies access/current source data. Coverage distinguishes operational/governed, follows the latest terminal run per configuration/release/environment, and never falls back to an older pass. Export is generated from a frozen, complete snapshot with explicit completeness and hash.

- [x] Write failing tests for hidden/cross-project sources, newer rejected/not-executed results, changed source/test/plan/dataset, unresolved defect, missing evidence and pagination truncation.
- [x] Implement source selection/coverage/Suspect decisions and an execution summary with JSON and human-readable download. A source baseline is required only for governed coverage.
- [x] Preserve the Test-owned source association and avoid silently changing the signed source baseline's link policy.
- [x] Run focused tests and report exact authoring/execution hooks plus any remaining cross-cutting integration.

### Task 4: Evidence, defects, workflow health and exact-version review

**Files:** new retained-evidence module/tests; `src/testmgmt/bug.js`, `jira.js`; `src/usecases/testManagementAdmin.js`, `frontend/src/admin/pages/TestManagementPage.tsx`, `frontend/src/testmgmt/TestView.tsx`; `src/jobs/gatecheck.js`; separate migration exports if needed. Shared authoring/run-signing/store/migration entry files are root-owned.

**Interfaces:** `retainEvidence({attachment, issueId, viewer})` returns attachment identity, hash/size/media type and protected reference; `verifyEvidence(entries)` verifies retained bytes, throws on missing/corrupt proof. Bug repair validates mapped type, parent, exclusive run association and navigation links before CREATED. Unknown create results do not permit another create on a merely empty search page.

- [x] Write failing cases for F3, F4, F6–F8, invalid repair, wrong parent, reused defect, lost create with lagging search, throttling and multipage create metadata.
- [x] Implement retained copies/read-back, exact-version rendering, safe repair UI, continuous execution-workflow health and bounded retry/repair semantics.
- [x] Preserve live app identity checks and existing baseline safety checks. Hand new project optional type fields through safely for Task 2.
- [x] Run focused tests and report root-owned hooks and migrations needed.

### Task 5: Integration, datasets, reruns and release-scope proof

**Files:** shared resolver/runtime/migrations, `src/usecases/testExecution.js`, `testAuthoring.js`, content/results modules, panel types/router, execution UI and integration tests.

**Interfaces:** merge task modules into production dependencies; all feature methods must be reachable through the actual Jira panels. Dataset iterations are frozen into the created run and every step result contributes to its signed digest. Selective rerun creates one new execution with chosen prior runs, keeps originals immutable and deduplicates retries. Signed plan/release selection fixes required test versions and configuration scope.

- [x] Integrate migration lists and new type mappings without overwriting earlier dirty changes.
- [x] Write failing journey tests for dataset iterations, plan-driven execution, selective rerun, complete source coverage and summary export; implement the real UI/resolver paths.
- [x] Run `npm run verify`, `forge lint`, review the task-only diff with a fresh reviewer, and fix remaining material findings with regressions.
- [x] Update the acceptance checklist and completion evidence. Do not claim live/customer completion or deploy without a separately authorized acceptance run.


## Completion boundary

All six local implementation tasks are verified. The final candidate passed 2,028 backend tests, 289 UI tests, 255 module imports and the production UI build. Four completed CodeRabbit passes covered the initial manual workflow and native Jira integration; all eleven findings were corrected, and the final follow-up returned zero findings. Governed coverage still requires complete matching Jira link proof at runtime. No deployment, installation, migration execution or live Jira acceptance was performed. CI/import/AI/report-center/biometric-egress work remains outside this implementation scope.

### Task 6: Complete native Jira Verifies and baseline ownership

**Basis:** approved design, “The Verifies link through the whole governance pipeline”, lines 181–194. SQL associations alone do not satisfy the governed coverage contract.

- [x] Add stable typed-link configuration and freeze link type identity into signed source references.
- [x] Implement signed-version outbox/reconciliation, exact Jira link readback and external-edit detection; never mirror draft references.
- [x] Record versioned link policy in new baseline hash/storage; preserve existing v1 baseline hashes and behavior. Only explicit new approval/migration may opt into v2.
- [x] Apply the same policy to capture, live drift, link events, restore and propagation; a v1 source baseline must not silently acquire a new rule.
- [x] Verify operational/governed distinction, source ownership and unknown/incomplete link proof with production-boundary regressions and review.
