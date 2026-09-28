# Confluence Attachment Vault — Design (Phases 1 & 2)

> **Revised 2026-09-23 — supersedes "Confluence layout" below.**
> - **One vault space for the whole site** (`VATVAULT`, recorded in `va_vault_site`),
>   not one per project: each project is a page under the vault home page, each
>   work item a child page of its project. A site with 1000 controlled projects
>   still has one vault.
> - **Created private to the app** (`createPrivateSpace: true` on the v2 create call).
>   No person sees it in the directory or search. Access is granted to a named
>   person only when an audit needs it; a Confluence admin can always recover
>   access from Confluence administration. The old create-then-delete-every-grant
>   step is removed: it left the space open until the deletes ran and would have
>   stripped the app's own access.
> - The existing space is adopted on a key collision **only if the app created it**.
> - **Hourly backfill** (`jobs/vaultBackfill.js`) provisions every project with an
>   ACTIVE baseline-capturing rule whose vault is incomplete, so rules saved before
>   vaulting existed, and failed attempts, need no re-save.
> - The first two live attempts (2026-09-22/23, project VAT) failed **401**: the v2
>   create-space endpoint needs the granular `write:space:confluence` scope, which
>   the manifest lacked. Scopes added: `read/write:space:confluence`,
>   `read/write:page:confluence`, `read:content-details:confluence`,
>   `write:attachment:confluence`, `write:confluence-file`.
> - Attachments upload with `PUT` + `minorEdit` (create-or-new-version), named
>   `<jiraAttachmentId>-<filename>` so same-named files stay distinct.

Status: approved for spec review, not yet implemented.
Scope: vault provisioning + attachment-deletion lockdown (Phase 1) and baseline-time
attachment push to the vault (Phase 2). Detecting a deleted vaulted attachment and
restoring it (Phase 3) is a **separate, later spec** — it touches the existing
tree/field restore engine and deserves its own design pass.

## Problem

`FIELD_KIND.ATTACHMENTS` is graded `PARTIAL` fidelity on purpose
([baseline.js](../../../src/lib/baseline.js)): attachment changes arrive from Jira's
changelog as per-item add/remove rows with no whole-value `from`, so there is nothing
to rewind to, and the app has always refused to guess. That leaves attachments as the
one controlled-field kind with no compliance story: if one is deleted from an
approved issue, the app can neither detect it precisely nor recover it.

The frontend already stubs a fix for this — [`ConfluenceSpaceSetup.tsx`](../../../frontend/src/confluence/ConfluenceSpaceSetup.tsx)
has an "Attachment Mode: Vaulting" option, and [`governanceCore.js`](../../../src/lib/governanceCore.js)
carries an unused `vaultMode` field — but nothing behind either does anything. This
spec is that missing backend piece, scoped to Jira issue attachments specifically
(a distinct concern from the existing Confluence-native content governance system
built around `GovernedObjectRef`/`ConfluenceAdapter`, which this reuses only for its
Confluence REST plumbing, not its data model).

## Goals

- The moment a project gets a controlled transition with `capture_baseline = true`,
  the project silently (no end-user-visible change beyond the permission effect)
  gets: a dedicated Confluence space to hold attachment evidence, and a project-wide
  block on deleting Jira attachments.
- Every time a baseline is captured for an issue in such a project, that issue's
  current attachments are copied into the vault space as durable, hashed evidence.
- None of this can fail an approval or a config save. Vaulting is defense-in-depth,
  not the system of record — the baseline row already is.

## Non-goals (this spec)

- Detecting that a vaulted attachment was deleted, and restoring it. That is Phase 3.
- Reversing the attachment-deletion lockdown if the controlled transition is later
  revoked. Evidence already collected should not become deletable again just because
  a gate was turned off; this is a deliberate one-way door.
- Any new admin-console UI. Per discussion, this is meant to be invisible to
  ordinary users and not surfaced with new UI chrome — admins can already see it by
  visiting the Confluence space directly once it exists.

## Architecture

### Trigger point: enabling baseline capture on a project

[`createControlledTransition`](../../../src/usecases/transitions.js) and
`updateControlledTransition` are where an admin sets `capture_baseline = true` on an
`ACTIVE` controlled transition — this is the one place "a project gets a baseline
condition" actually happens, and the project id is already a mandatory part of that
input. When a save results in an ACTIVE row with `capture_baseline: true`, it calls
a new `provisionVault(projectId)` (in a new `src/lib/vaultProvision.js`) which does
two independent, individually-idempotent things:

1. `ensureVaultSpace(projectId)`
2. `lockAttachmentDeletion(projectId)`

Both failures are caught and audited but **never fail the controlled-transition
save** — the transition rule itself is the authoritative configuration; vault
provisioning is a side effect that self-heals (see Idempotency below).

### Push point: baseline capture

[`applyApproval`](../../../src/usecases/drift.js) already captures a baseline via
`writeCapturedBaseline` or `writeCapturedTreeBaseline`, both returning a `baselineId`.
Immediately after `capture.captured === true`, if `checked.gate?.capture_baseline`,
it enqueues `{ baselineId, issueId, issueKey, projectId, approvalId }` onto a new
Forge queue `va-vault-queue` (mirrors the existing `va-restore-queue` pattern used by
`restoreActions.js`/`restoreWorker.js`). A new `src/jobs/vaultWorker.js` consumer
does the actual Confluence work asynchronously, off the approval request's latency
budget, with Forge's built-in at-least-once queue retry.

Enqueue failures are caught, audited (`VAULT_QUEUE_FAILED`), and do not fail the
approval.

## Data model (new tables, `db/migrations.js`)

```sql
CREATE TABLE IF NOT EXISTS va_vault_space (
  project_id BIGINT NOT NULL,
  space_id VARCHAR(64) NOT NULL,
  space_key VARCHAR(64) NOT NULL,
  permission_scheme_id VARCHAR(64) NULL,
  permission_locked_at BIGINT NULL,
  created_at BIGINT NOT NULL,
  created_by VARCHAR(128) NOT NULL,
  PRIMARY KEY (project_id)
);

CREATE TABLE IF NOT EXISTS va_vault_page (
  issue_id BIGINT NOT NULL,
  project_id BIGINT NOT NULL,
  confluence_page_id VARCHAR(64) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (issue_id)
);

CREATE TABLE IF NOT EXISTS va_vault_attachment (
  id VARCHAR(128) NOT NULL,
  baseline_id VARCHAR(128) NOT NULL,
  issue_id BIGINT NOT NULL,
  jira_attachment_id VARCHAR(64) NOT NULL,
  filename VARCHAR(512) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  confluence_attachment_id VARCHAR(64) NOT NULL,
  vaulted_at BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_baseline_attachment (baseline_id, jira_attachment_id)
);
```

`va_vault_space.permission_scheme_id`/`permission_locked_at` record which scheme was
edited and when, so the ledger (see Audit trail) can always be cross-checked against
current Jira config.

## Confluence layout

- Space key: `VLT<PROJECTKEY>` (project key uppercased, non-alnum stripped). On a
  409 (key already taken — e.g. a half-finished earlier attempt whose DB insert
  failed), look the space up by key via `GET /wiki/api/v2/spaces?keys=...` and adopt
  its id rather than erroring. This makes `ensureVaultSpace` idempotent across
  partial failures without needing a two-phase commit.
- One Confluence page per issue, titled with the issue key, created lazily by the
  vault worker on the first attachment it ever vaults for that issue. All of that
  issue's baselined attachments live on this one page; a later baseline uploads the
  then-current attachment set as new attachment versions on the same page.
- Space permissions restricted to VAtlassian admins and the app itself, so ordinary
  project members can't browse or alter the evidence directly. **Implementation-time
  verification needed**: Confluence's v2 space API has limited permission-write
  support; this may require the legacy `/wiki/rest/api/space/{key}/permission`
  endpoint. Verify against the live VJIRA/Confluence test site during
  implementation and note in the PR if only a partial restriction (e.g.
  space-admins-only, not finer-grained) is achievable.

## Attachment-deletion lockdown

`lockAttachmentDeletion(projectId)`:

1. Read the project's permission scheme (`GET /rest/api/3/project/{projectId}/permissionscheme`).
2. Remove every grant for `DELETE_OWN_ATTACHMENTS` and `DELETE_ALL_ATTACHMENTS` on
   that scheme (`DELETE /rest/api/3/permissionscheme/{schemeId}/permission/{permissionId}`
   per grant, or the bulk equivalent).
3. Record `permission_scheme_id`/`permission_locked_at` on `va_vault_space` and
   append an audit event `ATTACHMENT_DELETE_LOCKED` with the scheme id **and the
   full list of other project keys currently using the same scheme**, so the
   ledger always shows the true blast radius even though the action isn't blocked
   by it.

This is deliberately **project-wide, not per-issue and not per-attachment** — Jira's
permission model has no finer granularity than the permission scheme, which is
shared by every issue in the project (and, if the admin has set it up that way,
by other projects too). Confirmed acceptable: projects that don't have a VAtlassian
controlled transition configured were never going to have drift tracked on them
regardless of this side effect. The lockdown is **one-way** — it is never reversed
by revoking the controlled transition (see Non-goals).

A determined actor with elevated Jira/site-admin rights can still bypass a
permission scheme (e.g., by editing it back before deleting). That is exactly why
Phase 3 exists: this lockdown deters and mostly prevents; the vault copy plus drift
detection is the actual guarantee.

## Idempotency & error handling

- `ensureVaultSpace` and `lockAttachmentDeletion` are both check-then-act with a
  durable row (`va_vault_space`) as the source of truth for "already done" — safe
  to call repeatedly from both the eager (config-save) and lazy (vault-worker
  fallback, in case the eager call failed) call sites.
- The vault worker skips any `(baseline_id, jira_attachment_id)` pair already in
  `va_vault_attachment` (Forge queues are at-least-once).
- Per-attachment upload failures are caught individually and audited
  (`ATTACHMENT_VAULT_FAILED`) without aborting the rest of that baseline's
  attachments — same "don't let one bad item block the others" rule gatecheck.js
  already follows. Since every baseline pushes the *current* full attachment set,
  a transient failure self-heals on the issue's next baseline.
- New audit events (`src/lib/ledger.js`): `VAULT_SPACE_CREATED`,
  `VAULT_SPACE_CREATE_FAILED`, `ATTACHMENT_DELETE_LOCKED`,
  `ATTACHMENT_DELETE_LOCK_FAILED`, `VAULT_QUEUE_FAILED`, `ATTACHMENT_VAULTED`,
  `ATTACHMENT_VAULT_FAILED`.

## Manifest changes

- New scopes: none. `write:confluence-space`, `write:confluence-content`,
  `read:confluence-content.all`, and `manage:jira-configuration` are all already
  declared.
- New `consumer`: `va-vault-consumer` (queue `va-vault-queue`) → function
  `vault-worker`.
- New `function`: `vault-worker` → `jobs/vaultWorker.handler`.

## Testing

- Unit tests for `ensureVaultSpace` (key derivation, idempotency, 409-adoption
  path) and `lockAttachmentDeletion` (grant removal, shared-scheme audit payload),
  with mocked `deps`, following this repo's existing pattern
  (`capture.js`/`restoreWorker.js` tests).
- Unit tests for the vault worker: skip-already-vaulted, per-attachment failure
  isolation, lazy space/page creation fallback.
- One live end-to-end pass against the VJIRA test site before calling this done:
  create a controlled transition with baseline capture on a test project, confirm
  the space and permission-scheme change land, approve an issue with an
  attachment, confirm it appears in the vault page, and confirm deleting an
  attachment through the normal Jira UI is now refused.

## Open items to verify during implementation

1. Exact Confluence API for restricting space permissions (v2 vs legacy REST).
2. Exact Jira permission-scheme REST shape for bulk-removing two permission types
   from every existing grant on a scheme.
