# VAtlassian test management first — design

Status: proposed implementation target, 2026-10-20, revised the same day with the owner's decisions (next section). The feature is not built. This design supersedes the earlier test-plus-requirements draft; requirements management is a later product phase.

## Owner decisions, 2026-10-20

These came from the product owner and override anything below that reads otherwise.

1. **The target is complete test management.** That means every AssureX test capability (authoring, data, plans, execution, board, reports, admin, import, CI, AI), reshaped to work the way a compliance auditor wants. Codebeamer sets the bar for rigor: result rules, configurations and releases, re-runs, coverage. In one line: AssureX supplies the everyday authoring and board experience, and codebeamer supplies the result rules, re-runs and coverage discipline. The core/breadth split below is a **build order**, not a smaller product. Test management is done only when both are done.
2. **The auditor's first question is answered on the run itself.** For any run, the auditor asks: which signed test version did it use, who signed it off, when, and what was the result? The answer is one click from the run and comes from the signature records and the `va_audit` chain, never from an editable field.
3. **No official run without a signed version.** A run that counts can only be created from a test version that has been approved and signed. Unsigned drafts can be edited freely but never executed for the record.
4. **The client decides who signs what. VAtlassian enforces it with no exceptions.** Sign-off uses VAtlassian's existing controlled-transition rules: the role, the assurance level, a signature bound to the content hash and usable exactly once, and an audit entry. A typical setup is the tester signing and the QA lead countersigning, but the client may configure any number of sign-off steps. If no user holds the configured role, the step cannot be signed and the run cannot move forward. There is no admin override, no "skip" and no fallback signer.
5. **One bug per failed run, created automatically** when the run is signed off as Failed. It is not created per step and not at the moment a step is clicked.
6. **A signed run never changes.** A retest is always a new run, linked to the failed run and its bug.
7. **Biometric versus Runs on Atlassian is deferred** to Marketplace submission. TOTP is the assurance level for test sign-off until then.

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
| Defects | Create/link defect from test/run/step, defect mapping, defect traceability; codebeamer: Report Bug from the runner, pre-filled | Exactly one bug created automatically when a run is signed off as Failed, pre-filled and linked to the run, test, execution and source issues; manual Report Bug / link existing during a run as well; failed run and its proof preserved; closure plus a signed passing retest required before a green release result |
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

- **Operational coverage** for ordinary Jira issues: linked tests, latest qualifying results, defects and run evidence, labeled with the selected Jira scope and time. It never claims an approved requirement baseline.
- **Governed coverage** only where a VAtlassian-approved source baseline and controlled link snapshot actually exist: `issuelinks` must be controlled, the relevant link IDs/directions must be in the signed snapshot, and the complete current link set must be read. Exact source baseline, test version, run attempt and evidence are pinned. A source or link change after execution marks the row suspect. If a baseline or complete link read is missing, governed coverage is **Unavailable/Unknown**, not Passed.

The future requirements-management module can implement `listCoverableSources`, `readApprovedSourceSnapshot` and `readSourceImpact` behind this adapter, without migrating or rewriting test runs. Test management must preserve source issue ID and optional baseline reference now so that later traceability can use it.

## Auditor rules for test management

1. Draft, published and approved are separate states. Publishing freezes a test version; VAtlassian approval/signature applies to that exact digest, including its SQL-backed steps, pre/post-actions, dataset, preconditions and attachment hashes. Approval must re-read the Jira and SQL content before signing. A plan revision freezes membership and versions. **An official run can be created only from an approved (signed) test version**, and records exactly which one. *Builder's call:* a dry run against an unsigned version may exist for authoring convenience. If it does, it is visibly marked **Unofficial**, cannot be signed off, never creates a bug automatically, and is excluded from coverage, reports, metrics and the dossier.
2. A final result is append-only. Corrections and reruns create new runs with actor, reason and timestamp. Configured display status maps to a stable semantic status (`PASSED`, `PARTLY_PASSED`, `FAILED`, `BLOCKED`, `NOT_APPLICABLE`, `NOT_RUN`, `IN_PROGRESS`), captured at the time of the run; later status renames do not change history.
3. A release row is `Unknown` for incomplete/hidden data or broken evidence; `Suspect` for changed source/link/test/plan/dataset after execution; `Failed` for latest required failure or unresolved blocking defect; `Passed` only when every required test has a **fully signed** (every configured sign-off step) passing run for the selected configuration/release/environment and all evidence is available; `Planned` for linked but unexecuted or not-yet-fully-signed tests; `Not covered` for none. `Not applicable` requires approved rationale.
4. Operational and governed coverage are separate columns/reports. A green operational result cannot be relabeled as governed by export formatting. Validation tests can be marked `VALIDATION` and linked to an intended-use Jira issue, but full V-cycle verification-method and requirements-management controls are future work.
5. Reports are generated from a frozen release scope and state their filters, timestamp, app version, source status, completeness and blockers. They include test/plan versions, run attempts, evidence manifest, defects/retests, configuration meanings and audit-chain check. A partial report may be exported only with a clear `INCOMPLETE` mark; it is never a compliant dossier.

## Run sign-off

A run is a SQL record inside a Test Execution issue, not a Jira issue, so there is no Jira workflow transition per run. Sign-off still uses **the same signing engine** that guards controlled transitions today: role eligibility (`va_eligibility`, `lib/eligibility.js`), assurance level and challenge (`lib/approval/*`), a signature bound to a content hash and consumed once by compare-and-swap (`lib/signatures.js`), and an entry in the `va_audit` chain. No second, weaker signing path is introduced.

- **Configurable sign-off chain.** A project admin defines an ordered list of sign-off steps for runs: role, assurance level, label (for example "Executed by" and "Reviewed by"). The chain has one step or more, and the client chooses how many. *Builder's call:* default chain is one Tester step then one QA step, and by default the same person may not sign two steps of one run. Both are settings the client can change.
- **What is signed.** The run digest: pinned test version digest, configuration, release, environment, iteration values, every step result, actual result, comment and evidence SHA-256, and the rolled-up result. Any change between challenge and consume is rejected (`CONTENT_CHANGED`). Once the first step is signed, results are frozen. A later step only adds its signature.
- **No eligible signer, no progress.** If nobody holds the step's role, the step shows who is needed and stays unsigned. Admins get no override.
- **Rejection.** A countersigner may reject instead of signing. The rejection is recorded with reason. The run keeps its existing signatures (a signature is never undone), is marked Rejected, and counts for nothing. Coverage then needs a new run.
- **The Jira side.** The Test Execution issue's own workflow stays under ordinary VAtlassian controlled transitions, which the client configures. In addition, the existing validator holds any transition into a Done-category status while a run in that execution is unsigned, partly signed, or waiting for its automatic bug.
- **Roles.** The fixed role list in `src/lib/roles.js` (Reviewer, Approver, QA) gains **TESTER**, added under that file's own rules. People are assigned to roles per project in the existing People screen.
- **What the auditor sees.** Every run shows, without navigation: test key and signed version (with its own approvers), configuration, release, environment, result, and each sign-off step's signer, time, assurance level and audit-chain entry.

## Result rules (from codebeamer)

Computed on the server from step and iteration results; the tester cannot enter an overall result that contradicts them.

- A step is Passed, Failed, Blocked, Not Applicable or Not Run.
- An iteration is **Failed** if any step failed; **Blocked** if any step is blocked and none failed; **Not Applicable** if every step is N/A; **Passed** if every step is Passed or N/A (at least one Passed).
- A run is **Failed** if any iteration failed; **Blocked** if any is blocked and none failed; **Partly Passed** if some iterations were deliberately skipped and every executed one passed; **Passed** if all passed; **Not Applicable** if all are N/A.
- N/A steps are ignored when other steps have real results.
- **Blocked is not final**: the run cannot be signed off; testing resumes from the blocked step once the cause is removed.
- Post-actions are recorded on every run, whatever the result.
- Configured statuses (AssureX-style names, colours, Is Final, coverage mapping) map onto these semantic results; the mapping in force is captured with each run.

## Configurations, releases and re-runs (from codebeamer)

- A **test configuration** is a named variant the product is tested on (for example a browser, OS or hardware build). A **release** is the Jira fix version under test. An execution names one release and one or more configurations. Each configuration gets its own run per test.
- **Selective re-run**: from a finished execution, create a new execution with only the chosen runs (default: failed and blocked), against the same or a newer signed version. The old execution and its runs are untouched. The new runs link back to the ones they retest.
- Coverage counts only the latest fully signed run per test × configuration × release.

## Automatic bug on a failed run

- Trigger: the **first** sign-off step of a run whose rolled-up result is Failed (the tester's signature, under the default chain).
- Exactly one bug per failed run. The bug is idempotent on run ID, so retries, duplicate events or a second sign-off step never create another.
- Issue type from the project's defect mapping. Pre-filled with test key and signed version, execution, configuration, release, environment, the failed steps with their actual results and comments, and links to their evidence. Linked to the test, the execution and the source issues the test verifies.
- If Jira refuses the create (permission, required field), the signature still stands. The run shows **Bug pending**, a queue retries, admins are alerted, and the execution cannot reach Done until the bug exists.
- A QA rejection of the run does not delete the bug. People close it in Jira as usual. Testers may also use Report Bug or link an existing bug during a run, as in codebeamer. Those are extra bugs, not a substitute for the automatic one.

## Settled during design review (builder's calls unless marked)

1. **Test versions and plan revisions are signed through controlled transitions on their own Jira issues** (owner decision 4: the client configures who signs). The Test issue's workflow carries an approve transition, which the client configures as controlled. Baseline capture for a Test extends its hash basis with the SQL version digest: ordered steps, pre/post-actions, dataset, preconditions, attachment hashes. Publishing a new version sends the Test back through a revise transition and then approval again, as Requirements work today. Test Plan issues work the same way, with the plan revision digest. "Its own approvers" on a run is read from that baseline.
2. **Jira fields of a signed Test follow the existing drift rule.** An edit is held and never silently accepted. "Later edits are drafts" applies to the SQL-held content, which always goes to a new version. Link types that test management creates internally are **excluded** from the `issuelinks` drift digest: plan/set membership mirrors, retest links, bug links. This needs a per-link-type filter in tracked links. The automatic bug links to the test and the execution, **not** to source issues. The trace to the source runs bug → run → test → `Verifies`. How a `Verifies` link on a baselined source is treated is the owner's decision 8 (below).
3. **Every run ends in a terminal state:** fully signed, Rejected, or **Not executed**. Not executed is a closure with a reason, signed by the first sign-off step's role. A Blocked run must be resumed or closed as Not executed. An execution is *finished* when every run is terminal, and only then can it reach Done. A selective re-run defaults to Failed, Rejected and Not executed runs.
4. **Release scope** is the union of the signed plan revisions whose fix version is that release, and the required tests come from those revisions. An official run may also come from an execution created directly from a signed test. It counts toward that test's coverage, but not toward a plan's required set unless the plan includes it.
5. **What counts as passing for a release:** a fully signed Passed run. Whether a signed **Partly Passed** run also counts is a project setting, **default: it does not**. Skipping an iteration needs a reason, which is recorded in the run and covered by its signature. A signed Not applicable run counts as Not applicable, and its signed reason is the "approved rationale".
6. **Dataset overrides on official runs** are allowed only when they are part of a signed plan revision (the plan carries the override and its digest). Otherwise an override is possible only on an Unofficial run.
7. **Attribution.** Every step result records who entered it. The "Executed by" step must be signed by someone who recorded results in that run. Other configured steps follow the separation setting.
8. **The automatic bug is created by the app (`asApp`)** with the first signer as Reporter. Retries then work without the signer present. Failure is limited to app-side causes: a mapping with no creatable type, or a required field the app cannot fill. That is surfaced as "Bug pending" plus an admin alert.

## Release bars and sequencing

**Test-management core (built first):** setup, authoring/versioning, step reuse and pre/post-actions, datasets, plans/sets/preconditions, configurations/releases, execution/evidence, result rules, run sign-off chain, automatic bug, selective re-run, operational/governed coverage and auditor report. It does not depend on a requirements workspace. It is an internal milestone, not the product release.

**Full AssureX-style capability breadth (built second):** CI/JUnit with evidence, file migration/import, configurable admin/reporting (all ten report destinations, coverage export to Word/Excel/PDF/CSV), and opt-in AI suggestions. **Test management is released, and called complete, only when core and breadth have both passed live acceptance** (owner decision 1).

**Future one-stop V-cycle:** requirements authoring workspace/tree, hierarchy and source control, non-test verification methods, suspect propagation across the full graph, and system validation. This is a later product phase and is not smuggled into the test-management release claim.

## Current state and sources

The October 19 AssureX plan is a proposal, not an implementation. In VAtlassian, `Verification Method` and `Verifies` appear in the requirements setup plan, while `va_trace_node`, `va_trace_edge` and `va_trace_run` are reserved comments, not tables. There are no `tm_*` migrations or test-management UI/resolvers in this checkout. Preserve the existing dirty/untracked requirements work during execution.

Checked references: [AssureX product page](https://gudakesa.com/assurex/), [AssureX Marketplace page](https://marketplace.atlassian.com/apps/1803488583/assurex), [Runs on Atlassian rules](https://developer.atlassian.com/platform/forge/runs-on-atlassian-apps/), [static web triggers](https://developer.atlassian.com/platform/forge/manifest-reference/modules/web-trigger/), [Forge SQL limits](https://developer.atlassian.com/platform/forge/storage-reference/sql/), and [Forge Object Store](https://developer.atlassian.com/platform/forge/storage-reference/object-store/).
