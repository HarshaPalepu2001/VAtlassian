# Governed verification implementation plan

> Use the superpowers execution, TDD, parallel-agent and verification skills. Approved design: spec.md. Work in this checkout, preserve existing untracked acceptance material, do not commit or deploy.

**Goal:** Baseline → approved assignment → candidate execution → reviewed CI evidence → fail-closed closure → frozen dossier.
**Architecture:** Extend existing signed test/run models with separate governance and intake modules. Reuse current TOTP signing and audit ledger. Existing schema-1 content remains byte compatible. SQL records use immutable payloads and CAS activation; complete bounded reads fail closed.
**Tech stack:** Node ESM, Forge SQL/events/static webtrigger, existing React/TypeScript UI.

## Global constraints

- Follow every rule in spec.md, including source-scope authorization for assignments, targets and exceptions; execution scope for grants.
- No affected run signable before receipt APPLIED and audit-confirmed. Recheck token and grant before queued writes.
- Every mandatory combination must select latest server sequence, even if unfinished or without build identity. Only SIGNED PASSED qualifies.
- Exceptions waive only named absent historical metadata; never outcome, mismatches, drift, proof, retest, or defects.
- Persist and audit-confirm evaluations before ALLOWED. Export immutable evaluations. Transition observation has no claimed linkage without verified correlation.
- No external fetches, raw JUnit, automatic run discovery, cross-execution aggregation, or WebAuthn claim.

## Review focus

Unauthorized source versus execution scopes; retry after audit/partial failure; newer blank-build attempt; revoked token after queueing; old digest preservation.

### Task 1: Governing records and closure
Files: new src/testmgmt/governance*.js, src/usecases/testGovernance.js, test/testmgmt-governance*.test.js.
Interfaces: createTestGovernance(deps) with view({issueKey},actor), prepareAssignment(payload,actor), prepareTarget(payload,actor), prepareException(payload,actor), signRecord(payload,actor), evaluate(payload,actor), exportDossier(payload,actor); createGovernanceStore() and GOVERNANCE_MIGRATIONS. Source subject authorization uses actual source issue and configuration, never execution type. Runtime adapter composed by parent.
- [x] Write/run failing lifecycle and adversarial closure tests.
- [x] Implement immutable records, configured approval chains/separation, audited activation, fail-closed evaluation, frozen export.
- [x] Run focused tests and report exact APIs/remaining integration.

### Task 2: CI intake, grants, receipt recovery and attempt ordering
Files: new src/testmgmt/intake*.js, src/usecases/testIntake.js, src/jobs/ciIntake*.js, src/testmgmt/store.js and reportStore.js only run metadata portions, tests. Do not edit content.js, runtime.js, migrations.js or manifest.yml; export migration arrays and manifest snippets.
Interfaces: createTestIntake(deps); metadata fields attemptSequence (server SQL sequence), evidenceSchema:2, classification, reportedBuild, provenance, intakeReceiptId. Export assertIntakeReady(run,deps) enforcing all-or-nothing readiness. Functions for tokens/grants UI and handler/worker; exact APIs reported to parent. Store run ordering is server-assigned at insertion, before build exists. Generic shared immutable run digest extension owned by parent.
- [x] Write/run failing token/grant, idempotency, mapping, partial-write and recovery tests.
- [x] Implement bounded JSON, machine attribution, preserved original payload, rechecks, audit confirmation, recoverable writes.
- [x] Run focused tests and report migrations/runtime/handler details.

### Task 3: Jira user interfaces
Files: frontend/src/testmgmt/GovernanceView.tsx, IntakeControls.tsx, integration in TestPanel/ExecutionView/types, frontend tests. Parent owns content/signing/backend wiring.
Interfaces: tmGovernanceView, tmPrepareVerificationAssignment, tmPrepareClosureTarget, tmPrepareEvidenceException, tmSignGovernanceRecord, tmEvaluateClosure, tmExportClosureDossier; intake APIs coordinated with task 2.
- [x] Write/run failing UI tests for approval meanings, machine provenance and missing metadata.
- [x] Add source governing-record UI, candidate target and intake controls, authenticated receipts and frozen dossier download, separate gate permission/transition wording.
- [x] Run UI tests/type build.

### Task 4: Integrate execution signing, gate, settings and runtime
Files: content.js, testExecution.js, testRunSigning.js, runtime.js, migrations.js, manifest.yml, resolver, approval runtime/gate and trigger as needed, admin UI/usecase.
- [x] Run failing regression tests for schema-1 preservation, review meaning and unresolved receipt signing block.
- [x] Wire new stores, migrations, resolvers, static trigger/worker, closure guard and observation; configure separate chains.
- [x] Add integration tests for success and denied closure, audit/storage failure.
- [x] Run npm run verify and review final diff against approved spec. Forge lint attempted but blocked by expired credentials; offline schema validation reported only the existing wildcard warning. Keep deployment/eligibility/live acceptance explicitly separate.
