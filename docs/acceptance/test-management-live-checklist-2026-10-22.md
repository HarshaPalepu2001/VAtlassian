# Test management — live test checklist, 2026-10-22

Site: mgtechdemo, project VAT (company-managed). Development environment.
Local implementation verified 2026-10-22 against the [design](../superpowers/specs/2026-10-20-test-management-first-design.md), owner decisions 1–13.
Current manual-scope candidate is local and uncommitted. Development 8.24.0 is the previous build and does not establish acceptance of this candidate. This candidate adds migrations v115–v136. Confirm deployment identity, installation, migration completion and permissions separately before running these journeys. Final local evidence is recorded in `docs/reviews/2026-10-21-test-management-implementation-ledger.md`. Forge lint retains the existing wildcard client-permission warning.

Record each result as **Pass**, **Fail** (with what happened) or **Not run**.

## What is in this build

- Project setup page (Admin → VAtlassian → Test management): map Test, Test Execution, optional Test Plan, Test Set and Precondition, and Bug work types, the bug link type, and two sign-off chains (test version, test run). Defaults: version = Approver; run = Tester → QA, different people.
- New role **Tester** in Approver roles.
- "Test management" issue panel:
  - on a Test: draft (objective, preconditions, steps of action / data / expected), publish a numbered version, sign the version through its chain, see its runs;
  - on a Test Execution: add a run of a test's latest signed version (environment, configuration, release), record each step (Passed / Failed / Blocked / Not applicable, actual result, comment), retain evidence from the execution's attachments in Forge Object Store (bytes read back and SHA-256 verified), sign off through the run chain, reject with reason, close as not executed with reason.
- Result rules computed on the server (codebeamer order; Passed only when every step passed).
- One automatic bug per fully signed Failed run: a child of the **test's parent**, linked to the test and the execution, release copied, failed steps and evidence hashes in the description. A durable intent and direct marker proof prevent blind retries. An uncertain create with no uniquely proven result requires investigation; an empty search never authorizes another create.
- Execution guard in va-gate: a Test Execution cannot move to a Done-category status while a run is unfinished or a failed run has no bug yet.
- Test-management issues are outside their Epic's governed tree: creating a Test, Execution or the bug under a baselined Epic does not drift or hold the Epic, and a drifted Epic does not hold them.
- Every publish, run creation, signature, rejection and bug is in the audit ledger.

## Added in the local manual-scope candidate

- Signed, numbered plans/sets and reusable preconditions; plans freeze ordered signed Test versions, release, configurations and environment. Start runs in an existing same-project execution under the same parent; batches continue with stable child identifiers.
- Text/list parameters, explicit rows and bounded combinations; each run retains the resolved steps and iteration values. Every expanded step contributes to sign-off.
- Selective reruns create a new execution using immutable original provenance and exact or explicitly selected latest signed versions. Original archived releases can be retained from validated original run proof.
- Test-owned source associations are stored with signed Test versions in Forge SQL and visible on both Test/source coverage panels. Signed versions now synchronize dedicated typed Jira Verifies links through a durable outbox. Governed coverage requires matching native readback and endpoint approval rules. Source changes give Suspect; a signed FITS review clears the definition, while historical run reuse requires a separate signed applicability decision.
- Frozen execution summaries with JSON and readable HTML downloads, digest and explicit completeness. Coverage verifies current sources, terminal signature proof, evidence, planning snapshots and blocking defects.
- Pending signatures and publication/run setup are recoverable; only audit-confirmed signatures count. Defect repair checks mapped type, current parent, baseline exclusion, exclusive ownership and required links. Hourly workflow health includes enabled Execution workflows.
- Evidence downloads authorize the execution and Test on every bounded chunk and verify complete downloaded bytes.

Deferred: CI/JUnit upload, import/migration, AI, the ten-report center and the separate biometric/egress solution. This candidate does not establish Runs on Atlassian eligibility; the existing wildcard client permission and dynamic probe remain separate blockers.

## Setup (once)

1. [ ] Wait about 5 minutes after the deploy, or run migrations from Admin → Settings, so the `tm_*` tables exist.
2. [ ] In VAT, make sure work types exist for Test and Test Execution (and Bug). They must not already be used inside approved baselines; the setup page refuses them otherwise.
3. [ ] Admin → Test management → VAT: map the types, choose the bug link type and a separate dedicated Verifies type, keep the default chains, **Save and enable**.
4. [ ] Approver roles: grant VAT people **Approver** (signs test versions), **Tester** and **QA**. Two different people are needed for Tester and QA.
5. [ ] Add the "Test management" panel on a Test and on a Test Execution (the panel button in the issue view).

## Journeys

| # | Journey | Expected | Result |
|---|---|---|---|
| 1 | Test with no parent: write steps, save, publish | Publish refused: "no parent". | **Pass** (`VAT-83` without parent: publish refused: "This work item has no parent...") |
| 2 | Test under an Epic: steps, save, publish | Version 1, "Waiting for sign-off", digest shown. | In progress (`VAT-83`) |
| 3 | Sign v1 as an Approver with authenticator | v1 Signed; signer, time shown; ledger has TM_SIGNED. | |
| 4 | Publish again with no change | Refused: nothing changed. | |
| 5 | Edit a step, publish v2 | v2 waiting; v1 still Signed with the same digest. | |
| 6 | Execution under the Epic: add run of the test | Run uses v1 (latest signed), In progress. | |
| 7 | Add a run as someone without Tester | Refused: cannot sign step one. | |
| 8 | Record all steps Passed, sign as Tester | Run Signing; results read-only. | |
| 9 | Try to sign QA step as the same person | Refused: different person. | |
| 10 | QA signs | Run Signed, Passed, no bug. | |
| 11 | New run: one step Failed, Tester signs, QA signs | One Bug created under the **test's Epic**, linked to test and execution, fix version = release. |
| 12 | Check the Epic (if baselined) after 6 and 11 | Epic not drifted, not held. |
| 13 | Run with a step Blocked: try to sign | Refused; close as not executed with reason works. |
| 14 | QA rejects a signed-by-tester run with a reason | Run Rejected, both signatures shown, no bug. |
| 15 | Attach a file to the execution, add as evidence to a step | Evidence with SHA-256; digest to sign changes. |
| 16 | Move the execution to Done with an open run | Blocked by VAtlassian with the open-run message. |
| 17 | Close every run, move execution to Done | Allowed. |
| 18 | Wrong authenticator code on any signature | Refused; nothing signed; run stays open. |
| 19 | Audit ledger | TM_VERSION_PUBLISHED, TM_RUN_CREATED, TM_SIGNED, TM_REJECTED, TM_NOT_EXECUTED, TM_BUG entries. |
| 20 | Before setup step 3: remove va-gate from one Done transition of the Execution workflow, then Save and enable | Refused, naming the transition. Put va-gate back; enabling works. |
| 21 | Record one step Failed, try Close as not executed | The button is not offered. Signing off as Failed raises the bug as in 11. |
| 22 | A person who cannot see the test (issue security) opens the execution | The run shows its state and sign-offs, with a notice in place of the steps. No sign or record button. |
| 23 | Grant Tester for the Story work type only (not the Execution type, not all types), then add a run as that person | Refused: nobody can sign step one. |
| 24 | After 11, open `/rest/api/3/issue/<bug key>/properties/va-tm-bug` in the browser | The property names the run. If the create was refused instead, the run shows "Bug needs repair" with the Jira status. |
| 25 | With Tests under the Epic, try to switch test management off for VAT | Refused: the Tests sit under a parent. |

## Additional manual-scope journeys (all Not run on the tenant)

| # | Journey | Expected |
|---|---|---|
| 26 | Edit the draft after publishing; open the published version and sign it | Full frozen objective, preconditions, steps, dataset and source pins precede the signing control. |
| 27 | Save two dataset rows; publish/sign and start a run | Two immutable resolved iterations; an unfinished row blocks Passed sign-off. |
| 28 | Use list combinations, duplicate parameters, undefined placeholders or more than 100 iterations/1,000 expanded steps | Deterministic bounded combinations; invalid or oversized work refused. |
| 29 | Map Plan/Set/Precondition; sign a reusable precondition; publish/sign a plan of two Test versions and two configurations | Frozen membership, signed version identities, precondition text and four prepared runs. |
| 30 | Start the signed plan in the target execution; retry after a lost response and continue batches | Each child appears once; same release/environment/configuration and signed plan identity; no silent partial success. |
| 31 | Use an execution under another parent or a hidden/cross-project plan member | Refused before new runs; hidden details are not returned. |
| 32 | Edit plan/precondition after a run exists | Original snapshot unchanged; current coverage becomes unconfirmed. |
| 33 | Remove plan/precondition/source access while another signer is waiting | Protected details hidden; signing blocked; unchanged visible historical snapshots remain reviewable. |
| 34 | Add a source, publish/sign Test, then execute/pass/sign | Both panels show the association; operational coverage may verify without baseline; governed coverage requires approved baseline proof, stored native link rules and exact Jira link readback. |
| 35 | Approve a source baseline change | Test becomes Suspect; old pass does not silently count for the new source. |
| 36 | Prepare and sign FITS with rationale | Both baseline identities are signed; definition review clears, old run still needs applicability or a new run. |
| 37 | Separately sign applicability for the exact old frozen run | Only that run may be reused for the reviewed source baseline. MUST_CHANGE, missing proof, unapproved drift and later source changes remain blocked. |
| 38 | Delete the original Jira attachment after retention | Retained evidence remains downloadable and verifiable; missing/corrupt retained bytes block signing/complete export. |
| 39 | Revoke execution/Test visibility during an evidence download | Further chunks refused; no protected object key supplied by client. |
| 40 | Finish an execution and select failed/rejected/not-executed runs for rerun | One new execution; selected exact or chosen latest signed versions; environment/configuration/release and retest ancestry retained. |
| 41 | Lose the create response; retry before/after search catches up | Reconcile one confirmed execution; ambiguous or absent identity becomes NEEDS_REPAIR and never triggers another automatic create. |
| 42 | Generate and download summary, then edit Test/source | Stored snapshot and digest unchanged; newly generated coverage reflects changes. Revoked contained-record access prevents later download. |
| 43 | Simulate pending signature/audit/state persistence failures in an isolated test environment | No counter-signature or terminal label without proof; Finish operations recover existing durable events. |
| 44 | Remove an Execution Done validator after enabling | Hourly health detects the missing route; actual workflow protection depends on the validator remaining attached. |
| 45 | Repair a failed-run defect using a Story, reused Bug, wrong parent or baselined member | Refused. Correct Bug needs verified run proof, exclusive claim, links and durable repair audit. |
| 46 | Newer Rejected/Not executed result, hidden source, incomplete reads, unresolved Bug or unconnected later pass | Coverage stays unconfirmed/unverified; no older-pass fallback or complete export. |

## Native Jira link journeys (all Not run on the tenant)

| # | Journey | Expected |
|---|---|---|
| 47 | Publish sources before configuring a dedicated Verifies type | Refused before immutable publication. Historical versions remain readable. |
| 48 | Save/edit a draft source association | No Jira issue link is written. |
| 49 | Sign a Test against a v1 source baseline, then attempt synchronization | Blocked before native mutation; source approval/hash unchanged; governed coverage Unknown. |
| 50 | Make a new full native source approval adopting v2, then Finish version | Typed outward Verifies appears once on the Test, matching inward link on source; fresh readback plus audit commit proof. Source has no drift from this excluded link. |
| 51 | Give the Test its own native baseline that omits the expected Verifies link | SQL Test signature cannot override it; synchronization blocked. Native approval of the intended link permits adoption without mutation. |
| 52 | Add/reverse an unexpected Verifies link manually; delete a committed link manually | Governed coverage Unknown. Unexpected links are not deleted; committed history does not silently restore a manual deletion. |
| 53 | Interrupt after one link write, then retry or sign a newer changed source scope | Bounded reconciliation resumes; newest signed scope governs cleanup; no unknown link is removed. |
| 54 | Restore/reject a v2 source with Verifies and an unrelated link edit | Verifies is preserved; unrelated controlled links are restored subject to other-end approval conflicts. |
| 55 | Change configuration after v1/v2 capture; run drift/restore/propagation | Each stored baseline keeps its own rules. Excluded-only propagation creates no derived baseline; ordinary Relates stays governed. |
| 56 | Sign an empty Test without a Verifies mapping, configure it, then sign a version with sources | First native relationship synchronizes; empty prior history does not strand the Test. |
| 57 | Change a child policy while a restore is queued, or revoke visibility before coverage read | Queued restore refuses the substituted policy before writes; hidden/unreadable links never establish governed proof. |

## Known limits to watch

- Setup and hourly health check Execution Done routes. Monitoring detects a removed validator; it does not prevent a Jira administrator from removing it or replace tenant acceptance of every route.
- If the app cannot set the bug's parent (Epic hierarchy or create screen), the run shows "Bug needs repair" and an administrator links the right bug.
- A create whose answer is lost (timeout or Jira 5xx) shows "Bug pending" for about 5 minutes before "Check bug again" looks for it: Jira's search lags behind a new issue. Not reproducible on demand live.
- If a sign-off is recorded but the run's outcome or bug is not, the run shows "Finish sign-off" or "Create the bug". Not reproducible on demand live.
- Step-result edits before signing are audited best-effort (TM_STEP_RECORDED); the signed run digest is the authoritative record.

- Bounds: 100 dataset iterations, 1,000 expanded steps, 200 collection members, 100 selected reruns, 10 child runs per invocation and 500 runs in a complete execution-panel read. Oversized/incomplete records must not be treated as accepted scope.
- Uncertain rerun creation has no automatic second-create or admin reassignment action in this candidate; investigation is required.
- Existing source baselines retain v1 until a new full native approval adopts v2. Native Test baselines always own Verifies. Generic Relates bug links remain governed; this candidate adds no native plan/set membership or retest mirrors.
