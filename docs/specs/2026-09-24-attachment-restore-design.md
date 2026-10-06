# Attachments: tracked, held, and restored from the vault

**Date:** 2026-09-24
**Status:** Built 2026-09-24; revised 2026-09-30 (section 9); live checks in section 7 outstanding
**Extends:** `docs/specs/2026-09-22-confluence-attachment-vault-design.md`
(this is its "Phase 3"), `docs/specs/2026-09-24-child-baselines-design.md`.

## 1. What changed

- **Attachments are a controlled field.** `attachment` is no longer in
  `IGNORED_FIELDS` (`src/lib/content.js`). Files are compared by Jira id plus
  name and size (`normaliseAttachments`). Jira never changes a file in place,
  so comparing by id catches every change, and no file has to be downloaded to
  detect one. An administrator tracks it from the Controlled fields page (its
  field search finds it); nothing adopts fields on a schedule. Baselines captured before this carry no attachment digest, so tracking
  it reports no drift until the next capture (rule 2 in `changedFields`).
- **Adding or removing a file holds the item** on every transition, and the
  change shows on the panel, like any other controlled field.
- **Rejecting puts the files back** (`src/lib/restore/attachments.js`):
  - a **removed** file is downloaded from the vault, checked against the
    SHA-256 recorded when it was vaulted, re-uploaded, read back and hashed
    again. Only then is its new Jira id recorded as **standing for** the
    original (`va_attachment_alias`).
  - an **added** file is written to the ledger with the hash of its bytes
    (`ATTACHMENT_REMOVED_BY_RESTORE`), copied to the vault page as
    `rejected-<id>-<name>` where one exists, and then deleted. If the ledger
    entry cannot be written, the file is not deleted.
  - files are added before any are removed. A file that cannot be restored is
    named with its reason, and the rest still go ahead. A system failure
    (5xx, 429, no response) is thrown so a queued restore retries. Every step
    can be repeated safely.
- **The reject dialog names every file before signing:** files to be
  permanently deleted, files to be uploaded again from the vault, and files
  with no copy in the vault that cannot come back
  (`src/lib/restore/attachmentPreflight.js`, `panel:getEvidence` →
  `rejection.attachments`).

## 2. Identity: a restored file is the approved file

Jira cannot restore an attachment under its old id. Without a record, a
correctly restored item would read as drifted for ever. `va_attachment_alias`
(written only by the app, and only after the content check) maps the new id to
the original. `src/lib/attachmentIdentity.js` applies it wherever an issue is
read for a comparison:

| Read | Where |
|---|---|
| Panel, approval, drift decisions | `usecases/panelAccess.js` `readableIssue` |
| Panel summary | `usecases/panelSummary.js` |
| Validator | `lib/approval/runtime.js` gate `load` |
| Collector | `lib/collect.js` `readIssue` |
| Trigger capture | `lib/capture.js` `run` |
| Every tree read (capture, drift, approval hash, restore, verification) | `lib/tree/jira.js` `createTreeReader` |
| Single-issue restore verification | `lib/restore/verifier.js` |

The lookup costs one query per read, and none when the item has no files. If
the alias table cannot be read, a restored copy reads under its own id and the
item shows as drifted. A read failure never hides a change.

## 3. Vault fixes

- **The vault copies the signed set.** Each capture returns the files it
  recorded (`recordedAttachments`), and the vault job carries them
  (`body.attachments`). The worker copies exactly those. A recorded file that
  left the issue before the job ran is carried forward from an earlier vaulted
  copy of the same id, or reported as `ATTACHMENT_VAULT_FAILED`. A job without
  the list (the baseline tracks no attachments, or the job was queued before
  this change) copies the current files, as before.
- **Children are vaulted.** A parent's capture queues one job per child
  baseline it wrote, in batches of 50 (`enqueueVaultJobs`).
- Files are vaulted under their **canonical** id, so a restored copy is filed
  as its original.

## 4. Permissions

- **The app keeps its own right to delete attachments.** The lockdown removes
  every attachment-delete grant except one for the app's own Jira account,
  which it adds first (`grantAppAttachmentDelete`, recorded in
  `va_vault_space.app_delete_granted_at`).
- **The lockdown had never removed anything.** It read the scheme without
  `?expand=permissions`, and Jira only includes grants when `expand` is given.
  It now asks for them. A project already recorded as locked is finished by
  the hourly backfill: the app grant is added, the remaining delete grants are
  removed, and `ATTACHMENT_DELETE_LOCKED` is audited with `repaired: true`.
  **This changes permission schemes on deploy, including schemes shared with
  other projects.**
- **New scope `read:attachment:confluence`** (Forge rejects the classic `read:confluence-file`), needed to download a vaulted copy.
  Installed sites need a site admin to accept the app upgrade.

## 5. Restore paths

- **Child (flat baseline):** `planRestore` gives `attachment` the special
  handler `attachments`. `executeRestore` runs it as the app.
- **Parent (tree baseline):** `planTreeRestore` emits `RESTORE_ATTACHMENTS`
  per work item, never as a field write. A recreated work item is created
  without its file list, then gets its files uploaded from the original item's
  vault page, with aliases recorded against its new id. The permission
  preflight asks for `CREATE_ATTACHMENTS`. A refused delete is named per file
  rather than failing the preflight.

## 6. New ledger events

`ATTACHMENT_RESTORED`, `ATTACHMENT_REMOVED_BY_RESTORE`,
`ATTACHMENT_DELETE_GRANTED_TO_APP`, `ATTACHMENT_DELETE_GRANT_FAILED`.
Migrations `v063`–`v065`.

## 7. Live checks before calling this done

1. Download `/wiki/rest/api/content/{page}/child/attachment/{id}/download`
   through `requestConfluence` with `read:attachment:confluence`, and confirm it
   returns the bytes, not a redirect Forge will not follow.
2. Jira upload (`POST /issue/{key}/attachments`) as the app, and the read-back
   hash matches.
3. The app keeps Delete all attachments through the
   `atlassian-addons-project-access` role (Jira refused a `user` holder for the
   app account, 400), and `DELETE /attachment/{id}` as the app succeeds. Test
   with the lockdown OFF on the working project; test it ON only on a scratch
   project with its own permission scheme.
4. `/search/jql` returns `attachment` for every node when it is requested; the
   tree reader fails closed if Jira omits a requested field.
5. End to end on `mgtechdemo`: approve an item with a file, remove it, add
   another, reject; confirm both are back to the baseline, the item is clean,
   and the ledger shows both entries.
6. Rich text: approve an item whose description shows an inline image of its
   attachment; delete only the attachment; reject. The file is re-uploaded,
   the raw description points at the copy's media id, the image renders,
   verification is clean, and `ATTACHMENT_RESTORED.mediaId` is set. Then
   delete the restored copy and reject again: the description points at the
   newest copy. (Also confirms, or not, the assumption in 9.2 that deleting a
   file leaves the description unedited.)
7. Object Store tier: set Vault storage to Forge Object Store (Settings →
   Attachment protection), approve an item with a file, remove it, reject.
   The vault row has `storage = OBJECT_STORE` and an `object_key`; the file
   comes back and its hash matches; the probe's `vault` entry reads
   `from: OBJECT_STORE, matchesRecord: true`. Set storage back to Automatic.

## 8. Known limits

- A file the vault never received cannot be restored. The dialog says so
  before signing.
- A restored file carries the same bytes and name, but Jira shows the app as
  uploader and today as its date. The ledger records the original id with the
  new one.
- A retry of an approval already captured queues the vault without the
  recorded list, so the worker copies the current files (the previous
  behaviour).
- Files over 250 MB are not vaulted (`MAX_VAULT_BYTES`): the worker holds a
  whole file in memory. Each such file is `ATTACHMENT_VAULT_FAILED` with
  `TOO_LARGE`, and cannot be restored.
- Rich text that shows a restored file whose media id Jira never reported is
  not written; the field is named as failed, and the reject dialog warns about
  such files beforehand (`mediaUnknownFiles`).

## 9. Revision 2026-09-30

### 9.1 The attachment-delete lockdown is opt-in, per project

`vault.lockAttachmentDeletion`, project scope only, **off by default**
(Settings → Attachment protection). Off: the permission scheme is never
edited, anyone permitted may delete a file, and a rejection restores it from
the vault. The app always keeps its own right to delete
(`ensureAppDeleteGrant`), because a rejection removes files added after
approval. On: grants are removed as before, and `ATTACHMENT_DELETE_LOCKED`
now records who held each (`removedGrants`) so they can be re-added by hand;
turning it off (`ATTACHMENT_DELETE_LOCK_DISABLED`) does not put them back.
The card warns that a shared scheme loses the grants in every project on it.
A refused app grant is retried daily, not hourly (`v070`).

### 9.2 Rich text follows the restored file

- **Unchanged text is re-pointed.** Deleting a file does not edit the
  description that shows it, so the description is not in the diff. When a
  rejection restores files, each tracked rich-text value that shows a file is a
  candidate (`planner.js` `repoint`, tree `REPOINT_RICH_TEXT`), written only if
  a pointer actually moves to a restored copy.
- **The newest live copy wins.** Aliases are read oldest first with the copy
  that owns each media id; of two copies of one original, the one still on the
  item is shown (`liveCopyMedia`).
- **Verification sees broken images.** A digest cannot tell a pointer to the
  deleted original from one to its live copy, so `verifyRestore` also reports
  tracked text showing a file no longer on the item (`danglingMediaPointers`).
- A restored copy's media id is asked for three times before it is unknown.

### 9.3 Two vault homes

A site with Confluence vaults to its private space; a Jira-only site vaults
to the Forge Object Store (`lib/vaultTier.js`, remembered in `vault:tier`).
Objects are keyed `vault/sha256/<hex>`, uploaded with a base64 SHA-256
checksum, and never expire. On a Confluence site, a file Confluence refuses —
or every file, when the vault space cannot be made — goes to the Object Store
and the ledger says why (`fallbackFrom`). Each copy records `storage` and
`object_key` (`v071`–`v072`); restore reads each from where it went, and a
copy missing from its store is named, not retried. A project on an Object
Store site still gets its `va_vault_space` row (`v073`–`v074`). An
administrator can pin the storage or hand it back to detection
(`admin:setVaultTier`).
