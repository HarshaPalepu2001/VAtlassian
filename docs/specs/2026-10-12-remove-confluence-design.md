# Remove Confluence; Forge Object Store is the only vault

Date: 2026-10-12
Status: design approved in chat; spec awaiting review

## Decision

VAtlassian drops every Confluence integration. Attachments are vaulted in the
Forge Object Store only. Everything that is not attachment bytes stays in Forge
SQL, as it is today. Confluence may return later as a separate piece of work;
nothing is kept in place for it.

## Storage model after this change

| What | Where |
|---|---|
| Text, rich text (ADF) and all other tracked fields: baseline values, digests, approvals, drift, ledger | Forge SQL (unchanged) |
| Attachment bytes | Forge Object Store, key `vault/sha256/<hash>` (content-addressed, unchanged) |
| Attachment record: filename, hash, object key, media id, baseline | Forge SQL, `va_vault_attachment` (unchanged) |

## Scope: what is removed

Two separate Confluence features go, not only the vault.

**A. Confluence vault**
- `src/lib/vaultConfluence.js`, `src/lib/vaultTier.js`
- Vault-space and project-page provisioning in `src/lib/vaultProvision.js`
- The Confluence branch of `src/jobs/vaultWorker.js` (tier probe, vault page, upload to page, fallback ledger detail)
- The Confluence download in `src/lib/restore/attachmentAdapters.js` (`downloadVaulted`) and the Confluence branch of `preserve`
- Site, page and project-page functions in `src/db/vaultStore.js`; the page clause in `projectsNeedingVault`
- The admin "Vault storage" card and Automatic/Confluence/Object Store selector (`SettingsPage.tsx`); the `getVaultTier` / `setVaultTier` use cases and their resolvers; the tier fields in `getVaultStatus`
- The Confluence download branch of the temporary `src/jobs/probe.js`

**B. Confluence page governance**
- `src/lib/confluenceAdapter.js`, `src/db/confluenceStore.js`, `src/db/objectStore.js` (only Confluence code uses it), `src/usecases/confluence.js`, `src/jobs/confluenceReconcile.js`, `src/triggers/confluence-event.js`
- `src/lib/governanceCore.js` if nothing outside Confluence uses it (verify before deleting; otherwise strip its Confluence parts)
- `frontend/src/confluence/*` and its cases in `frontend/src/main.tsx`
- The `confluence:*` resolver definitions in `src/resolvers/panel.js`

**C. Manifest** (`manifest.yml`)
- Modules: `confluence:contentBylineItem`, `pageBanner`, `contentAction`, `globalPage`, `spaceSettings`, `contentProperty`
- Trigger `va-on-confluence-event` and its 15 `avi:confluence:*` events; function `on-confluence-event`
- Consumer `confl-reconcile-cnsmr`, queue `confluence-reconcile`, function `confl-reconcile-wrk`
- All Confluence scopes, including the granular `*:confluence` ones added for the vault

**D. Tests**: delete Confluence-only suites (`confluence-reconcile`, `confluenceAdapter`, `vault-confluence`, `vault-tier`, and the Confluence parts of `vault-provision`, `vault-worker`, `vault-store`, `attachment-restore`, `attachment-adapters`, `governanceCore`, `admin-configuration`, `harness`, `migrations`, `frontend/test/confluence.test.mjs`, `frontend/test/admin.test.mjs`); update the rest to the single-store behaviour.

## What stays and how it simplifies

- **Vault worker**: one path. Download from Jira, hash, `putContent` to the Object Store, insert `va_vault_attachment` with `storage = OBJECT_STORE` and the object key, append `ATTACHMENT_VAULTED`. A file recorded by the baseline but gone from the issue is still carried forward from an earlier vaulted copy of the same Jira id. The 250 MB per-file limit stays.
- **`vaultProvision`**: keeps the Jira side only: the project's `va_vault_space` row, the app's attachment-delete grant, and the opt-in lockdown (`vaultPermissions.js` untouched).
- **Backfill** (`vaultBackfill.js`): no tier lookup and no page to wait for.
- **`vaultLocation.js`**: `STORAGE` collapses to the Object Store; `objectKeyFor` stays; `isReadableCopy` is true only for an Object Store copy with an object key.
- **Restore**: reads and writes the Object Store only. A copy whose row says `storage = CONFLUENCE` is reported as unrestorable with the reason "stored in Confluence, which is no longer supported", through the same path as an Object Store 404 (the file is named unrestorable; nothing is silently skipped).
- **Diagnostics** (`DiagnosticsHud.tsx`, `usecases/harness.js`, `vaultStatus.js`): show the Object Store only; drop `confluencePageId` / `confluenceAttachmentId` from the payloads.
- **Ledger** (`ledger.js`): event types stay in the enum, including `VAULT_TIER_DETECTED`, because the ledger is append-only history.

## Data: migration `v108`

Existing migrations are not edited (Forge SQL migrations are append-only). A new migration:

1. `DROP TABLE IF EXISTS` for: `va_governed_subject`, `va_governance_policy`, `_state`, `_approval`, `_challenge`, `_baseline`, `_node`, `_artifact`, `_workspace`, `_operation`, `_event_receipt`, `va_events`, `va_vault_site`, `va_vault_page`.
2. Drop the Confluence columns on `va_vault_space`: `space_id`, `space_key`, `project_page_id`.
3. Delete the remembered tier row: `DELETE FROM va_config WHERE cfg_key = 'vault:tier'`.
4. `va_vault_attachment` is left as it is, including `confluence_attachment_id` and `storage`, so old rows remain an honest record of what was vaulted and restore can say why a legacy copy cannot be restored.

This is irreversible on the deployed test site (mgtechdemo). That was accepted explicitly. Existing Confluence-stored vault copies become unrestorable; no copy-over is attempted.

## Preservation contract: baseline and drift must not change

Baseline capture and drift detection read Jira and Forge SQL only; they never read the vault. The one coupling is `lib/attachmentIdentity.js` (called by `capture.js` and `collect.js` through `canonicaliseIssue`), which reads attachment identity and alias records from `db/vaultStore.js`. Those are SQL and are not Confluence, but they live in the file this change prunes.

Therefore:

1. **Kept untouched in `vaultStore.js`**: `identityRecords`, `recordAttachmentAlias`, `vaultedCopies`, `isAttachmentVaulted`, `insertVaultAttachment`, the `va_vault_space` row functions for the delete grant and lockdown, and `markPermissionUnlocked`. Only the site, page and project-page functions are removed.
2. **Gate before any deletion**: run the full suite on the current tree and record the result. Baseline, drift, capture, restore, approval and panel tests must be green first.
3. **Tests are removed only when they test removed behaviour.** No baseline, drift, capture or restore assertion is loosened, skipped or rewritten to pass. A Confluence-only test is deleted whole; a mixed test is edited to drop its Confluence cases and keep the rest.
4. **Same gate after**: the same suites, green, with the diff of removed test names listed in the plan so each deletion is accountable.
5. **Failure stays isolated**: vaulting remains asynchronous (`va-vault-queue`), so a vault failure still cannot block an approval, a baseline or a drift decision; it is recorded as `ATTACHMENT_VAULT_FAILED`. With one store and no fallback, such failures now surface instead of being masked.
6. **Live acceptance checklist** (run by the user after deploy, added to `docs/acceptance/`): baseline an issue with an attachment, confirm a `vault:copied` log with `storage: OBJECT_STORE`; add and remove a file and confirm drift is flagged; reject and confirm the restored file's bytes hash to the baselined hash. This is the first end-to-end proof of the Object Store path; it has unit tests but no recorded live run today.

Authority: the Object Store needs no user permission or scope (the app calls it as itself). The authority this feature depends on is Jira's: reading attachment content, adding one on restore, and deleting one added after approval (the app delete grant and opt-in lockdown, unchanged here).

## Out of scope

- Moving existing Confluence copies into the Object Store.
- Any Confluence replacement or stub.
- Historical docs and specs: kept as history. The two vault documents (`docs/specs/2026-09-22-confluence-attachment-vault-design.md`, `docs/plans/2026-09-22-confluence-attachment-vault.md`) get a "superseded 2026-10-12" note.

## Verification

- `npm run verify` passes (node tests, UI tests, smoke, UI build).
- `grep -ri confluence` over `src`, `frontend/src`, `test`, `scripts` and `manifest.yml` finds only: old migrations (history), the `v108` migration, the ledger enum and its comments, and the legacy-copy refusal message.
- The manifest no longer lists any `confluence` module, trigger, consumer or scope.
- Not verifiable here: a deploy to Forge and a live baseline → add attachment → reject → restore run on the test site. Left for the user, with a short checklist added to `docs/acceptance/`.

## Risks

- Forge may require a re-deploy with `--non-interactive` or an upgrade prompt when modules and scopes are removed; removal does not need new consent.
- Migrations run only when an administrator triggers `admin:runMigrations`, not on deploy. So the order is: deploy the new code (which no longer reads the Confluence columns or tables), then run migrations. Between those two steps the old tables are simply unused. Running the migration before the new code is live would break the old code, which still reads them.
- The memory notes on vault tiers and the Confluence vault will be stale after this lands and are updated at the end.
