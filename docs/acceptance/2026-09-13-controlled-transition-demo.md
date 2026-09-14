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
| Backend test suite (`npm test`) | 849 passed, 0 failed |
| Frontend test suite | 108 passed, 0 failed |
| Import smoke test | 160/160 modules imported cleanly |
| Frontend lint | Passed |
| Frontend production build | Passed; Vite emitted the existing large-chunk warning |
| Forge lint | Passed with one warning for the existing wildcard `external.fetch.client` permission |
| `git diff --check` | Not clean: existing trailing whitespace in `src/lib/tree/jira.js` lines 22 and 63 |

The repository was already dirty before Task 10 work. Existing unrelated edits and scratch/review files were preserved and are not represented as Task 10 evidence.

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
