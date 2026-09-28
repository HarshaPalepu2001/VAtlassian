# VAtlassian acceptance matrix — 2026-09-08

Requirement-by-requirement status against the brief that merged Forge Signature
and Forge Baseline into VAtlassian.

**What "verified" means here.** `Local` means an automated test in this repo
exercises the real production code path with only the Forge request and SQL
boundaries replaced. It does not mean the behaviour has been observed against a
Jira tenant. Anything that depends on Jira actually enforcing a workflow rule,
rendering a module, or accepting a REST parameter is marked `Needs live` and is
listed in "Live acceptance still required" below. No row here asserts 21 CFR
Part 11 compliance; that is a validation exercise, not a test result.

Verification run for this matrix: 570 backend tests passing, 10 frontend tests
passing, 130/130 modules import cleanly, frontend build succeeds, `forge lint`
reports no issues. Forge development deployment succeeded as version 2.24.0, and
the development Jira install on the nominated non-production Jira site is up to date.
Interactive Jira acceptance remains open.

## 1. A controlled transition must be declared on both sides

| Requirement | Status | Evidence |
|---|---|---|
| Transition needs a validator on the Jira side AND a controlled transition in VAtlassian | Met | `jira:workflowValidator` module `va-gate`; `src/gate.js` denies `NOT_CONFIGURED`/`INVALID_EDGE_POLICY` when the VAtlassian edge is absent or incomplete. `test/gate-approval.test.js` |
| Jira-side enforcement when no validator is published | Not possible | Jira only calls the app for transitions whose workflow carries the validator. An app cannot block a transition it is never consulted about. This is a platform boundary, not a gap. |
| Forge-side visibility when a transition is controlled in VAtlassian but unprotected in Jira | Met | `src/db/incidentStore.js` records `UNAUTHORIZED_TRANSITION`; `src/triggers/issue-transitioned.js` raises it when a controlled edge is crossed with no eligible approval. Surfaced by `src/resolvers/issueStatus.js` as "Control alert" and in the panel. `test/issue-status.test.js` |

## 2. Baseline capture

| Requirement | Status | Evidence |
|---|---|---|
| Capture on a controlled transition that has baseline configured | Met | `src/lib/capture.js`; `test/baseline-capture-lifecycle.test.js` |
| Works from the Jira transition screen | Met (local) / Needs live | Handled by the `avi:jira:transitioned:issue` trigger, so the entry point is irrelevant to the app. `test/baseline-trigger-retry.test.js` covers the trigger; the Jira-screen path itself needs live confirmation. |
| Works from the issue panel | Met | `src/resolvers/panel.js` → `signature:challenge` / `signature:submit` → `src/usecases/approval.js` |
| Works from My approvals | Met | Same resolver path; `src/usecases/queue.js` lists the items |
| Baselines **every** field in VAtlassian field settings — 10 or 100 | Met | `scopeFromIssue()` in `src/lib/trackedFields.js` returns the full declared set and does **not** narrow to the edit screen. `test/baseline-trackedfields.test.js` |
| 100-field baselines do not collapse into hundreds of round trips | Met | Byte-aware batched writes and bounded chunked reads in `src/db/baselineStore.js`. `test/baseline-storage.test.js` |
| Capture is bound to the content the approver signed | Met | Capture refuses `CONTENT_CHANGED` when the computed hash differs from the approval's. `test/baseline-capture-lifecycle.test.js` |
| Duplicate or delayed events cannot republish an older baseline or clear drift | Met | `CAPTURING` state plus baseline-version guard in `src/lib/capture.js`. `test/baseline-capture-lifecycle.test.js` |

## 3. Cryptographic snapshot and drift detection

| Requirement | Status | Evidence |
|---|---|---|
| Every baseline is a cryptographic snapshot of the tracked fields | Met | `project()`/`normaliseField()` in `src/lib/content.js`; per-field digests plus a content hash |
| After a baseline exists, every change produces a snapshot verified against it | Met | `src/lib/collect.js` runs on `avi:jira:updated:issue`, on issue-link events, and on the reconcile sweep — one code path for all three |
| A change to an **untracked** field still records an observation | Met | `src/db/observationStore.js`; `test/baseline-observation.test.js` |
| Drift is raised only when tracked-field content actually changed | Met | `src/lib/diff/index.js` compares normalised values, not event payloads. `test/baseline-diff.test.js` |
| Cascading-select and rich-text changes are not missed | Met | Regression fixed in `src/lib/content.js`. `test/baseline-integrity-regression.test.js` |
| Formatting-only changes remain reviewable and restorable | Met | `semanticChange` controls what the reviewer is told, never what is restored. `src/lib/decision.js`, `src/lib/restore/planner.js` |

## 4. Drift flag on the Jira issue screen

| Requirement | Status | Evidence |
|---|---|---|
| Drift is flagged on the Jira issue screen | Met, with a placement caveat | `jira:issueContext` module `va-context` with `dynamicProperties: issue-status`; `src/resolvers/issueStatus.js` renders "Changes need review" |
| Flag sits at the top of the issue, beside the summary | **Not possible** | Forge has no module that renders beside the summary. `jira:issueContext` renders in the right-hand details column, which is the closest supported placement. Issue **properties** can store the state and make it JQL-searchable, but a property does not render a banner anywhere — it cannot produce the requested placement on its own. |
| Issue is locked once drift is observed | Met | `LOCKED`/`DRIFTED` item state; `src/gate.js` denies `RECORD_LOCKED` and `UNDECIDED_DRIFT` |

## 5. Review routing and the reviewer experience

| Requirement | Status | Evidence |
|---|---|---|
| Eligible reviewers are found and the item appears in My approvals | Met | `src/usecases/queue.js` unions gated review statuses and drifted issues, then re-checks eligibility per issue after a `search/jql` run as the user |
| Reviewer sees a state-of-the-art diff: what changed, who changed it, when | Met | `frontend/src/review/DiffView.tsx`; attribution from the Jira changelog via `src/lib/changelog.js` |
| Incomplete history is disclosed rather than guessed | Met | `historyTruncated` / `historyUnavailable` surfaced as a notice in `frontend/src/review/ReviewWorkspace.tsx` |
| AI summary of the changes | Met | `src/lib/report.js` over the `llm` module (`va-llm`), Claude models |
| Deterministic diff still renders if the AI call fails | Met | `ReviewWorkspace` fetches diff and report independently; a failed report leaves the diff intact |
| **Active notification** that a signed ticket changed | **Gap — not implemented** | `notifications.digest` and `restore.commentOnRestore` exist in `src/db/configStore.js` but nothing reads them. Reviewers currently discover work by visiting My approvals or the issue. See "Open decision" below. |

## 6. Decision outcomes

| Requirement | Status | Evidence |
|---|---|---|
| Approve creates a new baseline and resumes drift tracking | Met | `applyApproval` → `writeCapturedBaseline` → `markDecided` in `src/usecases/drift.js` |
| Reject restores the last approved baseline condition | Met | `src/usecases/restoreActions.js` |
| **All** tracked fields revert, not just the title | Met | `src/lib/restore/planner.js` plans every changed tracked field; `src/lib/restore/adapters.js` shapes each field kind. `test/restore-correctness.test.js`, `test/restore-adapters.test.js` |
| Fields that are tracked but not on the edit screen still revert | Met (local) / Needs live | App-attributed writes now carry `overrideScreenSecurity`/`overrideEditableFlag`, and the planner is fed an app-scoped `editmeta` read using the same overrides so plan and write agree. `src/lib/restore/executor.js`, `src/usecases/panelAccess.js`. `test/restore-correctness.test.js` |
| Parent and issue links revert | Met | `restoreLinks()` reconciles links by type, direction and identity, validating both complete lists before any mutation. `test/restore-correctness.test.js` |
| Restore is confirmed by reading Jira back | Met | `src/lib/restore/verifier.js` — a field is `succeeded` only after a fresh read matches the approved digest; a field Jira omits from the read is never counted as verified |
| A restore cannot silently report success | Met | `tally()` derives state from verification, not from HTTP status. `test/restore-verification.test.js` |
| Abandoned approve/reject operation locks recover instead of blocking forever | Met (local) | `DECIDING`/`RESTORING` use a 60-second lease, challenge and submit share stale-lock behavior, and reconcile sweeps stale locks. Durable `LOCKED` records still block. `src/lib/decision.js`, `src/usecases/approval.js`, `src/db/itemStateStore.js`, `test/lock-lease.test.js`, `test/approval-submit.test.js` |

## 7. Signature integrity

| Requirement | Status | Evidence |
|---|---|---|
| Signature binds the reviewed content and the selected policy | Met | Challenge/confirm flow with `operation_plan_hash` in `src/lib/approval/challenge.js`; `POLICY_CHANGED` on drift of meaning, role, assurance |
| Approval is available to the validator before the transition is attempted | Met (fix) | Activation now precedes `performTransition` in `src/usecases/approval.js` — previously the transition ran first and the validator could not see the approval. `test/approval-submit.test.js` |
| A spent approval is never reactivated | Met | Final state re-read via `deps.byId` rather than assumed. `test/approval-submit.test.js` |
| Assurance floor applies to approve and reject alike | Met | `effectiveAssurance()` in `src/gate.js` and `src/usecases/approval.js`. `test/approval-assurance.test.js` |
| TOTP e-signature correctness | Met | `test/signature-totp-rfc-vectors.test.js`, `test/signature-totp.test.js`, `test/totp-approval.test.js` |
| Signed snapshots are retained | Met (fix) | The daily prune could delete superseded baseline values that the export does not contain. `pruneSupersededValues()` is now a no-op until a value-complete verified archive exists. `src/jobs/prune.js`, `src/db/baselineStore.js` |

## Live acceptance still required

Local tests cannot establish any of these. They need a run on a non-production
tenant (a nominated non-production Jira site):

1. Jira actually refuses a controlled transition when the validator denies it.
2. `overrideScreenSecurity` / `overrideEditableFlag` are accepted on both
   `PUT /rest/api/3/issue/{key}` and `GET /rest/api/3/issue/{key}/editmeta`
   for this app's permissions. The code degrades safely if `editmeta` ignores
   them — the field is refused and reported, exactly as before this change —
   but the widened restore coverage is unconfirmed until a live run.
3. Baseline capture from the Jira transition screen (as opposed to the panel).
4. A reject-and-restore over a genuinely large tracked set, including a field
   deliberately removed from the edit screen.
5. Rendering and placement of the `jira:issueContext` drift lozenge.
6. End-to-end timing of capture and drift detection inside Forge's invocation
   budgets under a 100-field configuration.

## Open decision

**Reviewer notification.** The brief asks that a reviewer be actively told a
signed ticket changed. Nothing currently sends anything; `notifications.digest`
and `commentOnRestore` are declared config that no code reads. The realistic
options inside Forge are a comment on the issue mentioning eligible reviewers,
or a scheduled digest built on the existing hourly/daily runners. Both write
something outward-facing into a customer's Jira, so the channel and its noise
profile is a product decision rather than a defect fix, and it is left
unimplemented pending that decision.
