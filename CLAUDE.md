# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

VAtlassian is a single Atlassian Forge app (Jira, `nodejs22.x`) that adds electronic-signature approvals, baselines, drift detection/restoration and test management to Jira. See also `AGENTS.md` (local `.scratch/` issue tracker, triage labels, `GLOSSARY.md`/`docs/adr/` domain docs). Neither `.scratch/`, `GLOSSARY.md` nor `docs/adr/` exists yet. Create them only when they are needed.

## Commands

Backend (repo root, ESM, `node:test`, no build step):

- `npm test`: all backend unit tests (`node --test test/*.test.js`)
- `node --test test/approval-submit.test.js`: a single test file (add `--test-name-pattern "<name>"` to run one test)
- `npm run smoke`: imports every backend module (`test/smoke.mjs`). This catches bad import paths, renamed exports and load-time throws in resolvers, triggers, jobs and stores that need `@forge/*`, which the unit tests can't reach.
- `npm run verify`: backend tests + frontend tests + smoke + UI build. Run it before calling work done.
- `npm run deploy`: runs `verify` and then `forge deploy`. Deploying is outward-facing, so ask first.

Frontend (`frontend/`, React 19 + TypeScript + Vite, built to `frontend/dist` = the `main-ui` resource):

- `npm --prefix frontend test`: `node --experimental-strip-types --test test/*.test.mjs` (happy-dom)
- `npm --prefix frontend run build`: `tsc -b && vite build`
- `npm --prefix frontend run lint`: oxlint

Ops/diagnostics: `node scripts/harness.mjs tail|watch|stats|inspect <issueKey>` parses Forge logs (see its header). `scripts/requirements-setup/` and `scripts/test-management-setup/` provision Jira work types, screens, fields and link types on a site (each has a README).

## Architecture

**Layering.** `manifest.yml` maps every Forge module to a handler under `src/`:

- `src/resolvers/*.js` define thin `@forge/resolver` endpoints (`panel:getState`, `approval:submit`, …). Each one delegates to `src/usecases/*.js`.
- `src/usecases/` holds the application logic. Usecases are usually built as `create…Usecases(deps)` factories so tests can inject fakes. Tests construct them with in-memory deps; there is no Forge mock layer (see `test/approval-submit.test.js`, `test/fake-store.js`).
- `src/lib/` holds the domain logic (hashing, ledger, diff, capture, drift, restore, approval providers, tree baselines) and is mostly pure.
- `src/db/*Store.js` handles Forge SQL persistence on top of `src/lib/db.js`.
- `src/testmgmt/` is the test-management slice (its own stores, migrations and runtime). It is exposed through `resolvers/testManagement.js` and the `va-test` issue panel.

**Entry points besides resolvers:**

- `src/gate.js` is the single `jira:workflowValidator` (`va-gate`), attached to every transition. It holds drifted items on all transitions and requires a signature only on transitions configured as controlled in VAtlassian admin.
- `src/triggers/` contains the Jira event triggers (issue created/updated/transitioned/deleted, link). Their real dependencies come lazily from `triggers/runtime.js`.
- `src/jobs/runner.js` runs the scheduled 5-minute, hourly and daily triggers. It fans out to jobs (`migrate`, `gatecheck`, `reconcile`, `rehash`, `verify`, `seal`, `prune`, …) via lazy imports wrapped in `safely()`, so one broken job can't stop the others.
- `src/jobs/{restoreWorker,vaultWorker,linkWorker}.js` are async queue consumers.

**Frontend.** There is a single Custom UI bundle. `frontend/src/main.tsx` switches on `context.moduleKey` (`va-panel`, `va-test`, `va-worklist`, `va-admin`, `va-gate`, `va-approval-field`, …) to choose the screen. The approval custom field's issue-view rendering is the UI Kit file `src/ui-kit/view.jsx`.

**Data.**

- Forge SQL (MySQL) holds all `va_*` tables. The schema lives in `src/db/migrations.js`, which also pulls in the testmgmt and link-policy migration arrays. The schema is append-only: add new entries and never edit shipped ones, with one DDL statement per entry.
- Migrations run from the five-minute trigger (`jobs/migrate.js`), not at deploy. New code therefore runs briefly against the old schema. `executeQuery` returns `{ result: false }` instead of throwing, and `isUnknownColumn` lets callers tolerate missing tables or columns. Keep that tolerance when you add a column to a hot table.
- Attachment bytes go to Forge Object Store (`fos`). Text and evidence stay in SQL.
- The audit ledger (`lib/ledger.js` over `db/store.js`) is a hash chain. Store methods throw on duplicate key on purpose, so concurrent appends retry instead of forking the chain.

**Comments in `src/lib/db.js`, `manifest.yml` and similar files record behaviour learned against live tenants.** Read them before you "simplify" anything they describe. The `permissions.external.fetch.client: "*"` block exists only so the WebAuthn popup can open, and it costs the app "Runs on Atlassian" eligibility.

## Key product rules (non-obvious, enforced in code)

- Identity always comes from `context.accountId` and verified Jira access, never from the payload.
- Drift holds an item at the gate but never auto-recalls it.
- Approving one end of a link records the link on both ends.
- Jira's transition permission is authoritative: the app reverts moves it made that the user could not make.

## Repo conventions

- `docs/` holds plans, specs, checklists (`PERFORMANCE-CHECKLIST.md`, `DATABASE-CHECKLIST.md`, `PLATFORM-CHECKS.md`) and live acceptance records (`docs/acceptance/`). Local tests passing does not count as live Jira acceptance. Keep the two separate in claims and in docs.
- Don't put competitor product names in code, Jira objects, scripts or docs.
- Commits: small and split by concern, with no AI attribution lines.
