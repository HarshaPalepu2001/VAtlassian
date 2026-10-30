# VAtlassian test management first design

Status: proposed implementation target, 2026-10-20, revised the same day with the owner's decisions (next section). The feature is not built. This design supersedes the earlier test-plus-requirements draft; requirements management is a later product phase.

## Owner decisions, 2026-10-20

These came from the product owner and override anything below that reads otherwise.

1. **The target is complete test management.** That means every AssureX test capability (authoring, data, plans, execution, board, reports, admin, import, CI, AI), reshaped to work the way a compliance auditor wants. Codebeamer sets the bar for rigor: result rules, configurations and releases, re-runs, coverage. In one line: AssureX supplies the everyday authoring and board experience, and codebeamer supplies the result rules, re-runs and coverage discipline. The core/breadth split below is a **build order**, not a smaller product. Test management is done only when both are done.
2. **The auditor's first question is answered on the run itself.** For any run, the auditor asks: which signed test version did it use, who signed it off, when, and what was the result? The answer is one click from the run and comes from the signature records and the `va_audit` chain, never from an editable field.
3. **No official run without a signed version.** A run that counts can only be created from a test version that has been approved and signed. Unsigned drafts can be edited freely but never executed for the record.
4. **The client decides who signs what. VAtlassian enforces it with no exceptions.** Sign-off uses VAtlassian's existing controlled-transition rules: the role, the assurance level, a signature bound to the content hash and usable exactly once, and an audit entry. A typical setup is the tester signing and the QA lead countersigning, but the client may configure any number of sign-off steps. If no user holds the configured role, the step cannot be signed and the run cannot move forward. There is no admin override, no "skip" and no fallback signer.
5. **One bug per failed run, created automatically.** It is not created per step and not at the moment a step is clicked. *Timing is open for the owner to confirm:* the owner first agreed to "when the tester signs the run as Failed", and design review 2 proposes "after the whole sign-off chain" so that a run QA rejects never produces a bug. See "Automatic bug on a failed run".
6. **A signed run never changes.** A retest is always a new run, linked to the failed run and its bug.
7. **Biometric versus Runs on Atlassian is deferred** to Marketplace submission. TOTP is the assurance level for test sign-off until then.
8. **The test owns the `Verifies` link.** The link is part of the Test's signed version: it is added in a draft and approved with that version. Adding, removing or retargeting a `Verifies` link never drifts, holds or re-signs the source requirement. The source side still raises the flag: when a baselined source changes (new baseline, or drift), every test that verifies it is marked **Suspect** until a new test version is signed or someone records a signed review that the test still holds. This matches codebeamer and DOORS.

## Owner decisions, 2026-10-21

These override anything above or below that reads otherwise.

9. **Nothing in test management is loose.** Every Test, Test Plan and Test Execution has a Jira parent (normally the Epic it belongs to). A Test without a parent cannot be published, signed or added to a plan. An execution without a parent cannot start an official run.
10. **The automatic bug is created under the failed test's parent.** It is a child of that Epic, and also linked to the test and the execution. A run belongs to one test, so there is exactly one parent. If the test has lost its parent by then, the bug is not created and the run shows **Bug needs repair** (decision 5's guard still holds Done).
11. **Test-management issues sit outside the parent's governed tree.** Today a baselined Epic's tree takes in every descendant, so a new Test or bug under it would be "node added" drift. The Epic would be held, and rejecting it would *delete* the new issue (`DELETE_ADDED_NODE`). Tests, plans, executions and their bugs have their own signatures and history, so the Epic's baseline must not cover them. Every tree read (capture, drift, approval hash, restore and its verification) leaves out, with everything below them, the project's mapped Test, Plan and Execution types and every bug whose issue ID test management created (from its own `tm_bug` rows, never a label or property a user could set). A drifted Epic does not hold them either (ancestor hold).

    *Built 2026-10-21 as one rule for all baselines, not a per-baseline policy:* enablement refuses a work type that already has an issue inside any stored baseline tree of the project, and test-management bugs are new issues. So nothing excluded can have been part of what anyone signed, and no baseline is re-read under a rule it was not signed with. (`src/testmgmt/treeExclusion.js`, `src/usecases/testManagementAdmin.js`.)

    *Tightened after review, 2026-10-21:* the rule also holds in the other direction. A type leaves the exclusion (test management switched off, or the type no longer mapped) only while a complete search finds none of its work items under a parent. Otherwise they would come back into their parents' approved trees as added work items. A test-management bug stays excluded by its `tm_bug` row whether test management is on or off, and whatever the bug type mapping says now.
12. **Not now:** Sync Now (VAtlassian never mutates a published version, so it has no use), the ten-report Reporting Center and trace reports, CI/JUnit upload (automated test results posted from a build server: kept for later, it is test management, not requirements), file import and Xray/Zephyr migration.
13. **The bar is a compliant, reliable test cycle for automotive and medical work.** See "Compliance mapping" below. A tool is never itself "ASPICE compliant": an assessor rates the supplier's process. VAtlassian must make the compliant process the only one the tool allows, and produce the evidence an assessor or auditor asks for.

## Compliance mapping

What each framework asks of the test cycle, and where this design answers it. "Next round" items are required for the compliance claim, but not for the first live test.

| Framework | What it asks of testing | Where VAtlassian answers it | State |
|---|---|---|---|
| Automotive SPICE 4.0, SWE.4/SWE.5/SWE.6, SYS.4/SYS.5 | Verification measures specified (steps, expected result as pass/fail criteria, preconditions, environment); measures selected for each release, including regression; verification performed and results recorded; consistency and bidirectional traceability between requirements, measures and results; results summarised and communicated | Signed test version (steps, expected results, preconditions); plan revision and frozen release scope (selection); run with result rules, environment, configuration, release and signatures (recording); `Verifies` link from the signed version plus the requirement's coverage panel (traceability); execution summary export (communication) | Recording and selection: first slice. Requirement coverage panel and execution summary: next round |
| Automotive SPICE SUP.8 / SUP.9 / SUP.10 | Configuration items baselined; problems recorded, tracked to closure; changes controlled | Baselines and drift (existing); automatic bug per failed run, closure plus a signed retest before green; draft → new signed version | First slice, except retest-before-green on reports |
| ISO 26262-8 clause 9 and clause 11 | Verification planned, specified, executed and evaluated; confidence in software tools used for safety work | Same records as above; a tool-confidence package (use cases, failure modes, the validation test suite and its results) | Package: before release |
| IEC 62304 §5.5–5.7, §8, §9 | Unit, integration and system test with recorded results, tester, date, version tested and anomalies; regression testing; configuration management; problem resolution | Run record (pinned signed test version, tester, signature time, result, evidence hashes); selective re-run; baselines; automatic bug | First slice |
| 21 CFR Part 11 §11.10(e), §11.50, §11.70, §11.200 | Secure computer-generated audit trail; signature shows printed name, date/time and meaning; signature bound to its record; non-biometric signature uses two components | `va_audit` hash chain; `tm_signature` carries printed name, time, meaning and content hash, single use; signer's Jira identity plus TOTP | First slice (existing signing controls) |
| ISO 13485 §4.1.6, GAMP 5 / CSA | The manufacturer validates software used in its quality system | Validation kit: intended use, risk assessment, requirement-to-test trace of VAtlassian itself, and the automated test results | Before release |

## Why this comes first

VAtlassian already has approvals, controlled transitions, baselines, audit, drift and retained evidence. The next product area is Jira-native **test management** that can serve an ordinary Jira Story or an already configured Requirement today. The later requirements workspace will connect through a stable link and baseline interface; it is not required for users to author tests, plan them, run them, or prepare an audit record now. A complete one-stop V-cycle product will need that later requirements phase, so test-management completion must not be described as completion of the whole V-cycle.

The goal is comparable *capability*, learned from authorized AssureX UI observation and vendor documentation, implemented clean-room inside the existing VAtlassian Forge app. It is not an AssureX source port, visual copy, or use of its AWS service.

## Evidence boundary

- The local REA source checkout is `/Users/sriharsha/Downloads/rea-main` (`rea-agents` 6.7.0). The currently connected REA server reported 6.4.0. REA is tooling; neither is AssureX source. The prior AssureX investigation used REA on a signed-in browser page but did not read the vendor JavaScript bundle contents. Keep that boundary.
- The [October 19 AssureX investigation](../../plans/2026-10-19-assurex-test-management-port.md) contains public documentation and a live ATX test. A fresh read-only browser check on October 20 confirmed the test-run page and the Requirement Traceability report's timeline, final-status, environment, issue, fix-version, status, assignee and resolution filters. These observations are point-in-time and incomplete.
- Before coding a capability, record its source as **observed UI**, **vendor documentation**, **inference**, or **VAtlassian design**. If a vendor workflow is unavailable, implement the outcome that the product needs and label it as VAtlassian behavior; do not claim exact parity.

## Test capability contract

| Area | AssureX-derived target | VAtlassian auditor requirement |
|---|---|---|
| Setup | Company-managed project enablement; TestCase, TestPlan, TestSet, TestPrecondition, TestExecution, TestDefect; issue panels, board, global/project settings | Preview/apply/read-back; map existing Jira types or provision recommended ones without changing another project's shared scheme; server-side role checks |
| Test design | Steps/Unstructured/Gherkin types; Action/Data/Expected rich text; order, duplicate, custom step fields, step attachments; drafts, versions, compare/sync; codebeamer: pre-actions and post-actions, reusable steps and test cases (by reference or by copy) | Immutable published version with canonical digest; later edits are drafts; approval of exact version through existing governance; old versions remain accessible; a change to a reused step makes new drafts in the tests that reference it and never alters a signed version |
| Test data | Text/List parameters, parameter lists, dataset rows, combinatorial values, test default and execution override | Versioned dataset snapshot and bounded iteration expansion; every run pins resolved values and substitution digest; dataset edits create history and suspect impact |
| Organization | Test repository, plans, sets, preconditions, ordered membership and tests linked to ordinary Jira work items | Plan revision fixes required members, test versions, build/environment; visible typed Jira links reconcile with SQL membership; no hidden or incomplete link is counted |
| Execution | Execution issue/board, per-test run, per-iteration and per-step statuses, actual result/comment, timer, assignee, environment, findings, evidence, reset/retry; codebeamer: test configuration × release, selective re-run, Blocked resumes | Runs only from a signed test version; status/assignee/permission gate on server; result rolled up by fixed rules (below); client-configured sign-off chain on every run; a signed run is immutable; exact test/plan/dataset/configuration/release/environment/actor/time and evidence hashes; a retest is a new run |
| Defects | Create/link defect from test/run/step, defect mapping, defect traceability; codebeamer: Report Bug from the runner, pre-filled | Exactly one bug created automatically when a run is signed off as Failed, pre-filled and linked to the test and the execution (the trace to sources runs through the test's `Verifies` links); manual Report Bug / link existing during a run as well; failed run and its proof preserved; closure plus a signed passing retest required before a green release result |
| Coverage and reports | Issue coverage panel; test/plan/run lists, coverage and metrics, requirement/defect trace, compliance audit report; filters and exports | Distinguish operational coverage from governed coverage, show selected scope and completeness, drill to exact version/attempt/evidence; fail closed on partial reads |
| Administration | Test/run/step statuses, semantic coverage mapping, environments, parameter lists, action access rules, custom step/run fields, import and AI settings | Revisioned configuration; changes do not rewrite historical run meanings; audit who changed what and when |
| Ingestion | XLSX/CSV/JSON, Xray/Zephyr migration, JUnit/ZIP evidence and automation tokens | File-based import only for external tools, dry-run mapping and resumable jobs; static authenticated CI web trigger with fixed response and idempotent caller run ID |
| AI assistance | Suggestions from Jira/approved document context, human select/reject/regenerate | Forge LLM only, project opt-in, source references and human selection; output is a draft, never approved proof |

This matrix is the implementation inventory. The live AssureX investigation still leaves Sync Now semantics, complete `/automation` endpoints, exact defect creation and some reporting exports open. Close the high-impact gaps with passive, authorized UI observation when possible; retain an explicit unknown for the rest. Do not block a VAtlassian implementation on behavior that is not visible or documented.

## Product and data boundaries

1. **One Jira app.** Use the existing Forge app and its SQL, functions, queues, UI and audit chain. No AssureX remote backend, external fetch permission, `remotes`, providers, Connect modules, dynamic web triggers, or personal Jira API tokens for test management. Inbound CI is allowed through a static web trigger with a fixed acknowledgement; it cannot return created issue keys in the HTTP response.
2. **Jira work items are identities.** Test, Plan, Set, Precondition, Execution and Defect are Jira issues. Administrators may map customer types; product defaults are optional. Store numeric Jira issue IDs internally, retain keys for display, and reconcile move/rename/delete events.
3. **Forge SQL is the detailed model.** `tm_*` tables own ordered steps, versions, dataset snapshots, plan membership, runs/results, configuration and event indexes. SQL is installation-scoped; no cross-installation lookup. Use bounded rows, indexes, idempotent writes and explicit repair states. Jira links provide navigation and requirement/test association; SQL plan membership is canonical, with mirror status shown when links lag or disagree.
4. **Evidence stays on Atlassian.** Jira attachments support native access; the existing VAtlassian vault/Object Store supplies protected retained copies where required. Record SHA-256, size, media type, actor, timestamp and both references. Object Store is not assumed WORM; application-level append-only history and the existing audit hash chain protect integrity. Missing content or failed hash read blocks a compliant claim.
5. **Server authority.** Every resolver/worker checks installation, project enablement, issue visibility, Jira action permission, VAtlassian policy, exact version and expected revision. Display conditions only hide UI. CI tokens are admin-created service credentials scoped to project and ingestion, hashed, expiring and revocable. A web trigger has no `asUser`; it cannot borrow the token creator's later Jira permissions.
6. **No egress is continuous.** The test module uses Atlassian-hosted compute/storage only. Check full deployed-app `forge eligibility` at each release gate. The separately owned authentication route is not redesigned here.

## Requirement connection, without building requirements management now

Define `SourceRef = { siteId, projectId, issueId, linkTypeId, baselineId?, baselineVersion?, contentHash?, capturedAt }`. A Test can link to a Jira Story, Requirement, Source Document, or another administrator-approved coverable type. The test module reads only the source issue and link information it is authorized to see. It does **not** create a requirements tree, trace database, new requirement workflow, or requirement editing workspace.

Two coverage modes are mandatory. They differ only on the **source** side. On the test side, every counted run used a signed test version and carries its full sign-off chain, whichever mode applies.

- **Operational coverage** for ordinary Jira issues: linked tests, the latest terminal run per test (see Result rules), defects and run evidence, labeled with the selected Jira scope and time. It never claims an approved requirement baseline.
- **Governed coverage** only where a VAtlassian-approved source baseline exists **and** the `Verifies` link to that source is in the signed test version (owner decision 8), with the source's baseline ID/version/hash recorded in that test version. Pinned: the source baseline, the test version, the run and the evidence. A change to the source after the test version was signed marks the row **Suspect**. A Jira link that disagrees with the signed test version (added, removed or retargeted outside a version) marks it **Unknown**. If the baseline or a complete link read is missing, governed coverage is **Unavailable/Unknown**, not Passed. Source-side `issuelinks` control is not required.

The future requirements-management module can implement `listCoverableSources`, `readApprovedSourceSnapshot` and `readSourceImpact` behind this adapter, without migrating or rewriting test runs. Test management must preserve source issue ID and optional baseline reference now so that later traceability can use it.

## Auditor rules for test management

1. Draft, published and approved are separate states. Publishing freezes a test version; VAtlassian approval/signature applies to that exact digest, including its SQL-backed steps, pre/post-actions, dataset, preconditions and attachment hashes. Approval must re-read the Jira and SQL content before signing. A plan revision freezes membership and versions. **An official run can be created only from an approved (signed) test version**, and records exactly which one. *Builder's call:* a dry run against an unsigned version may exist for authoring convenience. If it does, it is visibly marked **Unofficial**, cannot be signed off, never creates a bug automatically, and is excluded from coverage, reports, metrics and the dossier.
2. A final result is append-only. Corrections and reruns create new runs with actor, reason and timestamp. Configured display status maps to a stable semantic status (`PASSED`, `PARTLY_PASSED`, `FAILED`, `BLOCKED`, `NOT_APPLICABLE`, `NOT_RUN`, `IN_PROGRESS`), captured at the time of the run; later status renames do not change history.
3. A release row is `Unknown` for incomplete/hidden data or broken evidence; `Suspect` for changed source/link/test/plan/dataset after execution; `Failed` for latest required failure or unresolved blocking defect; `Passed` only when every required test has a **fully signed** (every configured sign-off step) passing run for the selected configuration/release/environment and all evidence is available; `Planned` for linked but unexecuted or not-yet-fully-signed tests; `Not covered` for none. `Not applicable` requires approved rationale.
4. Operational and governed coverage are separate columns/reports. A green operational result cannot be relabeled as governed by export formatting. Validation tests can be marked `VALIDATION` and linked to an intended-use Jira issue, but full V-cycle verification-method and requirements-management controls are future work.
5. Reports are generated from a frozen release scope and state their filters, timestamp, app version, source status, completeness and blockers. They include test/plan versions, run attempts, evidence manifest, defects/retests, configuration meanings and audit-chain check. A partial report may be exported only with a clear `INCOMPLETE` mark; it is never a compliant dossier.

## Run sign-off

A run is a SQL record inside a Test Execution issue, not a Jira issue, so there is no Jira workflow transition per run. Today's approval record cannot be reused unchanged: `va_approval` (`src/db/migrations.js`, `v004_approval`) is bound to an issue, its from/to status and a transition, and the gate consumes it during that transition.

**A new signing subject, the same controls.** Test management adds `tm_signature`. Its subject is a *SQL record and a chain step*: subject kind (`RUN_STEP`, `RUN_NOT_EXECUTED`, `RELEASE_SCOPE`, `SUSPECT_REVIEW`, `APPLICABILITY`), subject ID, chain step index, the pinned chain configuration ID and digest, signer account, printed name, role, meaning, content hash, state, created/expires/consumed, and the reason text where the kind requires one. It reuses, unchanged:
- role eligibility (`va_eligibility`, `lib/eligibility.js`)
- the assurance levels and the one-time challenge (`lib/approval/challenge.js`, `levels.js`, TOTP verification)
- the pending → consumed compare-and-swap of `lib/signatures.js`, with `CONTENT_CHANGED` refusal
- an entry in the `va_audit` chain

No second, weaker signing path is introduced. The existing `va_approval` path stays exactly as it is for Jira transitions.

- **The chain is pinned when the run starts.** An official run records the chain configuration ID and digest in force at creation. A later change to the project's chain affects new runs only.
- **Preflight before an official run starts.** Every chain step must have at least one eligible signer. Where distinct signers are required, there must be enough distinct eligible people for the whole chain, and the "Executed by" step must include the person starting the run, or the assignee. If the preflight fails, the run is not created, and the screen names the missing role.

- **Configurable sign-off chain.** A project admin defines an ordered list of sign-off steps for runs: role, assurance level, label (for example "Executed by" and "Reviewed by"). The chain has one step or more, and the client chooses how many. *Builder's call:* default chain is one Tester step then one QA step, and by default the same person may not sign two steps of one run. Both are settings the client can change.
- **What is signed.** The run digest: pinned test version digest, configuration, release, environment, iteration values, every step result, actual result, comment and evidence SHA-256, and the rolled-up result. Any change between challenge and consume is rejected (`CONTENT_CHANGED`). Once the first step is signed, results are frozen. A later step only adds its signature.
- **No eligible signer, no progress.** If eligibility is lost after the run starts (a person leaves the role), the step shows who is needed and stays unsigned. Admins get no override.
- **Unofficial runs** (rule 1) run against an isolated snapshot of the draft, taken when the dry run starts, so later draft edits cannot change what the dry run showed.
- **Rejection.** A countersigner may reject instead of signing. The rejection is recorded with reason. The run keeps its existing signatures (a signature is never undone), is marked Rejected, and counts for nothing. Coverage then needs a new run.
- **The Jira side.** The Test Execution issue's own workflow stays under ordinary VAtlassian controlled transitions, which the client configures. In addition, the execution guard holds any transition into a Done-category status while any run in that execution is not terminal, or is waiting for its automatic bug.
- **Every Done route is guarded.** A Forge workflow validator runs only on transitions it is added to. Project enablement therefore reads the Execution workflow, lists every transition whose target is Done-category, and refuses to enable test management until the guard is on each one. The same check runs again whenever a workflow changes and in the hourly sweep. An unguarded Done route turns the project's test management **red** in admin and diagnostics, and every report states it.
- **Done is not readiness.** Done means "every run in this execution is terminal", nothing more. The execution view shows its terminal mix (Passed, Failed, Rejected, Not executed). Release readiness comes only from the frozen release scope (below), never from execution status.
- **Roles.** The fixed role list in `src/lib/roles.js` (Reviewer, Approver, QA) gains **TESTER**, added under that file's own rules. People are assigned to roles per project in the existing People screen.
- **What the auditor sees.** Every run shows, without navigation: test key and signed version (with its own approvers), configuration, release, environment, result, and each sign-off step's signer, time, assurance level and audit-chain entry.

## Result rules (VAtlassian's, following codebeamer)

Computed on the server from step and iteration results. The tester cannot enter an overall result that contradicts them. Codebeamer's documented rule treats incomplete, skipped or N/A steps among passes as Partly Passed ([PTC](https://support.ptc.com/help/codebeamer/r3.3/en/codebeamer/user_guide/ug_overview_test_results.html)). VAtlassian follows it deliberately: **Passed means every step was executed and passed.**

- A step is Passed, Failed, Blocked, Not Applicable (N/A) or Not Run. **N/A requires a reason**, covered by the run's signature.
- An iteration is:
  - **Failed** if any step failed
  - else **Blocked** if any step is blocked
  - else **Not Run** if any step is not run
  - else **Not Applicable** if every step is N/A
  - else **Partly Passed** if some steps are N/A
  - else **Passed**
- A run is:
  - **Failed** if any iteration failed
  - else **Blocked** if any iteration is blocked
  - else **Partly Passed** if any iteration is Partly Passed, or was deliberately skipped with a reason
  - else **Not Applicable** if every iteration is N/A
  - else **Passed**
- **An iteration that is Not Run, and was not deliberately skipped with a reason, makes the run unsignable.** It must be executed, skipped with a reason, or the run closed as Not executed.
- **Blocked is not final.** The run cannot be signed off. Testing resumes from the blocked step once the cause is removed, or the run is closed as Not executed.
- Post-actions are recorded on every run, whatever the result.
- Configured statuses (AssureX-style names, colours, Is Final, coverage mapping) map onto these semantic results. The mapping in force is captured with each run.
- **Coverage follows the latest terminal run, never an older one.** Per test × configuration × release, coverage takes the most recent terminal run. If that run is Rejected or Not executed, the row is **Not verified**, even when an older run passed. The older pass stays visible as history and never stands in.
- **A Partly Passed that is accepted is disclosed.** Where a project accepts Partly Passed (setting, default off), every report row it satisfies carries "Partly passed", with the skipped iterations or N/A steps and their reasons.

## Configurations, releases and re-runs (from codebeamer)

- A **test configuration** is a named variant the product is tested on (for example a browser, OS or hardware build). A **release** is the Jira fix version under test. An execution names one release and one or more configurations. Each configuration gets its own run per test.
- **Selective re-run**: from a finished execution, create a new execution with only the chosen runs (default: Failed, Rejected and Not executed), against the same or a newer signed version. The old execution and its runs are untouched. The new runs link back to the ones they retest.
- Coverage follows the latest terminal run per test × configuration × release (see Result rules). A newer Rejected or Not executed run is never skipped over in favour of an older pass.

## Automatic bug on a failed run

- **Trigger.** *Owner to confirm (owner decision 5).*
  - **(a) When the tester signs** the Failed result. This is what the owner agreed to. The bug is raised at once, but a run QA later rejects will already have a bug, which people close in Jira. A rejection does not delete it.
  - **(b) When the whole sign-off chain is complete** with a Failed result. This is design review 2's recommendation. Only a fully signed Failed run ever produces a bug, but the bug waits for the countersign.
- **Exactly one bug per failed run, under every failure mode:**
  1. Before calling Jira, write a **creation intent** row keyed on the run ID: state `INTENT`, plus a unique marker that is written into the bug (an entity property, plus a label such as `va-run-<id>`).
  2. Create the issue. On success, record the key: state `CREATED`.
  3. On a timeout or ambiguous response, **reconcile**. Search for the marker (JQL on the label, then confirm the entity property). Exactly one match: record it as `CREATED`. No match after the search is confirmed complete: retry once. More than one match, or the search itself fails: state `NEEDS_REPAIR`.
  4. `NEEDS_REPAIR` stops all automatic attempts and alerts admins. An admin links the right bug or confirms none exists, and that decision is audited. There are no blind retries.
- **Content.** Issue type from the project's defect mapping. Pre-filled with:
  - test key and signed version
  - execution
  - configuration, release and environment
  - the failed steps, with their actual results and comments
  - links to their evidence

  Created as a child of **the failed test's parent** (owner decision 10), and linked to the test and the execution. It is not linked to source issues: the trace runs through the test's `Verifies` links. The tree-membership policy (owner decision 11) keeps the bug out of the parent's governed tree, so creating it never drifts or holds the Epic.
- **Created by the app (`asApp`).** **Reporter preflight.** When the project is enabled and again before each create, check whether the app may set Reporter. That needs the *Modify Reporter* permission in the project ([Atlassian](https://support.atlassian.com/jira/kb/you-dont-have-permission-to-modify-the-reporter-in-this-project-in-jira/)) and Reporter on the create screen. If it may, the signer is the Reporter. If not, the bug's Reporter is the app, and the signer is named in the bug and in its audit entry. Settings show which mode is in force. A refused create is never retried with a different payload behind the admin's back.
- **Pending state.** Until the intent is `CREATED`, the run shows **Bug pending** (or **Bug needs repair**), and the execution guard holds Done.
- Testers may also use Report Bug or link an existing bug during a run, as in codebeamer. Those are extra bugs, not a substitute for the automatic one.

## The `Verifies` link through the whole governance pipeline

Owner decision 8 says the test owns `Verifies`. Today VAtlassian always hashes `issuelinks` (`ALWAYS_CONTROLLED_FIELDS`, `src/lib/content.js`), measures a link change at **both** ends (`src/triggers/issue-link.js`), and its link worker writes a new baseline on the other issue after an approval (`src/jobs/linkWorker.js`, `lib/approval/linkPropagation.js`). Ownership therefore has to be applied in every stage:

- **A versioned link policy, recorded per baseline.** Each baseline records the link policy it was captured under:
  - **v1:** today's rule, every link.
  - **v2:** excludes, on the **source** end, `Verifies` links whose other end is a Test. It also excludes test management's internal link types on **both** ends: plan/set membership mirrors, retest links and bug links.

  The policy ID is part of the hash basis (`lib/hashBasis.js`) and of the stored baseline. **Existing baselines keep v1.** Their hash and drift rule never change silently. They move to v2 only when their next approval captures a new baseline, or through an explicit, audited admin migration that re-baselines them under v2. No baseline is ever re-hashed under a rule it was not signed with.
- **Capture** applies the baseline's policy when hashing links.
- **Drift** (`issue-link.js`, `collect.js`, `liveDrift.js`, `interception.js`): a link event on an end whose policy excludes that link records nothing for that end. The other end is still measured under its own policy.
- **Restore** never adds or removes a link that the baseline's policy excludes. A rejected change on a source cannot strip a test's `Verifies`.
- **Propagation.** The link worker never derives a new baseline on an end whose policy excludes the link.
- **Draft links live in test data.** A `Verifies` added in a draft is stored in SQL with the draft, not in Jira. It is written to Jira, through an outbox and reconciler, only when the signed version is committed. A Jira `Verifies` link added or removed by hand outside a signed version is drift on the Test, and makes governed coverage **Unknown** for that source.
- The same per-baseline policy is how internal link exclusions stay consistent across capture, drift, restore and propagation.

## Suspect and what clears it

- A test turns **Suspect** for a source when that source gets a new approved baseline, or has drift, after the test version was signed against an earlier baseline.
- **Unapproved source drift cannot be cleared.** While the source is drifted, the row stays Suspect (governed coverage **Unknown**). It clears only once the source's change is approved (new baseline) or rejected (restored).
- **Clearing against a new approved baseline** takes a signed `SUSPECT_REVIEW`. It records the test version, the old and new approved source baselines, the reviewer, the decision ("test still fits" or "test must change") and the rationale. "Test must change" leaves the test Suspect until a new test version is signed.
- **The review does not revalidate old runs.** "Test still fits" clears the test *definition* only. The source's governed coverage then needs **a new run** against the new baseline, unless a separate signed `APPLICABILITY` decision states why the old run's evidence still verifies the changed requirement. It must name the run, both baselines and the rationale. Reports show which rows rest on an applicability decision.
- The Suspect concept is common practice ([IBM ETM](https://www.ibm.com/docs/en/engineering-lifecycle-management-suite/test-management/7.3.0_beta?topic=artifacts-suspect-traceability-in-engineering-test-management)). The exact link-ownership rule is VAtlassian's decision.

## Frozen release scope

- The release is not "whatever signed plans currently carry that fix version". That set moves.
- A **release-scope revision** is a SQL record signed as `RELEASE_SCOPE`. It contains the Jira version ID, the exact plan revisions, the required tests, the configurations, and its own digest.
- Release reports, coverage and the dossier are computed against one named, signed release-scope revision. Changing scope means signing a new revision, and the older one stays readable.

## Jira and Forge feasibility, mechanism by mechanism

The owner asked that nothing in this design rest on an unchecked assumption about Jira. Each mechanism is listed with where it is already proven. Anything not proven on Jira gets a spike before the task that depends on it, and that task fails at its gate if the spike fails.

| Mechanism | Where it is already proven | Status |
|---|---|---|
| Issue panels per work type, project page board, project settings page, admin pages | AssureX (observed live in ATX, 2026-10-19); VAtlassian (panel and admin pages, live) | Proven |
| Creating the six work types in a company-managed project | AssureX (observed); VAtlassian `scripts/requirements-setup` (Requirements / Source Document) | Proven |
| Create buttons opening Jira's own create dialog with the type preset | AssureX (observed) | Proven |
| Test history in the issue Activity tab | AssureX "AssureX History" (observed) | Proven on Jira; VAtlassian module spike |
| Opening the full-page board / run screen in a new window from a panel | AssureX (observed) | Proven |
| Excel / PDF / CSV export | AssureX Compliance Report (observed) | Proven; Word export is a client-side library, spike |
| Controlled transitions, the validator holding a transition, no-eligible-signer denial | VAtlassian (live since 8.x, `va-gate`) | Proven |
| TOTP signature bound to a content hash, single use, audit chain | VAtlassian (live) | Proven |
| Baselines over Jira fields, links and attachments; drift flag and hold | VAtlassian (live-verified 2026-10-13) | Proven; adding the SQL version digest to the hash basis is new code |
| Per-link-type filter in link drift | Not applicable | New VAtlassian code, no Jira dependency |
| Detailed records in Forge SQL | VAtlassian (`sql: main`, live) | Proven for today's volumes. AssureX keeps this on AWS PostgreSQL, so **its scale proves nothing for Forge SQL**. Scale test in the core acceptance (plan Task 10) |
| App creating the automatic bug (`asApp`, `write:jira-work` already granted) | Standard Jira REST; VAtlassian already writes issues as the app (restore) | Expected to work; spike |
| Reporter set to the signer on an app-created bug | Requires the app to hold *Modify reporter* and Reporter on the create screen | **Unproven.** Fallback: Reporter is the app and the signer is named in the bug and its audit entry |
| CI upload through a static web trigger | Forge documented feature; AssureX uses its AWS API instead | Unproven on VAtlassian; spike in plan Task 11 |
| AI suggestions on Forge LLM | VAtlassian declares `llm: va-llm` and `lib/aiClassification.js` uses it; AssureX uses its AWS backend | Partly proven; plan Task 13 |
| Xray / Zephyr migration from export files | AssureX uses vendor APIs instead | Unproven; plan Task 12 |
| Biometric sign-off under Runs on Atlassian | Not applicable | Deferred (owner decision 7) |

## Relationship to AssureX and codebeamer (clean room)

AssureX and codebeamer are **feature references**, not sources. Features, workflows and ideas are what we learn from them: what a tester needs, what an auditor asks. We do not use their code, their UI artwork or layout, their help text or their names. Evidence comes from using the products as a customer, from their public documents and from Marketplace listings, and the AssureX bundle stays unread. VAtlassian's design differs where it matters: it keeps no data off Atlassian, it requires signed versions and signed runs, and it keeps an append-only record. **Before release, a lawyer reads AssureX's customer terms** (EULA or Marketplace listing terms) for any clause on reverse engineering or competing use. The Atlassian Marketplace Partner Agreement restricts vendors from reverse engineering *Atlassian's* code, not other vendors' apps, and it does not answer this question.

## Settled during design review (builder's calls unless marked)

1. *Built 2026-10-21 differently, for the first slice:* a test version is signed through its own configurable chain as a `tm_signature` of kind `TEST_VERSION`, with the same controls (role eligibility, authenticator, digest-bound, once per step, audit entry). The version digest includes the test's parent. Folding the SQL digest into the Jira baseline hash basis, as described next, is still the target for when Tests are also governed by controlled transitions.
   **Test versions and plan revisions are signed through controlled transitions on their own Jira issues** (owner decision 4: the client configures who signs). The Test issue's workflow carries an approve transition, which the client configures as controlled. Baseline capture for a Test extends its hash basis with the SQL version digest: ordered steps, pre/post-actions, dataset, preconditions, attachment hashes. Publishing a new version sends the Test back through a revise transition and then approval again, as Requirements work today. Test Plan issues work the same way, with the plan revision digest. "Its own approvers" on a run is read from that baseline.
2. **Jira fields of a signed Test follow the existing drift rule.** An edit is held and never silently accepted. "Later edits are drafts" applies to the SQL-held content, which always goes to a new version. Link types that test management creates internally are **excluded** from the `issuelinks` drift digest: plan/set membership mirrors, retest links, bug links. This needs a per-link-type filter in tracked links. The automatic bug links to the test and the execution, **not** to source issues. The trace to the source runs bug → run → test → `Verifies`. `Verifies` belongs to the Test's signed version (owner decision 8), so it is excluded from the **source's** link drift. On the Test it is compared against the signed version, and an unversioned edit to it is drift.
3. **Every run ends in a terminal state:** fully signed, Rejected, or **Not executed**. Not executed is a `RUN_NOT_EXECUTED` signature with a reason, by a holder of the first chain step's role. It is the one exception to item 7's rule, because nobody recorded results. A Blocked run must be resumed or closed as Not executed. An execution is *finished* when every run is terminal, and only then can it reach Done. A selective re-run defaults to Failed, Rejected and Not executed runs.
4. **Release scope** is a signed release-scope revision (see Frozen release scope), not a live query. An official run may also come from an execution created directly from a signed test. It counts toward that test's coverage, but not toward a plan's required set unless the plan includes it.
5. **What counts as passing for a release:** a fully signed Passed run. Whether a signed **Partly Passed** run also counts is a project setting, **default: it does not**. Skipping an iteration needs a reason, which is recorded in the run and covered by its signature. A signed Not applicable run counts as Not applicable, and its signed reason is the "approved rationale".
6. **Dataset overrides on official runs** are allowed only when they are part of a signed plan revision (the plan carries the override and its digest). Otherwise an override is possible only on an Unofficial run.
7. **Attribution.** Every step result records who entered it. The "Executed by" step must be signed by someone who recorded results in that run. Other configured steps follow the separation setting.
8. **The automatic bug is created by the app (`asApp`).** Reporter, the exactly-once guarantee and the repair path are in "Automatic bug on a failed run".

## Release bars and sequencing

**Test-management core (built first):** setup, authoring/versioning, step reuse and pre/post-actions, datasets, plans/sets/preconditions, configurations/releases, execution/evidence, result rules, run sign-off chain, automatic bug, selective re-run, operational/governed coverage and auditor report. It does not depend on a requirements workspace. It is an internal milestone, not the product release.

**Full AssureX-style capability breadth (built second):** CI/JUnit with evidence, file migration/import, configurable admin/reporting (all ten report destinations, coverage export to Word/Excel/PDF/CSV), and opt-in AI suggestions. **Test management is released, and called complete, only when core and breadth have both passed live acceptance** (owner decision 1).

**Future one-stop V-cycle:** requirements authoring workspace/tree, hierarchy and source control, non-test verification methods, suspect propagation across the full graph, and system validation. This is a later product phase and is not smuggled into the test-management release claim.

## Current state and sources

The October 19 AssureX plan is a proposal, not an implementation. In VAtlassian, `Verification Method` and `Verifies` appear in the requirements setup plan, while `va_trace_node`, `va_trace_edge` and `va_trace_run` are reserved comments, not tables. There are no `tm_*` migrations or test-management UI/resolvers in this checkout. Preserve the existing dirty/untracked requirements work during execution.

Checked references: [AssureX product page](https://gudakesa.com/assurex/), [AssureX Marketplace page](https://marketplace.atlassian.com/apps/1803488583/assurex), [Runs on Atlassian rules](https://developer.atlassian.com/platform/forge/runs-on-atlassian-apps/), [static web triggers](https://developer.atlassian.com/platform/forge/manifest-reference/modules/web-trigger/), [Forge SQL limits](https://developer.atlassian.com/platform/forge/storage-reference/sql/), and [Forge Object Store](https://developer.atlassian.com/platform/forge/storage-reference/object-store/).
