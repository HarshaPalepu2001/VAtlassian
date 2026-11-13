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
