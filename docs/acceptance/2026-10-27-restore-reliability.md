# Restore reliability investigation — 27 October 2026

Local reliability fixes are verified. These changes have not been deployed or
tested against a live Jira restore, and do not establish a fixed restore latency
or an unconditional recovery guarantee. Existing unrelated working changes were
preserved; nothing was committed.

## Defects reproduced and corrected

| Failure | Result after the change |
| --- | --- |
| A temporary Jira failure stops a batch without progress and immediately fails the restore. | The executor identifies the temporary failure; the worker requests redelivery of the same signed restore, preserving its action journal. Five automatic retries are allowed before a visible failure requiring review. |
| A failed vault copy reports `COMPLETE` and does not request another delivery. | Temporary failures request Forge redelivery; completed copies are skipped. Permanent file failures report `PARTIAL`. |
| Vault redelivery has no limit of its own: Forge keeps retrying for its whole retention window (normally 24 hours), re-attempting permanent failures and writing a new failure entry each time. | Retries stop after five with `PARTIAL`, or a recorded `FAILED` when the baseline files cannot be read. Each failed file is written to the ledger once across deliveries, and a file that failed permanently is not tried again. |
| A job without an attachment list copies whatever files happen to be on Jira. | It skips copying. Only the attachment list recorded by the capture can supply targets. |
| Restore saves copies of unbaselined additions before removing them. | These bytes are not put into Object Store. Their metadata and content hash are still audited before deletion. |
| Upload succeeds but its response, audit, or alias publication fails. | A retry can recover the existing upload using its filename and SHA-256, without another upload. A same-name file with different bytes is never accepted. |
| A newly uploaded file is listed before its content is readable. | A content 404 requests a retry, including on the next delivery; it does not trigger repeated uploads. |
| Alias publication succeeds before the restore audit write fails. | Evidence is written before publishing the alias, so a retry cannot silently skip an unaudited restored file. |
| A content 404 is counted as successful removal while the attachment remains listed. | A fresh attachment list must confirm absence; otherwise the operation retries. |
| A temporary permission-service failure is treated as a permanent refusal. | The error status reaches the worker's retry path. Actual permission denials still prevent mutations. |

## Work removed from the normal path

- An unchanged attachment already vaulted by an earlier baseline reuses that
  object after checking its existence through Forge metadata. It is not
  downloaded from Jira and uploaded again. If the object is missing and the
  original is still in Jira, the worker recreates the object.
- Restoring added files no longer uploads unbaselined content to Object Store.
- Restored files with no original media identity avoid media-ID requests and
  waits that cannot establish a mapping. Rich-text media checks remain.

These are reductions in external I/O, not measured live latency results. Queue
delivery and Jira response time still affect elapsed time. Forge's documented
[Async Events API](https://developer.atlassian.com/platform/forge/runtime-reference/async-events-api/)
defines the retry response and finite delivery retention window.

## Verification

Regression tests were run against the broken behavior before each fix. Coverage
includes temporary outages, redelivery, completed-step preservation, failed
alias/audit writes, delayed content visibility across deliveries, differing
same-name files, corrupt bytes, Object Store absence/unavailability, exact
baseline targets, and refusal to delete without audit evidence.

- `npm run verify`: passed, exit 0.
- Backend: **2,080 tests passed, 0 failed**.
- Frontend: **307 tests passed, 0 failed**.
- Import smoke check: **256/256 modules**.
- TypeScript and frontend production build: passed. Existing bundle-size warning.
- `forge lint`: exit 0, **0 errors, 1 warning** for the existing wildcard
  `external.fetch.client` permission. The sandboxed attempt could not access the
  keychain; validation succeeded with host access.
- `git diff --check`: passed.
- Independent review found missing-object reuse and delayed candidate-content
  visibility cases; both received reproductions and fixes.

## Remaining limits and live acceptance

1. **The first-copy window remains.** Capture publishes the baseline and then
   queues attachment copying (`src/usecases/drift.js`, `queueVaulting`). If a file
   disappears before the first copy and no earlier retained object exists, its
   bytes cannot be reconstructed. A baseline row is not proof that every file
   has a durable copy. Closing this requires a durable readiness/publication
   contract across capture and the vault, rather than removing restore checks.
2. **Initial enqueue failure is only audited.** `queueVaulting` records
   `VAULT_QUEUE_FAILED`; this patch does not add a durable outbox to recover a
   push that never reached Forge. Forge redelivery applies to accepted jobs.
3. **Existing limits still apply.** The current in-memory path caps files at
   250 MiB. Revoked Jira permissions, missing/corrupt retained bytes, unavailable
   rich-text media mappings, and incompatible approved link states remain
   explicit failures rather than false success.
4. **Live acceptance remains unrun.** On `mgtechdemo.atlassian.net`, measure
   rejection-to-completion for a field restore, deleted baseline attachment,
   rich-text image, and a hierarchy spanning more than one worker batch. Repeat
   restores, close the browser after signing, and confirm that new Jira IDs map
   to the baseline identities. Verify attachment bytes with SHA-256 and fresh
   Jira read-back, including the exact attachment set and rich-text placement.
   Do not mark fixture creation, a queue push, or a vault row as a passing restore.

The patches improve recovery within the existing architecture. They do not close
the two capture-to-vault durability gaps above or establish live acceptance.
