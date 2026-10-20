# AssureX → VAtlassian: test management that Runs on Atlassian

Status: historical proposal, 2026-10-19. Nothing built. This file contains
both public sources and the later signed-in ATX observations in section 6.
The test-management-first [capability matrix](../research/assurex-test-capability-matrix.md)
records the 2026-10-20 read-only report observations and explicit unknowns.

## 1. The two findings that shape everything

**AssureX is not Runs on Atlassian because of its backend, not its UI.** Its own
Terms of Use and data pages say: a Forge frontend inside Jira, plus "a Node.js
backend hosted by Gudakesa on Amazon Web Services (AWS) for compute, storage, and
file handling", with "a managed PostgreSQL database hosted on AWS" and AWS object
storage for attachments. Its AI test generation, Xray/Zephyr migration, CI API
tokens and "Atlassian connection" (OAuth 3LO) all exist to serve that backend.
Every one of them has a Forge-hosted equivalent (section 3).

**VAtlassian is not Runs on Atlassian today either.** `forge eligibility`, run
2026-10-19:

| Environment | Version | Verdict | Reasons |
|---|---|---|---|
| development | 8.21.0 | **not eligible** | "App is egressing data"; "App is using a webtrigger module that can egress data" |
| production | 1.1.0 | eligible | — |

The flags it checks: `HAS_REMOTES`, `HAS_CONNECT_MODULES`, `HAS_DEFINED_EGRESS`
(true), `HAS_EXPOSED_CREDENTIALS`, `HAS_EGRESS_WEBTRIGGER_MODULE` (true),
`HAS_PERSONAL_API_TOKEN_USAGE`, `HAS_ENABLED_CONFIGURABLE_EGRESS`. Forge SQL,
Object Store, queues and Forge LLMs are not on the list.

The two causes are in `manifest.yml`:
- `permissions.external.fetch.client: "*"` — kept only so the biometric
  (WebAuthn) ceremony popup gets `allow-popups`; the comment already says "THIS
  BLOCK FORFEITS RUNS ON ATLASSIAN".
- `webtrigger: va-probe` — marked "TEMPORARY live probe ... Remove when done",
  dynamic response.

So porting AssureX cleanly is pointless unless phase 0 makes VAtlassian itself
eligible again and keeps it that way.

## 2. AssureX feature inventory (what "exact functionality" means)

Source key: **G** product guide, **S** Marketplace screenshot, **C** Confluence/AI
guide, **T** API-token guide, **D** data/terms pages.

### Work types (created per project when enabled) — G
Test (TestCase), Test Plan, Test Set, Test Precondition, Test Execution, and
(live, 6a) TestDefect. Enabling is per project, company-managed only.

### Issue panels — G, S
| Panel | On | Behaviour |
|---|---|---|
| Test Details | Test | Tabs: Test Details / Test Plans / Preconditions / Test Sets / Test Runs. Test type selector (Manual + admin-defined step-based types). Steps of Action / Data / Expected Result, each a rich-text editor; drag to reorder; per-step attachments; Add Step; Edit in Dialog; collapse/expand. `${Param}` tokens in Data bound to a **Dataset** (data-driven). **Versions**: "Version 1 is out of sync — 1 drafted change is not yet part of Version 1. 4 changes remain before sync is required", with View Version / Create Version / Sync Now. **Import** and **Export** (To csv, To json). |
| Tests | Test Plan | Grouped tests; link, sort, paginate. |
| Precondition details | Precondition | Conditions required before linked tests run. |
| Test Sets | Test | Add/remove the test to one or more sets (smoke, regression). |
| Test Run | Test | Lists runs; Play starts an execution and opens the board. |
| Execution Details | Execution | Not described publicly — **gap**. |
| Test Coverage | configured types (default Story) | Tabs Test Cases / Test Plans; Add; table Key, Summary, Status, Test Status (e.g. PASSED). "Generate Test Cases" (AI, beta). |

### AssureX Board (project page tab) — G, S
- Test Executions list: key, summary, status lozenge, linked plan chip,
  pass/fail/todo progress bar, assignee; Create Test Execution; pagination.
- Execution view: breadcrumb Projects / AX / Test Plans / AX-8 / Test Executions /
  AX-17; fields (Description, Test Plans, Assignee, Fix Version/s, Revision, Test
  Environments); pass/fail totals bar; per-test row with result, assignee,
  dataset/iteration icon, Play; Add tests; Edit.
- Step runner: step statuses, notes, attachments, iterations, environments.
- Traceability report: per requirement — Tests (fully / partially covered),
  Test Runs (failed / passed / to do), Defects; quick filters Fully covered,
  Partially covered, Not applicable, Not covered; fix version.

### History — G
"AssureX History" option in the issue Activity section of AssureX work items:
updates, executions, status changes.

### Administration — G, S
Global (Apps → AssureX): Settings, Configuration, Test Types, Import Test, Test
Statuses, Test Step Statuses, Test Environments, Parameter Value Lists, Xray
Migration (Credentials → Backup → Discovery → Validation → Execution; Xray
client id/secret, include attachments, resume by Session ID), Zephyr Migration
(Credentials → Validation → Field Mapping → Execution; bearer token, auto-detects
Scale vs Squad/Essentials), Token Settings.
Project settings: enable, Test Coverage Settings (which types get the panel), AI
Settings (one PRD source per project: Confluence page or uploaded document →
AI briefing, with Replace / Unlink / Retry).

### AI test generation — C
From an issue with the coverage panel: gathers summary, description, type,
comments, subtasks, linked issues, supported attachments, existing linked tests,
previously rejected scenarios, project PRD briefing, linked Confluence pages
(storage format, fallback to remote-link summary). Returns scenarios to review,
select, reject, restore, regenerate, "generate more"; creates the selected ones
as Test issues. Never auto-creates. Confluence is read-only, no macro.

### Automation API — T
Per-user bearer tokens (named, expiry ≤ 1 year, shown once, revocable), owned
by the creating user and bound to the site; calls evaluated with that user's Jira
and project permissions. `GET /health`, `GET /automation/health`; other
`/automation` endpoints not documented publicly — **gap**.

## 3. Runs-on-Atlassian mapping

| AssureX piece | Why it egresses | VAtlassian equivalent (no egress) |
|---|---|---|
| Node.js on AWS | remote compute | Forge functions + resolvers (existing pattern: `src/usecases`, `src/resolvers`) |
| PostgreSQL on AWS | remote storage | Forge SQL (`sql: main`, already declared); new `tm_*` tables |
| AWS object storage (attachments) | remote storage | Jira attachments on the Test / Test Execution issue (Jira-permissioned, visible natively); Forge Object Store (`fos`, already declared) only where an immutable copy is needed |
| Remote AI backend | egress of issue + Confluence content | Forge LLMs (`llm: va-llm`, `model: [claude]`, already declared; same pattern as `src/lib/aiClassification.js`) |
| Confluence PRD / page fetch | — (Atlassian API) | `requestConfluence` with Confluence read scopes as an optional product; **spike**: cross-product install and scopes |
| "Atlassian connection" (OAuth 3LO) | needed only by the AWS backend | not needed: `asApp` / `asUser` |
| `/automation` REST with bearer tokens | inbound API on vendor host | **static** web trigger (`response.type: static`, fixed `outputs` such as 202 / 400 / 401) + app-issued tokens (hash in SQL) + queue consumer that parses JUnit / Cucumber JSON / TestNG / Xray JSON. Behaviour change: the CI caller cannot get created keys back in the response; it tags the upload with its own run id and finds the execution by JQL. |
| Xray / Zephyr migration via their cloud APIs | egress to getxray.app / smartbear | File-based import: the admin exports from Xray / Zephyr and uploads the file; parsing and mapping run in Forge. Same wizard steps minus "Credentials". Behaviour change: no live discovery against the source tool. |
| CSV / JSON export | — | client-side Blob download (existing `frontend/src/lib/result.ts` `download`) |

Rule for the whole port: **no `remotes`, no `external.*` permissions, no dynamic
web triggers, no personal API tokens.** Enforced by phase 0's gate.

## 4. Where it lands in VAtlassian

Not a second app. A "Test" area inside the existing app, so tests join the trace
model VAtlassian already plans: `scripts/requirements-setup/plan.mjs` already has
a **Verifies** link type ("verifies" / "is verified by") and a requirement field
**Verification Method** with option **Test**.

**Relationships**
- Requirement / Story ↔ Test: Jira issue link **Verifies** (JQL-visible; the
  existing link worker already baselines links, so a baselined requirement's
  coverage becomes part of its evidence).
- Plan → tests, set → tests, test → preconditions, execution → tests: SQL
  membership (ordered), mirrored as Jira issue links with From → To rules so
  it is JQL-visible and baselined. AssureX keeps this membership only in its
  backend (6d); the mirror is a deliberate improvement.

**SQL (new, `tm_` prefix, added in `src/db/migrations.js`)**
config: `tm_project` (enabled, coverage issue types, PRD source), `tm_test_type`,
`tm_status`, `tm_step_status`, `tm_environment`, `tm_param_list`,
`tm_param_value`.
authoring: `tm_test_version` (number, state draft/published, created_by),
`tm_step` (version, position, action/data/expected ADF, attachment ids),
`tm_dataset`, `tm_dataset_row`, `tm_membership` (container issue, member
issue, kind, position; mirrored to Jira links), `tm_link_rule` (link type, from types, to
type), `tm_step_field`, `tm_run_field`, `tm_access_rule` (action, roles,
groups, users, project override).
execution: `tm_run` (execution issue, test issue, test version, iteration,
environment, status, assignee), `tm_step_result` (run, step, status, actual,
note, attachment ids), `tm_defect` (run/step → bug issue).
automation: `tm_api_token` (hash, owner account, name, expiry, revoked),
`tm_import_job`.
history: `tm_event` (issue, actor, kind, payload, at).

**Manifest additions** (all no-egress)
- `jira:issuePanel` × 7 with `displayConditions` by issue type (Test Details,
  Plan tests, Precondition, Sets, Runs, Execution details, Coverage).
- `jira:projectPage` "Test board" (executions list, execution view, step runner,
  traceability report).
- `jira:projectSettingsPage` (enable, coverage types, AI settings).
- new `jira:adminPage` sections: Test types, Statuses, Step statuses,
  Environments, Parameter lists, Import, Migration, API tokens.
- `jira:issueActivity` "Test history" (**spike**: confirm module support).
- `webtrigger` static, `consumer` + queue for imports and migrations.
- Issue types created by the app on project enable via REST `asApp`
  (`manage:jira-configuration` is already granted), reusing the field/screen
  logic in `scripts/requirements-setup/*`.

**The part AssureX does not have** (phase 9, after parity): a Test version
becomes a signed baseline (AssureX's "Create Version" ↔ VAtlassian approval);
editing a published version only ever makes a draft; an execution records the
exact test version it ran; signing off an execution writes to the `va_audit` hash
chain; the traceability report shows baseline state alongside coverage. Steps
live in SQL, not Jira fields, so baseline capture needs a test-steps content
source. That is a design task, not a copy task.

## 5. Phases

| # | Phase | Done when |
|---|---|---|
| 0 | **Get VAtlassian eligible and keep it eligible.** Remove `va-probe` (or make it static). Decide the biometric path (below). Add `forge eligibility -e development --non-interactive` to `npm run deploy` so an ineligible build cannot ship. | `forge eligibility` reports eligible for the development build |
| 1 | **Close the evidence gaps** (section 6) on the installed AssureX: runtime observation in the signed-in browser. | gap list answered or marked unknown |
| 2 | Foundation: `tm_*` migrations, project enable (types, Verifies link, screens), admin config pages. | admin can enable a company-managed project and define statuses, environments, parameter lists, test types |
| 3 | Authoring: Test Details (steps, reorder, attachments, dialog editor, datasets/params, versions + drafts + sync, CSV/JSON import/export), Precondition, Test Sets, Test Plan panels. | parity with screenshots 3, 5, 6 |
| 4 | Execution: Test board, executions list, create execution, execution view, step runner with iterations/environments/notes/attachments, defect creation. | parity with screenshots 2, 9 |
| 5 | Coverage panel, traceability report with quick filters, test history. | parity with screenshots 1, 4 |
| 6 | CI import: tokens UI, static web trigger, queue parser for JUnit / Cucumber / TestNG / Xray JSON. | a CI job posts JUnit XML and a Test Execution appears |
| 7 | Migration from Xray / Zephyr export files. | a sample Xray export imports with steps, sets, plans |
| 8 | AI generation on Forge LLMs, Confluence context, PRD briefing. | generates, reviews, creates tests with zero egress |
| 9 | Compliance integration (section 4, last paragraph). | separate design spec first |

Phases 2–5 are one dependency chain. 6, 7 and 8 depend only on 2–3 and can run
in parallel after that.

## 6. Evidence and gaps

**Observed:** Marketplace API (`com.gudakesa.jira.assurex` 9.6.0, build 3000290,
2026-10-15, cloud, not Connect); 9 Marketplace screenshots; vendor docs pages
(product guide, Confluence/AI guide, API tokens guide, third-party services, data
security, international transfers, terms); `forge eligibility` on VAtlassian.

Live, 2026-10-19: AssureX is installed on harshapalepu01 as Forge app
`0ad21a98-2e3f-4705-af8f-fabae1112a87` (environment `9070794f-…`), with an
"AssureX Board" project page in SCRUM. Its iframe has no popup flags, so its
frontend declares no client egress; the AWS calls go from its Forge backend.
The board never rendered on the dev Mac: the router DNS (192.168.29.1) does
not resolve any `*.cdn.prod.atlassian-dev.net` host, while 8.8.8.8 does
(CloudFront). Every Forge Custom UI app is affected on that network.

REA (rea@6.7.0, built from the local repo) attached to a dedicated Chrome
profile signed in by the user:
- `inspect-web-page` on the AssureX Board (`ev_6ddcfc42…`): REA captures the
  top-level Jira page only; the Forge iframe is a separate target, and DOM
  attribute values are not recorded.
- `analyze-web-bundle` on the AssureX frontend opened as its own tab
  (`ev_240b75b5…`): one Vite + React script, 3,517,998 bytes, sha256
  `3af0a701…`, 2 chunks, analysis partial. Its contents were **not read**: the
  auto-mode classifier blocked reading the analysis of a third party's code,
  and that line is kept. Phase 1 continues clean-room: observing behaviour in
  the UI, not reading code.

### 6a. Live UI walk (in-app browser, DNS on 1.1.1.1, 2026-10-19)

Observed by using the screens only; nothing saved, no code read.

**Scope.** AssureX works on **company-managed projects only**: SCRUM's AssureX
settings say "Available for Company-Managed Projects only", and its Add Issue
Types button is disabled. Same scope as VAtlassian's validator.

**Six work types, not five** (global, "Present in Jira" ✓, "Enable in
Projects"): TestCase, TestPlan, TestExecution, TestSet, TestPrecondition,
**TestDefect**. Descriptions all start "Assure …" (that is how its History
recognises its own items).

**Six Jira issue link types exist**, each with a configurable From → To rule
(Settings → Configurations). But the live test (6d) showed that adding a test
to a plan and creating an execution from it created **no Jira issue links**;
that membership lives in AssureX's own (AWS) store. What the link types are
used for (requirement coverage, defects) is not yet observed.

| Link type | Inward / outward | From → To |
|---|---|---|
| AssureX Tests | tests / is tested by | All → TestCase |
| AssureX Precondition | is precondition for / has precondition | TestCase → TestPrecondition |
| AssureX Test Plan Coverage | covers in test plan / is covered by test plan | TestCase, TestExecution → TestPlan |
| AssureX Test Set Coverage | covers in test set / is covered by test set | TestCase → TestSet |
| AssureX Test Execution | is test execution for / has test execution | TestCase, TestPlan → TestExecution |
| AssureX Defect | defect created by / defect created | (not in the rules table) |

**Test types** have a *kind*: Manual = Steps (default), Generic = Unstructured,
Cucumber = Gherkin; reorderable, any can be default, more can be added.

**Statuses** (run and step, separate lists; defaults PASSED, TO DO, EXECUTING,
FAILED). A status has Name, Description, Color, **Test Coverage Status**
(required: OK / UNKNOWN / NOTRUN / NOK — how runs with that status count toward
coverage), **Is Final**, and scope (all projects or selected).

**Environments**: Name, Description, URL. **Parameter value lists**: Name +
Values, global (admin) or per project, used for list parameters and dataset
columns.

**Access control** (global defaults, optional project overrides; no rule =
everyone allowed), per action by roles / groups / users:
Steps — Create, Edit, Delete, Reorder, Version ("create and sync step
versions"); Test Runs — Create, Update; Test Run Step Status.

**Project settings** (12 pages): Settings, Step Field Settings, Test Run Field
Settings, Test Coverage Settings, Defect Settings, Access Control, Test Types,
Test Statuses, Test Step Statuses, Test Environments, AI Settings, Parameter
Value Lists.
- Step fields: native Action (required), Data, Expected Result (Text); custom
  step fields with name, description, type, required; master on/off switch.
- Test run fields: custom, per test type, with flags; master on/off switch.
- Coverage panel: **all** issue types enabled by default (the docs say Story).
- Defect mapping: which issue types count as defects; default Bug + TestDefect,
  or every type when neither exists; none enabled = no defect creation/linking.
- AI PRD source: upload PDF / .txt / .md up to 25 MB, or link a Confluence page.

**Import Test** (admin): 5-step wizard — Upload File → Project Mapping →
Column Mapping → Value Mapping → Import; XLSX; template kind (Steps); optional
target projects add their custom step fields as template columns.

**AssureX Board navigation**: Testing Board — Test Repository, Test Plans,
Test Executions. Reporting Center — Test Runs List, Test Executions List, Test
Plans List, Test Sets List, Tests List, Test Coverage Report, Test Plans
Metrics, Requirement Traceability, Defect Traceability, **Compliance Report**.
Each needs the project's work types, except Compliance Report.

**Compliance Report — Audit Trail**: JQL picks issues; every field change from
the Jira changelog becomes a row: Author, Field Name, Action (Updated / Added),
Old Value, New Value, Changed On, chronological; 50 issues per page; Share;
export Excel / PDF / CSV for all or per issue.

**Token Settings** (Apps → AssureX): Atlassian Connection is **Connected** on
this site (the OAuth link to the AWS backend is active); no API tokens yet.

### 6d. Live test in project ATX (2026-10-19, with the owner's go-ahead)

Created on harshapalepu01 (all in new project ATX, nothing elsewhere touched):

| Item | What | How |
|---|---|---|
| Project **ATX** (id 10001) "AssureX Observation" | company-managed Scrum (`classic`), lead Harsha Palepu | Jira REST `POST /rest/api/3/project` |
| 6 AssureX work types in ATX | TestCase, TestPlan, TestExecution, TestSet, TestPrecondition, TestDefect | AssureX project Settings → "Add Issue Types (6)" — appended to ATX's own scheme `ATX: Scrum Issue Type Scheme` (10147), used only by ATX |
| **ATX-1** (10004) TestCase "Login with valid credentials" | 3 steps; Version 1; 1 later draft change | Jira REST create; steps, version and edit in AssureX's Test Details panel |
| Dataset on ATX-1 | parameters `username`, `password` (Text); rows `alice`/`demo-pass-1`, `bob`/`demo-pass-2` (dummy values) | AssureX Dataset dialog |
| **ATX-2** (10005) TestPlan "Release 1.0 login plan" | contains ATX-1 | Board → Create Test Plan (Jira create dialog); plan panel → Add Tests → Existing |
| **ATX-3** TestExecution "Release 1.0 login run 1" | from plan ATX-2, all tests; ATX-1 status TO DO; not executed | plan panel → Create Test Execution → All test |
| AssureX panels added to issue view | Test Details (ATX-1), Tests (ATX-2), Execution Details (ATX-3) | issue Apps menu |

Observed:
- **Jira fields**: AssureX adds **no custom fields**; all six types carry only
  the project's standard fields. Steps, datasets, versions, membership and
  results live in AssureX's backend.
- **No Jira issue links** were created by plan membership or execution
  creation (REST check on ATX-1..3). The only Jira-side marks are the
  issue-view panel properties, with module keys `agiletest-test-details` and
  `agiletest-test-plan`.
- **Panels are per issue type**: TestCase → Test Details; TestPlan → Tests;
  TestExecution → Execution Details.
- **Create** buttons in AssureX open **Jira's own create dialog** with the
  work type preset.
- **Versioning**: every saved step edit is a *drafted change*. Before any
  version: "Initial draft changes are unpublished — N drafted changes are not
  yet published. Create a version to publish them." Create Version:
  "Snapshot Current Steps … permanent historical record … captures the exact
  state of all actions, data, results, and attachments … A new version number
  will be assigned automatically." After Version 1 and one edit: "Version 1 is
  out of sync. 1 drafted change is not yet part of Version 1. 9 changes remain
  before sync is required" — a hard cap of 10 unversioned changes (the
  Marketplace screenshot showed a cap of 5, so it is likely configurable).
  Version menu: Create Version, View Versions ("Version 1 (10/19/2026, 12:22:45
  PM)"), Compare Versions; banner: View Version, Create Version, Sync Now (not
  clicked). **Dataset edits do not create drafts.**
- **Datasets**: "A dataset is a collection of data represented with a tabular
  view where every column of the table defines a parameter, and each row
  corresponds to a given iteration." The test's dataset is the *default*
  dataset. Parameter: Name, **Combinatorial** checkbox, Type **Text or List**.
  "There are a total of N iterations to execute." `${name}` in step Data
  becomes a chip: red when unknown, blue once a dataset defines it.
- **Step UI**: rich-text editors per field; per-field copy; per-step
  attachments; toolbar open / collapse / move / duplicate / delete; Expand all,
  Edit in Dialog.
- **Test plan panel**: tabs Tests / Test Executions; Add Tests (New test |
  Existing tests — by search or JQL); Create Test Execution (**All test | With
  status**); view on board; Overall Execution Status bar and counts.
- **Execution Details panel**: Overall Execution Status (bar + count per
  status), Total tests, Add Tests, ⋯, view on board; table Key, Summary,
  Defects, Actions (Archive, Delete).
- **Test Runs tab** on the test: Execute in ▾, run rows with Status and ▶ Play.
  Play and "view on board" open a **new window** through Jira (AssureX's iframe
  has no popup flags); from the in-app browser that window went to the system
  browser. The owner opened it and passed the URL.
- **Run screen** (board route `…/test/{testIssueId}/test-run/{runNo}/execution/{executionIssueId}`;
  observed read-only, nothing recorded):
  - Header: breadcrumb Project / ATX / Test Executions / ATX-3 / ATX-1; View
    Test; View Execution; Dataset; Reset.
  - **Edit gate**: "The current execution status is 'To Do'. Modification is
    only allowed when the execution status category is 'In Progress'. Add
    assignee to ATX-3 execution issue." — results can be recorded only while
    the Jira execution issue is in an In Progress category status **and** has
    an assignee.
  - Run fields: Execution Status (TO DO), Timer (start / reset, "No time
    logged"), "Auto-log clock time on completion", Started On, Finished On,
    Assignee, Executed By, Test Version (selector, shown "–"), Test
    Environments, Findings (+).
  - **Iterations**: "Iterations (2)" with a progress bar and a filter; one row
    per dataset row, labelled with its values ("Iteration 1 – password =
    demo-pass-1, username = alice"), each with its **own status**.
  - Expanding an iteration shows every step with the **values substituted**
    (Data: `alice  demo-pass-1`), plus per step: Actual Result, Comment,
    Defects (+), Evidence, Step Status.
  - The run shows **Version 1's step text**, not the later unversioned draft:
    runs are built from the published version.
  - **Dataset layering**: the run's Dataset dialog reads "Dataset for Test 10004
    in Test Execution 10006 — No dataset is defined in this context. This is
    the resolved dataset, defined in Test. You can change the dataset by
    overriding it or creating a new one. [Override] [Create new]". The test's
    dataset is the default; an execution can override or replace it.
- **AssureX History** (Activity tab on AssureX items): "A new Test Step record
  was created" per step with the values; "A new Test Step Version record was
  created → 1"; "Test plan links were updated. Added: → 10005"; and the pending
  DRAFT shown as a red-before / green-after diff. **The dataset save does not
  appear in history.**

### 6b. Open questions — status

1. Execution Details panel content — **answered** (6d).
2. Fields on the work types — **answered**: no AssureX custom fields.
3. Version semantics — **answered**: drafts per saved step edit, snapshot
   versions, cap on unversioned changes, compare; what Sync Now does is open.
4. Dataset model — **answered**: columns = parameters (Text / List,
   combinatorial), rows = iterations; the test holds the default dataset and an
   execution can override or replace it; the run lists one iteration per row,
   labelled with its values, each with its own status and the values
   substituted into every step. Row limits not tested.
5. `/automation` endpoints — **open**; not shown in the UI.
6. Defect linking — **partly**: defect types come from Defect Settings; a
   "AssureX Defect" link type exists; actual defect creation not exercised.
7. Test types — **answered**: kind Steps / Unstructured / Gherkin.
8. Jira vs AWS — **answered**: Jira holds only the work items (standard
   fields) and panel properties; steps, datasets, versions, plan / execution
   membership, run results and history are in AssureX's backend.

### 6c. What this changes in sections 2–4

- Six work types (add Defect), not five.
- Plan / set / precondition / execution membership: AssureX keeps it in its
  backend. For VAtlassian, prefer **SQL membership plus a mirrored Jira link**
  so it is JQL-visible and covered by the link worker's baselines; that is a
  deliberate improvement over AssureX, not parity. The `Verifies` link from
  the requirements plan maps to "AssureX Tests" (All → TestCase).
- Audit gaps to close in VAtlassian: dataset edits are neither versioned nor in
  history; Sync Now semantics unknown.
- Parity items from the run screen: per-iteration status; layered datasets
  (test default → execution override); edit gate tied to the Jira execution
  issue's status category and assignee; timer with auto-log; findings; runs
  pinned to a published test version. The edit gate and version pinning map
  directly onto VAtlassian's controlled transitions and baselines.
- Add: status coverage mapping (OK/UNKNOWN/NOTRUN/NOK) and Is Final; access
  control per action; custom step and run fields; defect mapping; XLSX import
  wizard; Reporting Center (10 reports) and the Compliance audit-trail report.
- Decision 7.2 is settled: company-managed only, like AssureX.

Clean-room rule: rebuild from observed behaviour, docs and screens. Do not copy
or decompile AssureX's shipped code. Its terms describe the service but the
Marketplace customer terms also apply, so check both before any static analysis
of its bundle.

## 7. Decisions needed

1. **Biometric approval vs Runs on Atlassian.** Either withdraw the BIOMETRIC
   assurance level (TOTP stays) and delete the `external.fetch.client` block, or
   prove the popup route in 7a below. There is no third option that keeps both
   today.

### 7a. Biometric popup spike (2026-10-19, partial)

The ceremony page is already app-hosted (`frontend/webauthn.html` →
`frontend/dist`, served from the app's `*.cdn.prod.atlassian-dev.net` origin).
What needs the egress block is *opening* it: `frontend/src/panel/deviceAuth.ts`
calls `window.open` from inside Jira's sandboxed iframe.

Observed on mgtechdemo (VAT-59):
- VAtlassian's iframe: `sandbox="… allow-popups allow-popups-to-escape-sandbox"`.
  Forge apps on the same page without client egress have no popup flags.
- Every Forge iframe's `allow` list is `camera; clipboard-write;
  display-capture; fullscreen; microphone; local-network-access`. No
  `publickey-credentials-get`, so WebAuthn inside the iframe is impossible.
- `webauthn.html` is served with a CSP `sandbox` directive that applies even
  top-level. Its popup flags and `connect-src *` exist only because of the
  `"*"` declaration (`x-amz-meta-csp`). Without it: `connect-src 'self'` + the
  site + a few Atlassian APIs, and `form-action 'self'`. A host-opened page
  cannot call the backend or a web trigger with `fetch`.

Tested locally (Chromium, top-level page, no real authenticator): the CSP
sandbox Forge applies without egress leaves `navigator.credentials.get`
reachable, same as no sandbox; the opaque-origin control is refused. Safari and
Firefox not tested.

Candidate route, unproven:
1. Open the page with `@forge/bridge` `router.open` (Jira opens it, outside the
   iframe sandbox). The docs say an external URL makes Jira prompt the user
   first; the CDN URL is external, so expect one confirm click per signature.
2. Return channel, in order of preference:
   a. if the opened tab has `window.opener` (the Jira tab), post the result to
      `opener.frames[i]` with `targetOrigin` = the app's CDN origin; only the
      VAtlassian iframe can receive it;
   b. otherwise the page navigates itself (GET, not limited by `connect-src` or
      `form-action`) to a **static** no-egress web trigger carrying the
      assertion; the function stores it by challenge id, and the iframe polls a
      resolver. The assertion is single-use and verified server-side as today.
3. Run `forge eligibility` on that build.

Steps 1–3 need a development deploy without the `external.fetch.client` block,
which breaks today's biometric path in development until it is redeployed.
2. ~~Team-managed projects.~~ Settled (6a): AssureX is company-managed only,
   same as VAtlassian's validator. Parity needs no team-managed support.
3. Confirm the behaviour changes in section 3 (CI responses, migration by file)
   are acceptable as "the same functionality".
