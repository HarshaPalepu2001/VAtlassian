# Per-field drift decisions — live acceptance checklist, 2026-10-07

Spec: `docs/superpowers/specs/2026-10-07-drift-field-decision-design.md`.
Plan: `docs/superpowers/plans/2026-10-07-drift-field-decision.md`.

**This is a checklist, not a result.** Everything below the line "Local evidence" is what the working tree
proves on its own. Nothing in the live section has been run: it needs a Forge deploy and install of the
working tree and a controlled issue on the test site (see the Jira test site memory for ids). Record the
outcome of each row the way `2026-10-05-live-baseline-drift-run.md` does: before, after, and the fresh Jira
read-back, in that order.

## Local evidence (this tree)

| Gate | Command | Result |
|---|---|---|
| Backend tests | `npm test` | 1717 pass, 0 fail |
| UI tests | `npm run test:ui` | 261 pass, 0 fail |
| Smoke imports | `npm run smoke` | 210/210 modules import |
| UI build | `npm run build:ui` | built; the existing chunk-size warning only |
| Frontend lint | `npm --prefix frontend run lint` | no findings in the new or changed files (pre-existing warnings elsewhere) |
| Diff hygiene | `git diff --check` | clean |

Not covered by any local test: the real `prepareApproval` against a live tree (its mixed planning is the same
`mixedPrepared()` the use-case tests drive, over a fabricated tree), Forge queue delivery of the restore job,
and the real capture of a post-restore tree. Those are what the live rows below exist to prove.

## Setup

A controlled issue **E** with at least two children, a tree baseline at version N, and tracked fields that
include a text field, a rich-text field, and one of: a link field, an attachments field. One tracked field must
have retention switched off, to exercise the non-restorable case. The reviewer holds the baseline's role.

## Live rows

| # | Scenario | Expect |
|---|---|---|
| L1 | Whole-set Approve on an issue with drift | unchanged from before: one signature, new version N+1, drift cleared, transitions open |
| L2 | Whole-set Reject on an issue with drift | unchanged: restored and verified, no new version |
| L3 | Open View changes; confirm Approve changes and Reject and restore remain in the footer, outside the comparison | both present, none inside the comparison |
| L4 | Decide every field: at least one Approve, at least one Reject; Save; sign once | one challenge, one signature; E ends with the rejected fields at their approved values and the approved fields as they were; **a new version N+1 whose content is exactly that mixed state**; drift 0; transitions open |
| L5 | Fresh Jira read-back of every affected field, the baseline version, the drift count | each rejected field equals version N; each approved field equals what the reviewer saw; version is N+1 |
| L6 | Audit ledger and the approval record for L4 | the approval is `MIXED`, carries the canonical field map and its hash, and the audit entry lists the map with the approved and rejected counts; the restore entry says `baselineCreated: true` |
| L7 | Baseline record for E after L4 | latest approval reads "Decided field by field"; the version's provenance is a mixed decision, not a whole-set approval |
| L8 | Decide every field Approve | no restore; one new version; receipt says a new baseline is the approved record |
| L9 | Decide every field Reject | restore only; **no new version**; item returns to version N; receipt says no new baseline is created |
| L10 | The field with retention off | Reject is disabled with the reason; Approve is allowed; the whole-set actions still work |
| L11 | Add or remove a child (a structural change) then open View changes | no decision controls; the reviewer is told changes can only be decided together; whole-set works |
| L12 | A viewer who cannot see one changed child | no decision controls ("changes on work items you cannot see"); no hidden key or value in the page |
| L13 | Controlled transition while a mixed restore is running, and after it completes | blocked while RESTORING; clear once the new baseline is published |

## Failure drills

| # | Drill | Expect |
|---|---|---|
| F1 | Edit any tracked field after opening View changes, before Save | choices are cleared with an explanation; nothing signed |
| F2 | Edit a field after the challenge is open, then sign | refused as changed content; no approval recorded |
| F3 | Sign with a wrong authenticator code | refused; no approval; the choices and the sheet remain |
| F4 | Cancel the signing sheet | choices intact; nothing recorded; Save still enabled |
| F5 | Submit the same challenge twice | the second is refused; exactly one approval |
| F6 | Sign as a different reviewer than the one who opened the challenge | refused |
| F7 | Edit an **approved** field between signing and the restore worker's verification | verification fails; the item is DRIFTED/ERROR; **no new baseline**; drift stays outstanding and blocks transitions |
| F8 | Make the baseline store fail during publication (or stop the capture) after the rejected fields are restored | restore row is PARTIAL with "baseline could not be published"; item ERROR; no clean "saved" anywhere; Retry restore publishes the baseline once the cause is gone |
| F9 | Make the queue unavailable at Save | decisions are recorded; the receipt says the restoration could not be started and the baseline is not published; Retry on the restoration continues |

## Findings

(Empty until the run.)
