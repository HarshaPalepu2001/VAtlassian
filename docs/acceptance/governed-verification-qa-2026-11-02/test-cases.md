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
