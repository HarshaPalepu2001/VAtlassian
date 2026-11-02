# Governed verification senior review

Status: ready-for-agent

Binding design: `spec.md`. Reviewed `review.patch` (3,098 lines, full tracked and added implementation), production source, module report and focused tests. No product/index/HEAD edits, commits or deployments. Full backend suite was reported passing by the parent; I did not rerun it or the full verify pipeline. Findings below describe the submitted review snapshot; the parent is already fixing several concurrently. Recheck the final snapshot before declaring readiness.

**Readiness: not ready for local correctness acceptance until the Critical and Important findings are fixed and covered by production-composition/adversarial regressions.** Tenant installation, eligibility, workflow attachment, deployment and live acceptance remain separate.

## Critical

### C1. Ordinary Jira Bugs silently bypass the governed closure gate

Location: `src/testmgmt/closureGuard.js:9-10`.

The guard exempts every issue whose type equals `defectTypeId`. Governing source preparation does not exempt that type (`src/usecases/testGovernance.js:26`), and ordinary Bugs are SOURCE work items: existing test-management exclusion intentionally identifies automatic bugs through immutable `tm_bug` IDs, rather than excluding the entire Bug type. Consequently a normal Bug can receive an approved assignment and target but transition to Done with no passing mandatory evidence; the guard returns `null` before reading its records.

Reproducer: configure Bug as the automatic defect type; use a non-app-created Bug as the baselined source; approve its assignment/target; leave the mandatory run IN_PROGRESS; invoke the Done closure guard. Read-only probe returned `null` despite the unfinished mandatory run.

Fix: use the same source eligibility rule in preparation and enforcement. Do not exempt all Bugs. If automatic bugs are excluded, identify them through their immutable app-created bug membership. Add a guard regression for a normal Bug source with denied evidence.

## Important

### I1. Production run-proof closures retain the runtime before intake adapters exist

Location: `src/testmgmt/runtime.js:26-31` (reviewed snapshot).

`verifyRunProof` closes over the original `deps`. `governedTestRuntime` returns a new object containing `assertIntakeReady` and receipt stores, without updating that captured object. The real proof implementation calls `assertRunReady(run, deps)`; every machine run has a receipt ID, so the missing readiness adapter makes it return `INTAKE_PENDING` even after a fully applied, audit-confirmed receipt. Machine signatures can complete through the correctly composed signing dependencies, but closure, coverage and failed-run/retest proof cannot accept them. Unit fixtures mutate a single dependency object and miss this production-only difference.

Reproducer: compose the actual runtime, process and sign valid machine evidence, then call the runtime's `verifyRunProof`. Its captured dependencies lack `assertIntakeReady`; proof returns `{ok:false, reason:'INTAKE_PENDING'}`. Parent independently confirmed this and is implementing a real-runtime RED/GREEN regression.

Fix: bind proof/planning wrappers to the final composed dependency object and test actual runtime composition, not only manually assembled module fixtures.

### I2. Historical exceptions cannot qualify actual historical runs

Location: `src/usecases/testGovernance.js:215-217`; `src/testmgmt/store.js:179-206`; `src/testmgmt/intakeStore.js:11`.

All pre-migration runs have null `attempt_sequence`; the new allocator deliberately does not backfill them. Evaluation rejects a mandatory scope containing any such run before selecting an attempt or applying its approved historical metadata exception. The historical exception test leaves a fabricated `attemptSequence:1` on its schema-1 fixture, so it proves a state the migration never establishes. Even a newer schema-2 pass in the same context remains blocked because the check rejects any matching row with unavailable order.

Reproducer: take the historical-exception fixture, remove `attemptSequence` as well as build/classification/provenance, approve the exception and evaluate. Read-only probe returned DENIED solely with `ATTEMPT_ORDER_UNAVAILABLE`.

Fix: provide a trustworthy historical order through an immutable sidecar derived from existing audited run-creation sequence, with all new attempts ordered after that historical epoch. Fail closed on absent/ambiguous creation proof. Do not rewrite signed historical rows, canonical schema-1 content or their digests. Cover real null-sequence historical records and newer replacements, not synthetic historical sequence fields.

### I3. The frozen machine dossier omits the original receipt and its CI logs

Location: `src/usecases/testGovernance.js:220,230-245,258`; `src/testmgmt/intake.js:77-81`.

CI `log` values are deliberately retained only in `receipt.originalPayload`; mapped run steps omit them. The evaluation freezes the selected run and proof decisions but never freezes the validated receipt, original payload or receipt audit proof. Its export therefore contains a payload digest and receipt ID but omits the only stored log bytes in the original CI submission. An exported frozen evidence dossier cannot reconstruct that part of the evidence reviewed by humans, and remains dependent on a separate live receipt lookup.

Reproducer: submit a passing receipt with a nonempty unique `log`, apply and sign it, evaluate and export. The run/dossier has the receipt ID and payload digest, but no receipt payload or log. The read-only dossier probe confirmed that an ALLOWED machine snapshot contains no `originalPayload`.

Fix: freeze a validated immutable receipt snapshot (exact original payload, digest, mappings, provenance, APPLIED progress and matching audit proof) into the evaluation; verify correspondence with the selected run. Export the stored snapshot without fetching or reinterpreting a current receipt. Add a regression that changes/removes the live receipt after evaluation and still exports the original frozen log and proof.

### I4. One execution can be reused for different build candidates

Location: `src/usecases/testGovernance.js:104-107`; `src/usecases/testExecution.js:136-143`; `src/usecases/testIntake.js:103-118,150-152`.

The implementation compares selected runs to the current approved target, but never binds the execution itself to one immutable candidate. Add-run accepts independent build identities; CI batches can replace prepared run identities; and a replacement target can approve a different build using the same execution. A user can complete candidate A, then reuse that execution for candidate B and obtain a new ALLOWED evaluation, contrary to the approved rule that a different candidate uses another execution. Exact target matching alone does not enforce this execution boundary.

Reproducer: prepare/approve target A against execution E and sign its runs; prepare/approve target B against the same E, add newer passing runs bearing B, then evaluate. All current checks can pass while the same execution holds different candidate identities. The parent independently identified this missing boundary.

Fix: establish an audited immutable execution candidate binding, compare all run creation, intake and target preparation/activation against it, and reject a different build until a different execution is used. Define preparation without build metadata explicitly so it cannot preempt or bypass the binding. Test both multiple CI batches and replacement target paths, including concurrent first-binding attempts.

## Minor

### M1. Default governing signatures claim approval of a Test version

Location: `src/usecases/testManagementAdmin.js:60-62,144-147`.

Assignment, target and exception defaults all reuse `DEFAULT_VERSION_CHAIN`, whose explicit meaning is “I approve this test version for official execution.” That meaning is then frozen and signed for a source assignment, candidate closure target or historical metadata exception. The UI correctly displays it, but the default signed declaration describes the wrong subject and does not express the separate governing decision.

Reproducer: configure a new project with defaults, prepare a closure target or historical exception and inspect its signing meaning/dossier.

Fix: define separate default chains with explicit assignment, candidate-target and historical-gap exception meanings; preserve administrator-selected and historical meanings. Add a configuration/default-subject assertion.

## Confirmed boundaries and checks

- Source record chain preflight and signing use the actual source project/issue type; intake management uses the execution's project/type and existing wildcard eligibility semantics.
- Schema-1 `runContent` omits all new metadata keys; existing signed digests are not intentionally rewritten by migrations.
- Positive server sequence selects the latest exact test-version/context without build filtering. Newer unfinished, blank-build evidence blocks an older pass.
- Intake reserves receipt members, tracks application progress, uses audit identity/readback, and blocks all affected run signing until the complete receipt is APPLIED/audit-confirmed. SQL write predicates recheck token/grant revocation and expiry.
- Signed machine review uses the explicit human review meaning and preserves machine attribution; pre-sign corrections retain original values/reasons through history.
- Closure evaluations persist, audit-confirm and read back before ALLOWED. Saved denied evaluations can export; failed persistence denies.
- Observed Jira transitions are independently recorded with no fabricated evaluation correlation. Evaluation export remains historical rather than recomputing current outcomes.

## Declined to judge

Every behavior set aside in this review is listed here; absence from findings is not a claim of live validation.

- Forge deployment eligibility, actual static-webtrigger tier classification, migration application on a tenant, queue delivery limits and retries, installation/consent, live permissions, and real workflow validator attachment: explicitly separate platform/live acceptance work in the approved spec and parent request; no tenant actions were authorized for this review.
- Compatibility of the governed gate's user-scoped readers with automation/unconsented transition actors: the existing validator has app fallback behavior whereas the new evaluation uses the normal user runtime. This needs an explicit runtime/identity acceptance test; this read-only pass did not assert platform execution context from source alone.
- Independent compiler/runner/artifact provenance: explicitly deferred; reported build identity is sender-attested and is correctly described that way.
- Raw JUnit, external URL/artifact fetching, cross-execution aggregation, interchangeable obligations, automatic execution discovery, broad release dashboards and WebAuthn signing: explicitly deferred; they are not required local behavior.
- Precise linkage between validator permission and completed transition: the implementation deliberately records NOT_ESTABLISHED because no verified correlation mechanism is available. Timestamp proximity is correctly not used as proof.
- Mutating or cancelling a receipt after token/grant expiry or revocation: the approved default explicitly stops further processing and preserves historical receipts. This review did not assume authority to resume that receipt with replacement credentials or demand a new cancellation workflow.
- Offline inclusion of every attachment byte, native baseline payload and complete audit-chain ancestry in JSON dossier export: the spec requires a frozen evaluation and proof records; it does not specify a standalone archive of all binary/native records. I3 concerns original submitted CI logs that are otherwise absent from the frozen selected evidence, not a demand to package all external artifacts.
- Performance, large-tenant capacity and validator timeout guarantees: no live benchmark was run; passing unit tests do not establish those claims.
- Changes the parent makes after the original `review.patch`: findings must be reconciled against the final source and regression outputs; this report does not imply a second clean review of those later edits.

## Evidence

Targeted read-only Node probes (no source changes) produced:

```text
historical exception: DENIED [ATTEMPT_ORDER_UNAVAILABLE]
ordinary Bug guard with unfinished required run: null
machine dossier: ALLOWED receipt snapshot? false
```

Existing unit tests were read; the full suite was not rerun. Parent reported the existing 2,266-test backend pass and owns integrated verification and fixes.
