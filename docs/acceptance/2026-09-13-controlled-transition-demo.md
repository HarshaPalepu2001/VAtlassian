# Controlled transition Task 10 acceptance record

Date: 2026-09-14

Application: VAtlassian

Forge environment: development

Jira site: dev-site.atlassian.net

Deployed version: 3.13.0

Installation: Up-to-date, Jira app version 3

## Local verification

| Check | Result |
| --- | --- |
| Focused Task 10 backend acceptance tests | 45 passed, 0 failed |
| Backend test suite (`npm test`) | 854 passed, 0 failed |
| Frontend test suite | 108 passed, 0 failed |
| Import smoke test | 160/160 modules imported cleanly |
| Frontend lint | Passed |
| Frontend production build | Passed; Vite emitted the existing large-chunk warning |
| Forge lint | Passed with one pre-existing warning for the wildcard `external.fetch.client` permission (unrelated to Tasks 9/10, not touched) |
| `git diff --check` | Clean (the trailing whitespace in `src/lib/tree/jira.js` noted below on 2026-09-14 was fixed the same day) |

The repository was already dirty before Task 10 work. Existing unrelated edits and scratch/review files were preserved and are not represented as Task 10 evidence.

### 2026-09-14 follow-up: Tasks 1-8 review remediation

A separate rigorous review of Tasks 1-8 (`review_report.md`, not itself part of this plan) found 15 issues; commit `00b57a3` fixes the ones that were real defects, all under Task 10's own completion-gate rerun of the full local suite:

- **Security (HIGH)**: `panel:getEvidence` (and the legacy `panel:getState` compatibility adapter) filtered descendant tree nodes to the viewer's own Jira permissions before returning them. Previously `createTreeReader`'s `asApp()` traversal — correct for the authoritative capture/restore/drift computation — was also what reached the reviewer's screen, bypassing Issue Security Schemes for evidence display. New regression test: `test/panel-state.test.js` ("evidence excludes a descendant node the viewer cannot browse...").
- **Correctness**: baseline capture's `fields`-before-declaration `ReferenceError`, the `va_baseline_node_value.chunk` `TEXT`/64KB truncation risk, swapped from/to status ids in recall incident logging, Jira's omitted top-level `parent` field crashing tree capture, and a concurrent-capture version collision now retrying against a freshly read version instead of surfacing a raw duplicate-key failure (`test/baseline-capture-lifecycle.test.js`).
- **Performance**: `writeTreeCapture` batches node/value-chunk inserts into fixed-size multi-row statements (`test/tree-storage.test.js` — a 120-node tree now issues 6 batched statements, not 120+ individual ones), keeping large-tree capture clear of the 25s Forge synchronous ceiling.
- **Restore preflight**: multi-project trees are now preflighted per distinct project the plan touches, not only against the root issue's project (`test/restore-correctness.test.js`).
- **Frontend**: restore `QUEUING_FAILED`/`ERROR` states are labelled and retryable instead of an indefinite spinner, the WebAuthn Custom UI bridge checks `event.source` against the known popup/opener, drift approve/reject is disabled until evidence has actually loaded, the admin transitions page cancels stale async lookups, and the UI Kit field surfaces an explicit error when `evidenceHash` is missing.
- **Declined**: the review's suggestion to roll back or mark published baseline N+1 as `TRANSITION_FAILED` when the subsequent Jira transition fails. Existing behavior (invalidate the spent approval, block `retryTransition` when a baseline is attached, require a fresh signature) already satisfies this plan's "validator-denied transition requires fresh review/signature" requirement; un-publishing durable review evidence would contradict the plan's own baseline-immutability rule. No code change made for this finding.

No live Jira actions were taken during this follow-up — same restriction as the rest of this record.

### Task 9 queue worker — local verification

The implementation plan's own Task 9 checklist was still unchecked; this confirms the code matches its interfaces, not just that it exists.

- `manifest.yml`: consumer `va-restore-consumer` on queue `va-restore-queue`, function `restore-worker` → `jobs/restoreWorker.handler`, `timeoutSeconds: 600` — present and matches the plan exactly.
- `src/lib/restore/queue.js`: `enqueueRestore` pushes `{ restoreId, issueId, baselineId, baselineVersion }` with `concurrency: { key: 'restore:<issueId>', limit: 1 }` — present and matches.
- Migration `v040_restore_progress`: `job_id`, `queued_at`, `heartbeat_at`, `total_steps`, `completed_steps`, `last_checkpoint`, `last_error` on `va_restore` — present.
- `src/jobs/restoreWorker.js`: claims via CAS before any mutation, exits without mutating on a stale baseline/version, heartbeats progress, processes a bounded batch (25 actions), and either re-enqueues a continuation or performs terminal verification — read in full and matches the plan's described behavior.
- `src/usecases/restore.js`: `restore:getState` reports progress and last error; `restore:retry` checks approval ownership, baseline role eligibility, and the candidate-to-baseline resume invariant, and only re-enqueues the same `restore_id` — never mints a new signature.
- Focused tests (`node --test test/restore-worker.test.js test/restore-resume.test.js test/manifest-lint.test.js test/resolver-wiring.test.js test/migrations.test.js`): 25 passed, 0 failed, covering exactly the plan's own Step 1 list (signed rejection persists before enqueue, enqueue failure leaves resumable `QUEUING_FAILED`, at-least-once delivery does not replay, stale baseline/version exits without mutation, bounded batch republishes only while actions remain).

Task 9 is code-complete and locally verified. What remains for it, same as everything else here, is live Jira exercise of a long restoration (Task 10 Step 6 item 7): partial restore, background continuation with the browser closed, and retry without a new signature.

### Deployment target reconfirmed, 2026-09-14 (read-only)

- `forge whoami`: logged in as the designated development administrator.
- App id: `ari:cloud:ecosystem::app/1d49ae3f-e976-438c-893c-806c8b249351` (manifest.yml).
- `forge install list`: one installation — `<redacted installation id>`, environment `development`, site `dev-site.atlassian.net`, Jira, app version 3, status Up-to-date. Same target as the 2026-09-13 live session above.

**Not yet deployed**: the Tasks 1-8 review-remediation commit above (`00b57a3`) is local only. The installed version 3 predates it. Live testing against the current fixes — including the descendant-tree-visibility security fix — requires `npm run deploy` (or the project's own deploy path) to this same development installation first, and that step was intentionally left for the operator to trigger rather than run automatically here.

## Adversarial matrix

The local matrix covers the following failure and concurrency classes:

| Scenario | Local evidence | Live result |
| --- | --- | --- |
| Same-destination sibling transitions and global/direct edges | `test/journey.test.js`, `frontend/test/panel.test.mjs` | Pending clean configured fixture |
| Two simultaneous holders of one role and compare-and-swap races | `test/approval-submit.test.js`, `test/gate-approval.test.js` | Pending clean configured fixture |
| Double-click/replay, stale challenge, and later-baseline protection | `test/approval-submit.test.js`, `test/drift-functional.test.js`, `frontend/test/panel.test.mjs` | Pending clean configured fixture |
| Policy edits and provider substitution | `test/approval-submit.test.js`, `test/drift-functional.test.js` | Pending clean configured fixture |
| Failed audit write and failed N+1 persistence | `test/approval-submit.test.js`, `test/drift-functional.test.js` | Covered locally |
| Validator denial and duplicate Jira events | `test/approval-submit.test.js`, `test/drift-functional.test.js` | Covered locally |
| Duplicate queue delivery and worker crash after each action kind | `test/restore-worker.test.js`, `test/controlled-transition-tree-acceptance.test.js` | Covered locally |
| Deleted-node replacement, unsupported fields, permission denial, and wrong-status read-back | `test/controlled-transition-tree-acceptance.test.js`, `test/tree-jira.test.js`, `test/tree-storage.test.js` | Covered locally |

## Live Jira observations

1. The installed development tenant was confirmed before deployment.
2. Version 3.13.0 deployed successfully and `forge install list` reported the installation up to date.
3. The administrator page loaded and the pending-migration action returned `Saved.`
4. The VJIRA-10 issue panel initially surfaced a SQL execution error before migrations; after migration it loaded the approval and baseline summary, including control state, baseline version, restoration status, and the recorded workflow-control incident.
5. The VJIRA-1 issue panel loaded a drift review. The live review identified the changed Due date and Start date fields and displayed their before/after values.
6. The live tenant currently contains historical baselines that predate recorded role/method policy. The app correctly presents the resulting incident and does not offer a controlled decision from that incomplete rule state.
7. No live approve/reject, transition, restoration retry, TOTP ceremony, or WebAuthn ceremony was executed against these existing issues; those actions would mutate tenant data and require a clean acceptance fixture and explicit operator choice.

## Deployment and eligibility

`forge lint`, deployment, installation status, and `forge eligibility` were checked against the development tenant. The deployed version is not eligible for the Runs on Atlassian program because the app egresses data. This is an environment/deployment property, not a failed local test.

No credentials, TOTP values, WebAuthn assertions, raw exports, or private tenant payloads are stored in this record.
