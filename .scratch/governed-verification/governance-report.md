# Task 1: Governing records and closure

Status: ready-for-agent

Implemented modules:

- `src/testmgmt/governance.js`: immutable approval proof checks; ordered role/separation comparison for exception floors; exact mandatory run scope; historical metadata whitelist; `governancePolicyProblem(project)` and `governanceChainDominates(candidate, required)` for admin configuration.
- `src/testmgmt/governanceStore.js`: Forge SQL tables and bounded history reads, immutable body inserts, audited activation with head CAS and recoverable publication; durable frozen evaluations with exact digest/audit-confirmed readback. Exports `createGovernanceStore({query?, maxRecords?})` and `GOVERNANCE_MIGRATIONS` (one DDL statement per migration).
- `src/usecases/testGovernance.js`: full production usecase and authenticated resolver wrappers.
- `test/testmgmt-governance.test.js`, `test/testmgmt-governance-store.test.js`: lifecycle, authorization, stale sources, exception floors, newer unfinished attempts, proof/evidence/defect failures, incomplete histories, activation recovery, immutable dossier, privacy and persistence failure checks.

## Usecase API

`createTestGovernance(deps)` returns:

- `view({issueKey}, actor)` => `{issueId,issueKey,source,complete,records,activeAssignment,activeTarget,evaluations}`. Each described record includes immutable `content`, `digest`, `chain`, `state`, `signatures`, `nextStep:{index,label,role,meaning}|null`, `canSign`, `canFinish`, `proofConfirmed`, `stale`. Incomplete/unreadable related Jira records make `complete:false`; hidden records/dossiers are omitted.
- `prepareAssignment({issueKey,rationale,buildPolicy:{mode:'EXACT'},obligations:[{id,level,method,tests:[{testVersionId,contexts:[{configuration,environment,release:{id,name}|null}]}]}]},actor)` => described draft record. Pins signed versions/digests, source baseline/digest, configured chain and predecessor. All combinations mandatory; bounded to 1,000.
- `prepareTarget({issueKey,assignmentId,executionIssueId|executionIssueKey,reportedBuild,rationale},actor)` => described draft record. Build is a bounded object containing scalar values; identity uses exact canonical equality and is sender-attested.
- `prepareException({issueKey,assignmentId,targetId,runId,evidenceDigest,missingMetadata,rationale},actor)` => described draft record. Allowed metadata names: `reportedBuild`, `classification`, `provenance`; absent historical schema-1 fields only. Requires signed passed valid evidence and exception chain demonstrably dominating pinned and current governing chains.
- `signRecord({recordId,contentHash,code},actor)` => described record or existing signing error object. Uses TOTP signature machinery, actual source project/type eligibility, configured author/signer separation, audit-before-publication and CAS. Repeating after an audited partial publication recovers it; competing drafts cannot replace a successor.
- `evaluate({issueKey,targetId?},actor)` => persisted row with top-level `verdict`, `findings`, and `snapshot`. No `ALLOWED` before storage, audit confirmation, and saved readback. Storage/audit failure => `{evaluationId,verdict:'DENIED',findings:[...,{code:'EVALUATION_NOT_CONFIRMED'}],recorded:false}`. Read source/related Jira authorization failures can throw to deny without disclosure.
- `exportDossier({evaluationId},actor)` => original frozen evaluation row plus top-level verdict/findings, after current Jira visibility checks. Does not rerun historical verdict or require a still-current source baseline.

Resolver exports (each takes `({payload,context}, suppliedDeps?)`): `tmGovernanceView`, `tmPrepareVerificationAssignment`, `tmPrepareClosureTarget`, `tmPrepareEvidenceException`, `tmSignGovernanceRecord`, `tmEvaluateClosure`, `tmExportClosureDossier`.

## Dependency contract

Spread `createGovernanceStore()` plus existing runtime dependencies:

`readIssueAsUser`, optional `getFullIssueAsUser` (preferred for live source read), `readProject`, `getSourceState(issue,{viewer})`, `readVersion`, `verifyVersionProof`, `readRun`, `readRunsForExecutionComplete`, `verifyRunProof`, `verifyEvidence`, `readBlockingDefects`, optional `validateRunPlanningSnapshot`, `assertIntakeReady(run,deps)`, `listSignatures`, optional `recoverSignatures`, optional `hasPendingSignatures`, `isEligibleFor`, `roleHolders`, `recordSignature`, `myself`, `hasIssuePermission`, `audit(event) => {seq,entryHash}`, `now`.

Project settings: `assignmentChain`, `targetChain`, `exceptionChain`, `governanceAuthorSeparation` (default true). Approval kinds are `ASSIGNMENT`, `TARGET`, `EXCEPTION`.

Store functions: `insertGovernanceRecord(record)`, `readGovernanceRecord(recordId)`, `readGovernanceHead({sourceIssueId,kind})` (full active record/null), `readGovernanceRecordsComplete(sourceIssueId)`, `activateGovernanceRecord({recordId,expectedPreviousId,proof,now})`, `insertClosureEvaluation(record)`, `readClosureEvaluation(evaluationId)`, `confirmClosureEvaluation({evaluationId,digest,proof})`, `readClosureEvaluationsComplete(sourceIssueId)`.

## Closure and frozen proof

Selects by positive safe-integer server `attemptSequence` for exact execution/test-version/context. Build is deliberately absent from selection, so a newer blank-build attempt blocks older passing evidence. Invalid/duplicate/missing ordering fails closed. Requires actual recomputed step result and stored result PASSED, signed test/run proof, exact build/classification, available evidence and planning proof, resolved defects/retest provenance, intake readiness and current source/assignment/target. Rechecks source/heads and complete candidate run history before freezing to detect concurrent changes.

Dossier snapshot includes source, governing records with approval meanings/signatures, selected whole run snapshots, exception approvals, current proof/defect/evidence decisions, findings, time and actor, sender-attested identity disclaimer and explicit as-of transition gap. `VERIFIED_WITH_EXCEPTION` names unresolved metadata; it never implies missing identity was proved. Observed transitions remain root-owned independent facts; no timestamp correlation is invented.

## Verification and remaining integration

Focused tests: 26 passed. Final full `npm test`: 2,266 tests passed, 0 failures (5.26 seconds). Parent owns runtime/resolver/migrations/gate/admin wiring and final integrated verification. No deployment, tenant eligibility, live acceptance, commits, or signed tenant changes were performed.

The SQL implementation uses no transactions or multiple-statement writes. Activation may leave an audited signed but unpublished record after interruption; the active head remains authoritative and repeat signing recovers it. The ledger permits repeated activation events sharing a deterministic event identity; no exactly-once audit guarantee is claimed. Closure remains an as-of snapshot with an explicitly acknowledged interval before Jira transition completion.
