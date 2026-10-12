# Continuous review cursor and scope-assurance design

**Date:** 2026-10-12

**Status:** Approved in chat; ready for implementation planning

## Purpose

Make change review navigation predictable, preserve the baseline lifecycle when
decisions are saved, and ensure each decision is recorded with the immutable
assurance policy of the baseline that governs its exact scope.

This design covers Jira drift review for parent and child issues, including
parent-captured child content.

## Review timeline cursor

The timeline is a read-only navigation control. It never changes an approval
decision, restores content, or creates a baseline.

The range input uses a normalized position range rather than raw epoch
milliseconds. A position maps proportionally to the interval from the first
recorded change to the last recorded change. This avoids browser precision and
interaction problems from a very large native range.

As the cursor moves, the review selects the latest recorded change at or before
the cursor timestamp. Therefore, moving right never selects an earlier change,
and moving left never selects a later change. Before the first event, no event
is selected. At an exact event timestamp, that event is selected.

The control updates while the pointer is dragged (`input`), while keyboard
controls are used, and when a timestamp marker is chosen. A visible cursor
timestamp makes the current position clear. Markers continue to jump to their
exact timestamps. When multiple fields changed at one timestamp, the existing
field chips remain available so the reviewer can select each field separately.

## Baseline publication lifecycle

The decision record and the replacement baseline are separate operations.
`Save changes` may record approved and rejected field decisions, but a new
baseline is published only when the resulting decision contains at least one
approved field.

| Decision submitted | Restore required | New baseline | Publication point |
| --- | --- | --- | --- |
| Direct reject of the full change set | Yes | No | Never |
| Save changes with every changed field rejected | Yes, if a restoration is needed | No | Never |
| Save changes with approved and rejected fields | Yes | Yes | Only after every rejected field is restored and verified against the standing baseline |
| Save changes with every field approved | No | Yes | After the decision is accepted |

For an all-rejected mixed decision, the worker restores required values,
re-reads Jira, verifies the restored result, records completion, and marks
baseline publication as `NOT_NEEDED`. It keeps the standing baseline as the
latest baseline.

For a decision that contains approvals and rejections, the worker must not
capture until the restore and fresh read-back confirm every rejected value. A
stale issue, failed restore, failed verification, capture failure, or duplicate
delivery must never publish a replacement baseline early or more than once.

## Assurance policy by decision scope

The assurance policy is frozen in the latest active baseline that owns the
content being decided. The current mutable configuration and another scope's
assurance method cannot replace it.

The resolver uses this order:

1. Identify the exact review scope chosen by the user.
2. Resolve the latest active baseline that owns that scope's content, using
   immutable tree provenance for parent-captured descendants.
3. Use that baseline's frozen assurance policy for the challenge, assertion,
   decision record, and any replacement baseline created from that decision.

Examples:

| Review action | Parent active baseline | Child active baseline | Assurance used |
| --- | --- | --- | --- |
| Decide drift from the parent review | Biometric authentication | A later child-owned electronic-signature baseline | Parent biometric authentication |
| Decide the parent drift directly | Biometric authentication | A later child-owned electronic-signature baseline | Parent biometric authentication |
| Open and decide the child drift directly | Biometric authentication | A later child-owned electronic-signature baseline | Child electronic signature |
| Decide a child that has only inherited the parent capture | Biometric authentication | None | Parent biometric authentication |

Separate parent and child decisions each require their own assurance event when
their governing baselines have different policies. The system does not select a
globally strongest method or silently substitute an available provider.

## Failure and concurrency requirements

- Read the active baseline and its frozen policy again before recording a
  decision; reject incomplete, ambiguous, or stale scope resolution.
- A decision is bound to its reviewed content and governing baseline. Content
  changes between review and save fail closed rather than being recorded under
  a different baseline.
- Restore jobs are idempotent. Re-delivery cannot duplicate a decision,
  baseline, or audit event.
- Parent and child capture coordination retains existing per-issue ordering and
  immutable provenance rules. A child-owned baseline does not alter the policy
  for a parent-scoped decision.

## Verification matrix

The implementation must add or update focused regressions for the following:

1. Drag forward and backward through the full timeline, including positions
   between changes, exact markers, before the first change, and after the last
   change. Selection follows chronological floor semantics in both directions.
2. Keyboard range changes and marker clicks follow the same mapping as pointer
   dragging; equal-timestamp field chips select each individual field.
3. Direct full-set rejection restores the standing baseline, produces no
   capture request or new baseline, and remains idempotent after duplicate job
   delivery.
4. A saved all-rejected field set completes required restoration and produces
   no capture request or new baseline, including after a duplicate job
   delivery.
5. A mixture with at least one approved field produces exactly one replacement
   baseline only after restoration and fresh verification of every rejected
   field.
6. A stale read, restore failure, verification mismatch, or capture failure
   creates no successful baseline and leaves a recoverable partial or failed
   state with evidence.
7. A parent baseline using biometric authentication and a later child-owned
   electronic-signature baseline yields biometric assurance for parent review
   and electronic-signature assurance for direct child review.
8. An inherited child scope uses the parent's frozen policy, and a later change
   to live configuration cannot replace any of these policies.

## Evidence boundary

Automated tests, local builds, and Forge harness results prove the implemented
contracts in the repository. They do not prove a deployed tenant's Jira or
assurance-provider behavior. Any live acceptance run must use an explicitly
identified tenant, issue, baseline, and visible scoped change set, and the user
must complete any WebAuthn, biometric, or electronic-signature interaction.
