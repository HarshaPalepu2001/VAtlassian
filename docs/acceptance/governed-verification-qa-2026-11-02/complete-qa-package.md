# Governed verification — complete QA package

# Governed verification QA handover

Epic: Governed verification — candidate evidence to auditable closure.
Work item: Hand over the implemented candidate for controlled QA.
Candidate source: `2fc3b05d145cf4a8c20463123217a6238196941e`. Prepared 2026-11-02.

Development code is committed; the test design package contains 15 requirements, 12 scenarios and 28 cases. Live execution is NOT STARTED. Formal Ready for Testing requires test-plan.md entry gates E1–E7; deployment is not established by this package.

- [Requirements and coverage](requirements.md)
- [Scenario inventory](scenarios.md)
- [Detailed cases](test-cases.md) and [structured cases](test-cases.json)
- [Synthetic fixtures](fixtures.md)
- [Test plan, entry/exit criteria, risks and defect/retest process](test-plan.md)
- [Execution register](execution-register.md)
- [Summary template](test-summary-template.md)
- Implementation evidence: ../governed-verification-2026-11-02.md

Native Jira work items and app-native signed Test definitions, plan membership, prepared runs, Verification Assignment and human approvals are distinct. Jira descriptions or attached documents are design records only. Native app setup must be completed and verified once the deployed controls are available. See jira-records.md for saved Jira keys and preparation boundaries.

Saved Jira epic: https://mgtechdemo.atlassian.net/browse/VAT-102. Development handover: VAT-103; requirements: VAT-104; plan: VAT-105; prerequisites: VAT-106; execution: VAT-107; TestCase drafts: VAT-108–VAT-135. Attachment upload was blocked by Chrome file-URL permissions; this folder is the complete local deliverable.


---

# Jira preparation records

Created 2026-11-02 on mgtechdemo.atlassian.net. Save results were observed in Jira; final read-back is recorded below after verification.

| Role | Key |
| --- | --- |
| Epic | VAT-102 |
| Development handover | VAT-103 |
| Requirements baseline draft | VAT-104 |
| Test plan draft | VAT-105 |
| Entry prerequisites | VAT-106 |
| Unstarted execution | VAT-107 |
| GV-TC-01 | VAT-108 |
| GV-TC-02 | VAT-109 |
| GV-TC-03 | VAT-110 |
| GV-TC-04 | VAT-111 |
| GV-TC-05 | VAT-112 |
| GV-TC-06 | VAT-113 |
| GV-TC-07 | VAT-114 |
| GV-TC-08 | VAT-115 |
| GV-TC-09 | VAT-116 |
| GV-TC-10 | VAT-117 |
| GV-TC-11 | VAT-118 |
| GV-TC-12 | VAT-119 |
| GV-TC-13 | VAT-120 |
| GV-TC-14 | VAT-121 |
| GV-TC-15 | VAT-122 |
| GV-TC-16 | VAT-123 |
| GV-TC-17 | VAT-124 |
| GV-TC-18 | VAT-125 |
| GV-TC-19 | VAT-126 |
| GV-TC-20 | VAT-127 |
| GV-TC-21 | VAT-128 |
| GV-TC-22 | VAT-129 |
| GV-TC-23 | VAT-130 |
| GV-TC-24 | VAT-131 |
| GV-TC-25 | VAT-132 |
| GV-TC-26 | VAT-133 |
| GV-TC-27 | VAT-134 |
| GV-TC-28 | VAT-135 |

Case drafts use Jira TestCase descriptions with three explicit action/expected-result steps, Manual automation status, System test level and epic parent. These are design records, not app-native signed Test definitions, plan membership or prepared runs. Cases remain NOT RUN. Source requirements/assignment/target/test-version approval and run preparation must be completed by eligible humans on the deployed candidate.

Formal Ready for Testing is pending E1–E7. The workflow status is not proof of deployment/QA readiness. No live pass/fail, personal signature, source-baseline mutation, CI token/grant creation or deployment was performed.

## Final saved read-back

Epic VAT-102 shows all 28 TestCase children, plus development story VAT-103, plan VAT-105 and execution VAT-107. Requirements VAT-104 and prerequisites VAT-106 have ordinary relates-to links to the epic. All 15 requirement IDs were observed in VAT-104. Every case body was read back with its case ID, action/expected-result structure and NOT RUN notice. Four duplicate bodies encountered during rich-text editing were removed and the corrected three-step bodies read back.

Attachment upload was blocked by Chrome extension file-URL access. Browser settings were not changed; files remain local. The epic records this limitation and the complete local package paths. Native signed definitions, plan membership, prepared runs and human approvals remain unestablished. Development story remains In Review; formal Ready for Testing is pending entry gates, not implied by local tests.


---

# Governed verification requirements and traceability

Candidate source commit: `2fc3b05d145cf4a8c20463123217a6238196941e`. Derived from committed implementation and accepted feature specification; QA baseline v1 is DRAFT FOR REVIEW, not a human-signed requirement baseline. No live pass is asserted.

| ID | Requirement | Acceptance oracle | Source under src/testmgmt | Cases |
| --- | --- | --- | --- | --- |
| R01 | Source-scoped approval | Assignment, closure target and exception authorization uses the source project/type; enforce configured author separation. | governance.js | GV-TC-01, GV-TC-02 |
| R02 | Pinned mandatory obligations | Assignment pins current baseline/digest, exact signed Test versions and every mandatory level/method/context combination. | governance.js | GV-TC-03, GV-TC-04 |
| R03 | Safe replacement and drift | Draft replacement preserves the active assignment; audited activation rejects stale replacements; changed source invalidates qualification. | governance.js | GV-TC-04, GV-TC-05 |
| R04 | One execution per candidate | First candidate identity is immutable and audit-confirmed across manual and CI paths; a different candidate needs a new execution. | governedRuntime.js | GV-TC-06, GV-TC-07 |
| R05 | Exact authorized CI intake | Hashed project token and expiring grant bind installation/project/execution/exact prepared run/version/steps/iterations; recheck authority at writes. | intake.js | GV-TC-08, GV-TC-09, GV-TC-10 |
| R06 | Bounded static interface | Accept bounded JSON only; fixed acknowledgments do not expose secrets/results; no submitted URL fetching, raw JUnit or uploaded CI evidence. | intake.js | GV-TC-11, GV-TC-12 |
| R07 | Immutable idempotent receipts | Preserve original bytes/digest/machine attribution; identical byte retries reuse receipt; conflicting bytes under same key fail. | intake.js | GV-TC-13 |
| R08 | Recoverable receipt-wide readiness | Per-run progress supports redelivery; all members remain unsignable until entire receipt is APPLIED and audit-confirmed; expired/revoked authority stops writes. | intakeStore.js | GV-TC-10, GV-TC-14, GV-TC-15 |
| R09 | Explicit human review | Human review meaning identifies machine-recorded results; corrections require reasons and preserve originals; signed failure follows defect safeguards. | governedRuntime.js | GV-TC-16, GV-TC-17 |
| R10 | Latest-attempt closure | Use server sequence in exact Test-version/context scope without filtering build; new unfinished/failed/rejected/cancelled attempts block older passes; incomplete or ambiguous order denies. | governance.js | GV-TC-18, GV-TC-19 |
| R11 | Complete qualifying proof | Every obligation needs signed PASSED current proof, target identity, evidence, resolved blockers and valid retest; missing/inaccessible/incomplete data denies. | governance.js | GV-TC-20, GV-TC-21 |
| R12 | Narrow historical exceptions | Only permitted absent schema-1 metadata on otherwise valid signed passed evidence is waivable; both approval floors apply; do not rewrite signed historical bytes. | governance.js | GV-TC-22, GV-TC-23 |
| R13 | Durable closure evaluations | Persist, audit-confirm and read back immutable evaluation before ALLOWED; failures deny; recorded denials are exportable. | governanceStore.js | GV-TC-24, GV-TC-25 |
| R14 | Frozen authorized dossiers | Export exact frozen evaluation, proofs, meanings, receipts/log bytes and exceptions; authorize every mapped Test including nonmandatory members. | governance.js | GV-TC-25, GV-TC-26 |
| R15 | Workflow and observation boundary | Enabled va-gate guards intended Done routes; actual Jira transition is a separate audited observation; do not infer correlation from timestamps. | governanceObservation.js | GV-TC-27, GV-TC-28 |

All cases identify their requirement IDs in test-cases.json. Additional cross-coverage is recorded there. Out of scope: raw JUnit, cross-execution aggregation, interchangeable obligations, independent build attestation, equivalent WebAuthn ceremony, app-wide Runs on Atlassian eligibility and production performance certification.


---

# Test scenarios

- S01: Authorization and issue security; cases GV-TC-01, GV-TC-02.
- S02: Governing approvals, replacements and source drift; cases GV-TC-03, GV-TC-04, GV-TC-05.
- S03: Immutable candidate identity; cases GV-TC-06, GV-TC-07.
- S04: Exact CI scope and mapping; cases GV-TC-08, GV-TC-09, GV-TC-10.
- S05: Input boundaries and static endpoint; cases GV-TC-11, GV-TC-12.
- S06: Idempotency and recoverable readiness; cases GV-TC-13, GV-TC-14, GV-TC-15.
- S07: Human review, failure and retest; cases GV-TC-16, GV-TC-17.
- S08: Latest-attempt ordering and races; cases GV-TC-18, GV-TC-19.
- S09: Proof completeness and defects; cases GV-TC-20, GV-TC-21.
- S10: Historical exceptions and integrity; cases GV-TC-22, GV-TC-23.
- S11: Durable evaluations and frozen export; cases GV-TC-24, GV-TC-25, GV-TC-26.
- S12: Workflow enforcement and observation; cases GV-TC-27, GV-TC-28.


---

# Governed verification QA plan v1

Prepared: 2026-11-02. Candidate source commit: `2fc3b05d145cf4a8c20463123217a6238196941e`.
QA design: prepared for review. Development: committed. Live execution: NOT STARTED; entry gates pending. This handover does not certify deployment or acceptance.

## Objective and scope
Prove the epic's complete chain from approved baseline to approved assignment, exact candidate CI results, human-reviewed evidence, enforced closure and frozen dossier. Cover all 15 requirements, 12 scenarios and 28 detailed cases, including each listed variant. requirements.md maps requirements to cases; test-cases.json is the structured inventory.

## Entry gates
E1. Capture actual deployed Forge environment/version, build artifact or deployment receipt and source commit; confirm it contains this candidate. Current source commit alone does not prove deployment.
E2. Authenticated Forge lint, migrations/cutoff, installation and consent verified; capture success/read-back. Prior record reports expired Forge credential and deployment not run; refresh status live before execution.
E3. Assign test executor, independent QA reviewer, source approval authority and deployment owner. Names are UNASSIGNED; do not infer assignments from issue reporter.
E4. Publish/verify intended source and execution Done workflow validators; record every relevant route and actor identity/authorization.
E5. Create isolated synthetic fixtures, supported fault/recovery controls, approved reset method, signed Test versions and approved source baseline/assignment/target. Human signatures are human actions. Cases needing unavailable genuine legacy fixtures or fault controls remain BLOCKED.
E6. Confirm endpoint and queue delivery, exact token/grant/run mappings and evidence retention/read-back; keep secrets out of test artifacts.
E7. Review/approve QA requirements and case oracles, configuration and build identity, risks and independent review chain. Draft Jira descriptions/links do not constitute signed VAtlassian definitions or plan membership.

## Run sequence
1. Entry checklist and UI smoke: source governance, execution CI tab, approvals, refresh and safe diagnostics; inability to load a required panel blocks dependent cases.
2. GV-TC-01–05 authorization and governance; GV-TC-06–07 candidate binding.
3. GV-TC-08–15 intake, mapping, boundary, idempotency and recovery.
4. GV-TC-16–17 human review and defect/retest.
5. GV-TC-18–24 closure negative paths, historical exceptions and storage faults.
6. Repeat full positive chain GV-TC-03 with actual tenant Done and GV-TC-25–28 export/workflow observation.
Run destructive fault variants only in the isolated approved harness. Rerun affected cases on a changed candidate using a new execution; preserve failures.

## Configuration matrix
Record tenant/project/source issue type, installation/Forge environment/version, deployed candidate identity, browser/version, source digest, Test version/step/dataset revisions, level/method/context, role grants/chains/meanings, workflow revision/route, token/grant expiry and queue receipt state. Test same-context latest attempt and distinct mandatory contexts. Include human and supported automation actors. Chrome desktop is the initial QA UI target; additional browser support and production capacity require their own agreed matrix.

## Result and evidence protocol
For each case and variant record PASS, FAIL, BLOCKED or NOT RUN with actual observations, environment/build, actor/time, source/assignment/target/execution/run/receipt/evaluation IDs, original payload SHA-256, step results, sanitized request/response and screenshots/export hashes. No populated actual result means NOT RUN. PASS requires every expected assertion and durable read-back. A failed prerequisite is BLOCKED, not a product pass. Preserve original CI attribution and logs. Evidence retention follows tenant policy; copy no credentials or tokens into Jira.

## Defects and retest
File an observed defect with case+variant, requirement, precise reproduction, expected/actual, build/environment, evidence and reproducibility. P0: unauthorized closure, integrity/data exposure, fallback to old pass or lost/duplicated evidence; blocks exit. P1: required path unusable or important oracle fails; blocks exit unless explicit risk decision. Never file planned negative-path denial as defect. Link existing duplicates. After fix, create a new candidate execution, repeat failing case, adjacent boundary cases and full positive chain; preserve failed execution and compare fixed build identity.

## Exit gates
Every required case and variant executed on the identified candidate; 100% requirement coverage with retrievable evidence; no unresolved P0/P1 defect or blocked mandatory case; allowed and denied gate outcomes verified on published routes; independent QA review and required human signatures complete. Any justified deferral requires named owner, rationale and explicit acceptance scope; it cannot waive governed closure proof. Publish test summary and release decision separately. Done/ALLOWED alone is not release approval.

## Current known boundaries
Local full verification is recorded in the implementation acceptance document, not rerun by this package. A fresh focused regression log is included separately. Tenant deployment/migrations/consent, workflow/actor checks and live journeys remain pending until evidenced. No app-wide no-egress eligibility, independent build attestation, performance certification or evaluation-to-transition correlation is claimed.


---

# Synthetic fixture and environment manifest

All fixture labels are preparation templates, not invented Jira IDs. Allocate actual IDs on the demo tenant and record them before execution. No real payment/customer data. Never store token secrets, TOTP values or credentials here.

| Fixture | Required data / independent oracle |
| --- | --- |
| F-AUTH | Separate source author, eligible independent approver, recorder, Test-only approver, viewer; source project/type grants; authorized readable Test T1 and unreadable T2; record real account IDs privately in controlled execution metadata. |
| F-GREEN | Disposable source with approved baseline B1 and digest; signed Test T1 v1, two mandatory contexts (for example QA/Linux and QA/Windows where supported); required evidence retained/read back; approved assignment, target and review chains. |
| F-CAND | Candidate A id qa-gv-a and B id qa-gv-b; same and different commit fields; fresh execution per candidate; record actual deployed artifact identity independently from sender-reported CI identity. |
| F-CI | Two prepared runs with real 32-hex IDs, actual revisions, resolved step IDs and iteration IDs; project token and expiring exact-run grant created by authorized human/admin; capture secret once in approved secret store only. Use app-generated payload template. |
| F-LIMIT | Valid generated requests varying one bound at a time; compute UTF-8 bytes, not character count; at-limit/one-over: 262144 bytes, 50 runs, 500 steps total, 4000 actual/comment characters, 16000 log characters. Record schema and endpoint limits separately. |
| F-RECOVERY | Two mapped runs, documented isolated pause/fault after member one, queue redelivery controls and audit outage toggle. If no supported fault mechanism exists, relevant cases are BLOCKED; do not damage shared SQL/audit records. |
| F-DEFECT | Failed signed attempt, configured failure/defect policy, a controlled blocker and a genuine fix retest on a new candidate execution. Preserve initial failure and link retest to defect. |
| F-LATEST | Older signed pass and newer same Test-version/context attempt with server sequence; variants blank-build/open, failed, rejected and cancelled. Historical variants need genuine audit creation facts before cutoff. |
| F-LEGACY | Genuine pre-cutover schema-1 signed PASSED evidence and valid creation audit; saved original canonical bytes/hash; allowed absent historical metadata. Never manufacture a signed legacy row or backfill its metadata. |
| F-PERSIST | Supported isolated storage/audit/read-back failure injection. Save before/after digests. No direct tenant database corruption. |
| F-WORKFLOW | Disposable source; actual published workflow routes to Done and configured va-gate; independent authorized human and supported automation identity; audit-confirmed real transition event. |

Reset: create a new uniquely tagged execution/target for different candidates or blocked receipts; preserve signed/audit history. Delete no signed record. Remove/revoke disposable grants using approved tenant controls at completion; cleanup is a separate authorized operation. Record fixture manifest SHA-256, expected outcomes and reset receipt for each run.


---

# Detailed test cases

All 28 cases are NOT RUN. Priorities P0/P1 are QA risk ranks, not Jira priority names. Every parameter/variant within a case must be separately recorded at execution. Fixture definitions are in fixtures.md.

## GV-TC-01 / VAT-108 — Source authorization and author separation

Scenario: S01 | Requirements: R01 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-AUTH: source author, independent approver, Test-only approver and viewer

Local regression pointer: `test/testmgmt-governance.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Attempt assignment, target and exception preparation/approval using each actor. Repeat with wrong source issue type and author separation enabled.
   Expected: Only source-scoped eligible actors succeed; Test-only rights and author self-approval are denied; rejected attempts do not activate records.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-02 / VAT-109 — Issue-security and nonmandatory receipt member access

Scenario: S01 | Requirements: R01, R14 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-AUTH; receipt includes mandatory T1 and nonmandatory T2; T2 is unreadable to viewer

Local regression pointer: `test/testmgmt-governance.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Open source governance view, receipt detail and frozen dossier as viewer after T2 access is removed.
   Expected: No hidden Test data or dossier is disclosed; incomplete view is explicit; every mapped Test is authorized.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-03 / VAT-110 — Pinned obligations and complete positive journey

Scenario: S02 | Requirements: R02, R11, R13 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-GREEN: signed source B1, T1 v1, two mandatory contexts, candidate A

Local regression pointer: `test/testmgmt-governance.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Prepare/approve assignment and target; execute and human-review every required combination; request guarded Done; export evaluation.
   Expected: All exact combinations qualify; gate returns ALLOWED only with confirmed evaluation; selected versions/contexts/build match and evidence is retrievable.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-04 / VAT-111 — Invalid version and competing assignment replacements

Scenario: S02 | Requirements: R02, R03 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-GREEN plus drafts D1 and D2 based on same active head

Local regression pointer: `test/testmgmt-governance.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Prepare two replacements; inspect active head before signing; activate D1 then D2. Separately invalidate a pinned Test approval before signing.
   Expected: Drafts preserve old head; D1 activation is audited; stale D2 fails; unverifiable Test approval prevents signing.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-05 / VAT-112 — Source drift and broken governing signatures

Scenario: S02 | Requirements: R03, R11 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-GREEN; record original source digest and signature meaning

Local regression pointer: `test/testmgmt-governance.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Change a controlled source field/baseline after approval; separately remove activation proof or alter signature meaning in isolated fault harness.
   Expected: Stale source or invalid governing proof denies closure; prior signatures are not silently reused; retain exact denial finding.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-06 / VAT-113 — Concurrent first candidate binding

Scenario: S03 | Requirements: R04 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-CAND: fresh execution, candidates A and B with distinct identities

Local regression pointer: `test/testmgmt-execution-candidate.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Race supported first-candidate claims from two authorized paths; read back candidate binding and audit confirmation.
   Expected: At most one candidate wins; loser receives mismatch/conflict; stored identity matches winning audited binding.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-07 / VAT-114 — Candidate reuse through manual, CI and target paths

Scenario: S03 | Requirements: R04 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-CAND bound to A; prepared second run and proposed target B

Local regression pointer: `test/testmgmt-execution-candidate.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Attempt manual addRun, CI intake and closure target using B; then create a separate execution for B.
   Expected: All reuse paths reject mismatch without mutating A; separate execution can bind B subject to ordinary authorization.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-08 / VAT-115 — Token and grant scope rejection

Scenario: S04 | Requirements: R05 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-CI: one-time token, grant for exact runs, wrong installation/project/execution/run variants

Local regression pointer: `test/testmgmt-intake.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Submit valid request, then wrong token/secret and each scope variant; inspect run/receipt state without recording secrets.
   Expected: Valid scoped request can enter processing; unauthorized variants have fixed denial and zero result writes.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-09 / VAT-116 — Mapping, revision and dataset iteration errors

Scenario: S04 | Requirements: R05 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-CI contains T1 v1 and two resolved dataset iterations

Local regression pointer: `test/testmgmt-intake.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Submit missing/duplicate/foreign run, wrong revision, omitted/duplicate step and wrong iteration variants; preserve payload digests.
   Expected: Exact mapping failures reject before applying results; legitimate two-iteration payload maps only to prepared identities.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-10 / VAT-117 — Expiry and revocation after queue admission

Scenario: S04 | Requirements: R05, R08 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-CI with queued receipt; controllable supported clock and per-write pause

Local regression pointer: `test/testmgmt-intake-store.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Revoke token or grant, or expire it, after queueing and before next worker write; repeat during partial application.
   Expected: SQL and runtime checks stop subsequent writes; receipt stays blocked; human signing/correction cannot bypass pending intake.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-11 / VAT-118 — Intake size, count and text boundaries

Scenario: S05 | Requirements: R06 | Priority: P1 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-LIMIT: exact and one-over variants: 262144 UTF-8 bytes, 50 runs, 500 steps, 4000 actual/comment chars, 16000 log chars

Local regression pointer: `test/testmgmt-intake.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Submit independently valid at-limit and over-limit payloads; include multibyte text; ensure other fields remain in bounds.
   Expected: At-limit parser inputs are accepted when all other constraints hold; over-limit inputs reject without writes. Live payload limits may be stricter and must be recorded.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-12 / VAT-119 — Static acknowledgment and unsupported payloads

Scenario: S05 | Requirements: R06 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-CI; wrong method/content type, malformed JSON, raw XML/JUnit, evidence array and controlled URL marker

Local regression pointer: `test/testmgmt-ci-intake-handler.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Submit variants through deployed trigger; inspect status/body. Observe controlled outbound marker using approved test instrumentation.
   Expected: Fixed responses reveal no token/receipt/results; invalid input rejects; URL is retained as sender text only, with no server fetch; CI evidence arrays are rejected.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-13 / VAT-120 — Byte-identical retry and key conflict

Scenario: S06 | Requirements: R07 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-CI original JSON P and exact bytes P; P2 changes actual/comment or JSON whitespace under same key

Local regression pointer: `test/testmgmt-intake.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Send P twice; resend P after APPLIED; submit changed P2 with same idempotency key. Compare receipt IDs, hashes and business writes.
   Expected: Identical bytes reuse original receipt and do not duplicate results; changed bytes conflict, including semantically equivalent reserialized JSON.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-14 / VAT-121 — Partial application and worker redelivery

Scenario: S06 | Requirements: R08 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-RECOVERY: two runs in one receipt; supported fault after first durable member write

Local regression pointer: `test/testmgmt-intake.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Pause/fail after member one; try sign/correct both runs; redeliver same receipt and compare final result records.
   Expected: Both remain unsignable while pending; redelivery resumes without duplicate/lost results or changed original provenance; readiness requires every member.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-15 / VAT-122 — Audit failure and serialized pending receipts

Scenario: S06 | Requirements: R08 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-RECOVERY; fail receipt audit confirmation; second distinct request for same execution

Local regression pointer: `test/testmgmt-intake-store.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Apply results with audit unavailable; attempt second admission and signing; restore audit, redeliver and inspect readiness.
   Expected: No APPLIED/signable state without matching audit proof; one pending receipt owns execution admission; successful recovery releases lock.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-16 / VAT-123 — Human review and reasoned correction

Scenario: S07 | Requirements: R09 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-CI APPLIED results, original logs, eligible independent human reviewer

Local regression pointer: `frontend/test/testmgmt-governance.test.mjs`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Inspect review meaning; correct one actual result with reason then sign using human ceremony; compare originals, correction and signed content.
   Expected: Meaning explicitly states review of machine-recorded results; machine remains executor; reason/history/original receipt are preserved; signed content matches review.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-17 / VAT-124 — Signed failure, defect and clean retest

Scenario: S07 | Requirements: R09, R11 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-DEFECT: FAILED signed run under configured defect policy; corrected candidate on fresh execution

Local regression pointer: `test/testmgmt-closure-gate.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Human-review failure; inspect configured defect creation without duplicates; execute fix retest and review resolution/qualification.
   Expected: Failure remains FAILED; defect safeguards apply; closure denies until required blocker/retest conditions are satisfied; original failed attempt persists.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-18 / VAT-125 — Newer unfinished or adverse attempt blocks old pass

Scenario: S08 | Requirements: R10 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-LATEST: signed PASSED run sequence n and same-context replacement n+1

Local regression pointer: `test/testmgmt-governance.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Independently test replacement IN_PROGRESS with blank build, FAILED, REJECTED and CANCELLED; evaluate after each.
   Expected: Every newer replacement blocks; no build filtering or fallback selects old pass; evaluation freezes n+1 as selected attempt.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-19 / VAT-126 — Missing order, duplicate order and concurrent new attempt

Scenario: S08 | Requirements: R10 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-LATEST; supported isolated faults for missing/duplicate sequence or creation during proof read

Local regression pointer: `test/testmgmt-governance.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Evaluate with each invalid order; inject newer attempt between proof and final consistency read.
   Expected: Missing/duplicate order and concurrent attempt change deny with explicit findings; historical order requires valid audit facts before cutoff.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-20 / VAT-127 — Nonwaivable proof and build failures

Scenario: S09 | Requirements: R11, R12 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-GREEN isolated variants: mismatched build, broken Test/run/evidence proof, pending intake, signed steps FAILED but stored PASSED

Local regression pointer: `test/testmgmt-governance.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Evaluate each variant and attempt exception where supported; compare signed step outcome to stored summary.
   Expected: Every invalid proof or mismatch denies; failure cannot be waived or masked by PASSED summary; no qualifying evidence is fabricated.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-21 / VAT-128 — Incomplete reads, blockers and missing retest

Scenario: S09 | Requirements: R11 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-GREEN variants: bounded incomplete histories, inaccessible required Test, blocking defect or absent retest

Local regression pointer: `test/testmgmt-closure-gate.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Evaluate each variant; restore one prerequisite at a time and inspect findings across all obligations.
   Expected: Unavailable/incomplete data is not empty success; any remaining mandatory blocker denies with actionable finding.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-22 / VAT-129 — Permitted historical metadata exception

Scenario: S10 | Requirements: R12 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-LEGACY: genuine schema-1 signed PASSED fixture, missing allowed metadata, valid historical audit ordering

Local regression pointer: `test/testmgmt-governance.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Hash signed bytes; approve exception for exact evidence digest using chain meeting both floors; evaluate and export; hash historical bytes again.
   Expected: Only named historical gap is accepted; VERIFIED_WITH_EXCEPTION identifies gap and unproved build absence; original signed bytes/digests are unchanged.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-23 / VAT-130 — Rejected exception variants

Scenario: S10 | Requirements: R12 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-LEGACY variants: schema-2 omission, actual mismatch, FAILED outcome, stale source, weak approval chain, wrong digest

Local regression pointer: `test/testmgmt-governance.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Attempt each exception and evaluate; include changed evidence after exception approval.
   Expected: No forbidden condition is waived; weak chain rejected; exception binds exact evidence/scope and cannot authorize changed content.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-24 / VAT-131 — Evaluation insertion, audit and read-back failures

Scenario: S11 | Requirements: R13 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-PERSIST: green candidate plus supported insertion/confirmation/read-back faults

Local regression pointer: `test/testmgmt-governance.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Request closure separately at each fault stage, including no durable denial possible during outage.
   Expected: Never ALLOWED without exact stored confirmed digest read-back; failure denies; inability to record denial is disclosed.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-25 / VAT-132 — Frozen allowed and denied dossier stability

Scenario: S11 | Requirements: R13, R14 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-GREEN and denied evaluation; original CI logs/proofs; later unavailable source baseline

Local regression pointer: `test/testmgmt-governance.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Export allowed and recorded denied evaluations; save hashes; change later state and export same evaluation again.
   Expected: Original frozen contents/digest remain stable; export includes selected attempts, meanings, receipts/log bytes, exceptions, evaluation time and verdict.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-26 / VAT-133 — Tampered receipt and export authorization

Scenario: S11 | Requirements: R07, R14 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-CI and frozen dossier; isolated tamper of payload, mappings, build or original logs; unreadable extra Test

Local regression pointer: `test/testmgmt-intake.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Apply/read/export variants using authorized fault harness; repeat with nonmandatory mapped Test unreadable.
   Expected: Tampered proof cannot become ready/qualifying; unauthorized exports fail and do not leak hidden members; original immutable receipt remains the authority.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-27 / VAT-134 — Real workflow routing and automation identity

Scenario: S12 | Requirements: R15 | Priority: P0 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-WORKFLOW: disposable source with va-gate on all intended Done routes; human and supported automation actors

Local regression pointer: `test/testmgmt-closure-gate.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Enumerate routes; try denied transition then qualified transition with human actor; repeat through supported automation actor lacking user-scoped read.
   Expected: Guard runs on each intended route; denied source remains non-Done; qualified route can move; unavailable user-scoped reads fail closed. Capture tenant workflow configuration.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.

## GV-TC-28 / VAT-135 — Transition observation, duplicate event and UI read-back

Scenario: S12 | Requirements: R15 | Priority: P1 | Status: NOT RUN

Preconditions: E1–E7 in test-plan.md satisfied; use isolated demo fixtures only; human signatures performed by authorized human.

Data: F-WORKFLOW completed Jira move and corresponding event; duplicate delivery

Local regression pointer: `test/testmgmt-transition-observation.test.js`; this is supporting coverage, not live evidence.

1. Action: Create/reset the isolated fixture and capture before-state, actual build/environment, actor and stable identities.
   Expected: Preconditions and independent expected values are recorded; no production data or secrets in artifacts.

2. Action: Read governance UI and observation; redeliver duplicate event using supported harness; compare observation count and source state.
   Expected: Jira status and audited observation are separately visible; duplicate reuses confirmed observation; timestamp proximity is not presented as verified evaluation linkage.

3. Action: Refresh/read back durable records; retain sanitized request/response, audit proof, screenshots/exports and fixture digest; record actual versus expected.
   Expected: Result is PASS only if every assertion holds; otherwise FAIL or BLOCKED with linked defect/prerequisite. Preserve attempts.

Actual / evidence / defects / tester / tested build / time: to be recorded.


---

# Execution register — NOT STARTED

Build/environment/tester/reviewer: UNASSIGNED / NOT VERIFIED. Entry gates E1–E7 pending. One row per variant must be added when executing.

| Case | Result | Actual / variant | Evidence | Defect / blocker |
| --- | --- | --- | --- | --- |
| GV-TC-01 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-02 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-03 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-04 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-05 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-06 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-07 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-08 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-09 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-10 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-11 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-12 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-13 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-14 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-15 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-16 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-17 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-18 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-19 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-20 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-21 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-22 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-23 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-24 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-25 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-26 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-27 | NOT RUN | — | — | E1–E7 pending |
| GV-TC-28 | NOT RUN | — | — | E1–E7 pending |


---

# Test summary — UNEXECUTED template

Candidate / deployed artifact / environment / dates / executor / independent reviewer: TO RECORD.
Requirements covered: 0/15 live. Cases: 0 PASS, 0 FAIL, 0 BLOCKED (not yet assessed individually), 28 NOT RUN; all variants additionally required. Entry gates: pending.

Record executed case/variant totals, requirement coverage, blocking defects and retests, remaining risks/deferred scope, evidence manifest/hash, allowed/denied evaluation IDs and real Jira transition observations separately. Record independent QA approval and explicit release decision; preparation is not sign-off.


---

# Package verification

Candidate source commit: 2fc3b05d145cf4a8c20463123217a6238196941e.

Fresh command: node --test test/testmgmt-governance.test.js test/testmgmt-governance-store.test.js test/testmgmt-intake.test.js test/testmgmt-intake-store.test.js test/testmgmt-ci-intake-handler.test.js test/testmgmt-closure-gate.test.js test/testmgmt-execution-candidate.test.js

Result: 58 tests, 58 pass, 0 fail; see local-focused-regression.log. Full npm run verify was not rerun in this preparation task. Prior full results remain attributed to ../governed-verification-2026-11-02.md.

Package consistency: 15 distinct requirement IDs all mapped, 12 scenario IDs, 28 unique cases/Jira keys; all local regression pointers exist; all live results NOT RUN.


---
