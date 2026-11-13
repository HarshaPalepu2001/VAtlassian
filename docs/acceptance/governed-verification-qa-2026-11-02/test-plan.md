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
