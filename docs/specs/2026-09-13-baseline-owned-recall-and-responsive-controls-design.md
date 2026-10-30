# Baseline-owned recall and responsive approval controls

**Date:** 2026-09-13
**Status:** Approved for implementation
**Extends:**

- `2026-09-11-workflow-driven-transitions-design.md`
- `2026-09-12-controlled-transition-tree-baseline-design.md`

## 1. Objective

Make the latest active baseline the single authority for drift recall, drift
decision, and restoration. A drifted issue returns to the source/review status
of the exact controlled transition that produced that baseline. From there,
the same role and authentication method can approve the changed content into a
new baseline or reject it and restore the signed content.

The issue panel and My Approvals must expose the right control state quickly.
They must not block their first useful render on a recursive Jira tree read,
changelog scan, or restoration history. Every available action for an eligible
role holder remains visible, and all actions are revalidated against fresh
server-owned state before they can change Jira or compliance records.

Electronic signature and biometric authentication are the only configurable
approval providers in this release. Jira-native approval and Jira Service
Management approval remain reserved for a later provider design.

## 2. Current-state defects this design closes

1. The controlled-transition backend requires an exact Jira transition id,
   while the administration screen currently selects only source and
   destination statuses and does not send the transition id. A new rule cannot
   be reliably created from the UI.
2. Drift recall calls `recallTargetStatus({ projectId, issueTypeId })`, which
   selects the most recently configured matching rule. It does not use the
   transition stored on the latest active baseline and can recall an issue to
   the wrong review status.
3. Drift approval is currently submitted without a transition. It can capture
   a replacement baseline while leaving the issue in review instead of
   executing the exact transition that owns the baseline.
4. The full panel state call reads all fields, edit metadata, baseline values,
   changelog evidence, and potentially the complete governed tree before the
   primary controls render.
5. Observer responses omit transition details that every viewer needs: whether
   the issue is at a controlled gate, which role owns it, its destination, its
   control method, and its baseline provenance.
6. Panel refresh currently includes a fixed 15-second polling interval even
   though the requested interaction model is event driven.
7. The current local backend suite is not a green starting point: the
   2026-09-13 run reported 704 passes and 13 failures. Tree capture and the
   connected drift approval/restoration journeys must be repaired before new
   behavior is accepted.

## 3. Governing model

### 3.1 Exact controlled transition

A controlled transition is keyed by:

- tenant/application installation;
- project id;
- issue type id, including the existing issue-type wildcard;
- Jira transition id;
- source status id, including `*` only for a real Jira global transition; and
- destination status id.

The Jira transition id is authoritative. Source and destination statuses are
recorded context and validation constraints; they never substitute for a
missing transition id. Two Jira transitions that reach the same destination
remain two different controls.

Each active rule records:

- required role;
- explicit authentication provider: `ESIGNATURE` or `BIOMETRIC`;
- signer-facing meaning;
- whether approval captures a baseline;
- whether unresolved drift blocks the transition; and
- the optional ordinary rejection destination for rejecting an initial
  transition request.

### 3.2 Latest active baseline authority

Every complete active baseline version records immutable control provenance:

- `transition_id`;
- `from_status_id`, called the **review status**;
- `to_status_id`, called the **approved destination**;
- `required_role` as it was signed;
- `required_assurance` as it was signed;
- approval id, signer identity, printed signer name, and signed time;
- controlled-field catalogue/version;
- root/tree content digest and baseline version.

The latest complete active baseline is selected at decision time. A user does
not restore the baseline they personally signed if a later baseline exists.
All challenge bindings include the active baseline id and version. Publishing a
new version makes older challenges stale.

The role and provider attached to the active baseline remain the authority for
its drift even if the current administration row is later edited. A removed or
invalid current rule creates an administrator-facing configuration incident,
but never silently changes the authentication method or role for existing
signed evidence.

## 4. Drift lifecycle

### 4.1 Detection and recall

Drift is computed only against a complete active baseline. The detector first
records the drift evidence and places the issue in a durable blocking state.
It then reads the latest baseline and attempts to return the issue to that
baseline's `from_status_id` using a Jira-offered transition.

Recall rules:

1. If the issue is already in the baseline review status, no status mutation is
   attempted.
2. If Jira offers exactly one usable route to the baseline review status, the
   app executes that route as the app and records the exact transition used.
3. If no route exists, more than one route is ambiguous, a route has an
   unsatisfied screen, or another Jira rule refuses it, drift remains blocking.
   The issue is not forced through a different status. A configuration incident
   is visible to administrators.
4. A recall transition never changes, clears, or replaces the active baseline.
5. Redelivered Jira events and scheduled reconciliation converge on the same
   state and never execute duplicate recall after the issue reaches review.

Recall uses `baseline.from_status_id`. The generic
`recallTargetStatus(project, issueType)` lookup is not part of this path.

### 4.2 Approving drift

The approver must currently hold the baseline's recorded role. The server
selects the baseline's recorded provider and issues a challenge bound to the
latest baseline version, current complete controlled content, actor, decision,
and exact baseline-owned transition.

On successful authentication:

1. Acquire the decision lease with compare-and-swap.
2. Re-read the current complete governed content and refuse stale evidence.
3. Persist and publish baseline version N+1 atomically/all-or-nothing.
4. Preserve N and all earlier immutable baseline and approval records.
5. Make the new approval available to the exact Jira validator.
6. Execute the baseline-owned Jira transition id from the review status to its
   approved destination.
7. Consume the transition capability once and broadcast the resulting state to
   open app surfaces.

If baseline N+1 cannot be completely published, the Jira transition is not
attempted. If another Jira validator blocks after signing, the recorded
attempt is not reused; the user must review fresh state and sign again after
the Jira constraint is corrected.

### 4.3 Rejecting drift

Rejection uses the same recorded role and provider as the active baseline. It
does not execute the ordinary `reject_to_status_id` configured for an initial
transition request.

On successful authentication:

1. Acquire the restoration lease with compare-and-swap.
2. Re-read the governed content and refuse stale evidence.
3. Restore every retained controlled value and governed tree relationship to
   the latest active baseline.
4. Verify the complete tree, every controlled field, and the root issue status
   with a fresh Jira read.
5. Leave the root issue in the baseline review status.
6. Clear drift only after complete verification.

A partial write, unsupported field, permission denial, missing retained value,
failed node operation, wrong parent, wrong status, or read-back digest mismatch
remains `PARTIAL` or `ERROR`; it never reports success and never releases the
gate. `COMPLETE_WITH_REPLACEMENTS` remains distinct where a deleted Jira issue
had to be recreated with a new Jira identity.

## 5. Surface behavior

### 5.1 Jira transition screen

The transition screen is dedicated. Jira has already selected the transition,
so the screen displays one read-only control context and never offers a
transition dropdown.

It shows:

- exact source and destination status names;
- role;
- printed signer name;
- signer-facing meaning;
- required authentication method;
- whether a baseline will be captured or replaced; and
- whether unresolved drift blocks the action.

The submitted custom-field value is only an opaque approval receipt. Jira's
workflow validator rechecks the exact transition id, actor-independent server
record, content binding, assurance, expiry, and drift state.

### 5.2 Issue panel and My Approvals

These surfaces use one shared panel model. My Approvals embeds the same decision
component and does not implement a second approval flow.

Every viewer sees:

- controlled/uncontrolled state;
- current status and controlled destination;
- exact transition scope, including `Any status -> X` versus `A -> X`;
- required role and authentication method;
- whether the transition captures a baseline or blocks drift;
- latest baseline version, owner, signed time, method, and controlled-content
  count;
- latest transition approval owner/time/outcome, including approvals that did
  not create a baseline; and
- active drift/restoration state.

An eligible role holder also sees every currently applicable action
without opening a disclosure:

- a transition selector when two or more controlled transitions are available;
- one primary button labelled `Approve -> <selected destination>`;
- `Approve changes` while deciding drift;
- `Reject and restore` while deciding drift; and
- `Retry transition` or `Retry restoration` only when durable state proves the
  corresponding operation is resumable.

Changing the transition selector immediately replaces the role, meaning,
provider, baseline consequence, drift consequence, and primary-button label.
No evidence or confirmation entered for the old selection carries to the new
selection.

Ineligible viewers see the same control summary and the role that is required,
but no enabled decision control. Administrators also see configuration
and recall incidents. Configuration warnings are not broadcast to ordinary
users as operational tasks.

## 6. Responsive read model

### 6.1 Split summary from evidence

Replace the single heavy `panel:getState` dependency with two reads:

1. `panel:getSummary` returns compact issue identity/status, current controlled
   actions, role eligibility, latest approval summary, latest baseline summary,
   drift counters, restoration state, and administrator incident counts. It
   reads only narrowly selected Jira fields and indexed SQL rows. Independent
   reads execute in parallel.
2. `panel:getEvidence` returns controlled values, recursive tree detail,
   changelog attribution, full differences, baseline history, and restoration
   history. It loads after the summary or when its section is opened.

The summary response never performs a recursive tree traversal or unbounded
changelog scan. Evidence loading never hides or disables already-rendered
controls, except when it discovers a newer state and replaces the summary.

Every approval challenge and submit still performs a fresh authoritative read.
The fast model is for presentation, not authorization.

### 6.2 Interaction and refresh

- Render the panel shell and labelled loading placeholders immediately; never
  show an empty panel.
- Show summary content as soon as `panel:getSummary` returns.
- On a click, synchronously switch the button to a specific progress label and
  disable duplicate submission before invoking the resolver.
- Coalesce concurrent refresh requests and discard stale responses by sequence.
- Refresh on `JIRA_ISSUE_CHANGED`, `VA_ISSUE_CHANGED`, window focus/visibility
  return, a completed action, and manual Refresh.
- Remove the fixed 15-second polling interval.
- Emit one app event after a durable state change. Components do not emit
  duplicate events for the same operation.

Performance objectives, measured separately for warm and Forge cold-start
invocations:

- no unlabelled blank state at any time;
- warm `panel:getSummary` end-to-end p95 at or below 2 seconds on the demo
  tenant;
- cold-start summary target at or below 5 seconds, with useful labelled state
  visible while waiting;
- visible button feedback within 100 ms of interaction; and
- no approval or restoration request holds the UI without a state-specific
  progress or recovery message.

Atlassian network or cold-start latency cannot be eliminated, so exceeding a
target is recorded as a performance failure with timing evidence rather than
hidden behind an indefinite spinner.

## 7. Resumable restoration

A potentially long tree restoration is a durable operation, not one browser
request that must remain open until every Jira mutation completes.

1. The signed rejection creates the restore record and journaled steps before
   returning control to the UI.
2. The first bounded batch may run inline when time permits; remaining steps are
   continued by the existing Forge job/queue infrastructure.
3. The panel shows `Restoration in progress`, completed/remaining step counts,
   the last verified checkpoint, and any actionable failure.
4. Retries claim only unfinished or safely resumable steps. A retry never mints
   a second rejection signature.
5. The issue stays locked against controlled progression until fresh full-tree
   verification reaches `COMPLETE` or `COMPLETE_WITH_REPLACEMENTS`.

## 8. Administration

The rule form is populated from Jira's real workflow transitions for the
selected project and issue type. Administrators select an actual transition,
not independent status labels. The UI then displays the transition's id,
source, destination, global/edge scope, screen presence, and detected Jira
rules as read-only facts.

Creation is refused when:

- the transition no longer exists or is ambiguous;
- the VAtlassian validator is not attached and enabled;
- no eligible holder exists for the selected role;
- an authentication provider is missing or invalid;
- a baseline-capturing rule has any controlled field without a retained raw
  value; or
- the rule conflicts with an active rule for the same exact transition and
  scope.

Only administrators receive configuration-health warnings. Reviewers receive
actionable denial text when a control cannot run, without being asked to repair
configuration.

## 9. Concurrency and failure rules

- `DECIDING` and `RESTORING` remain bounded operation leases; `LOCKED` remains a
  durable hard lock.
- Challenge, submit, apply, transition retry, restore retry, and background
  continuation all recheck the latest active baseline version.
- Duplicate clicks, resolver retries, Jira event redelivery, and concurrent
  role holders converge on one decision and one baseline version.
- A later role holder's successfully published baseline immediately supersedes
  older versions for every user.
- No client-provided role, assurance, transition meaning, baseline id, version,
  actor name, or destination is authoritative.
- Failed audit persistence prevents the approval from becoming usable.
- Failed baseline persistence prevents the Jira transition.
- Failed restore verification keeps drift and gate blocking active.

## 10. Implementation sequence

1. Restore a green local baseline: repair the 13 failing tree-capture and
   connected drift/restoration tests without weakening their assertions.
2. Repair exact-transition administration by loading Jira transitions and
   submitting the selected transition id.
3. Persist/return complete baseline policy provenance needed for future drift
   decisions.
4. Replace generic recall target selection with latest-baseline-owned recall.
5. Make drift approval execute the baseline-owned transition after publishing
   baseline N+1.
6. Verify rejection restores content/tree/status and remains in the baseline
   review status.
7. Introduce the compact shared summary model and lazy evidence model.
8. Align the transition screen, issue panel, and My Approvals with the shared
   contracts and visible-control rules.
9. Make long restoration resumable without holding the UI request open.
10. Run local correctness, performance, accessibility, manifest, and build
    verification.
11. Deploy only after confirming Forge app identity, tenant, SQL migrations,
    and installation; then execute the live Jira acceptance matrix.

## 11. Verification

### 11.1 Automated behavior

Tests must prove:

- admin selection carries the exact Jira transition id;
- sibling transitions to the same status cannot borrow policy or evidence;
- wildcard and directed transitions remain visually and cryptographically
  distinct;
- recall uses the latest baseline's source status when several rules exist;
- zero, one, and multiple recall routes fail or proceed deterministically;
- drift approval uses the baseline role/provider and executes the exact
  baseline transition after N+1 is durable;
- drift rejection uses the latest active baseline, not the signer's historical
  baseline;
- the entire controlled tree and root status verify before restore completion;
- all viewers receive control/baseline provenance while only eligible actors
  receive enabled actions;
- changing the selector invalidates confirmation/evidence from the prior edge;
- summary rendering does not wait for evidence/tree/changelog reads;
- event/focus/manual refresh has no interval timer and stale responses cannot
  overwrite newer state;
- duplicate approvals, role-holder races, stale challenges, partial writes,
  job retries, and Jira validator denial remain fail closed; and
- the full backend, frontend, smoke-import, TypeScript, bundle, manifest, and
  formatting checks pass with zero failures.

### 11.2 Live Jira acceptance

Local tests are not completion. On the intended development tenant, exercise:

1. Electronic signature with and without baseline capture from the transition
   screen, issue panel, and My Approvals.
2. Biometric authentication with and without baseline capture from all
   supported surfaces.
3. Two same-destination transitions and an `Any status` transition, proving the
   selected rule's exact controls load immediately.
4. Drift after later workflow movement, proving recall returns to the latest
   baseline's source status.
5. Approve recalled drift, proving N+1 publishes before the exact transition
   reaches its destination and all open actions disappear.
6. Reject recalled drift, proving controlled fields, tree relationships, added
   nodes, deleted-node replacement mapping, and review status through fresh
   read-back.
7. Partial restoration and resumable retry without a new signature.
8. Concurrent decisions by two holders of the same role.
9. Detached validator, missing role holder, provider refusal, stale evidence,
   failed audit persistence, and another Jira validator denying the move.
10. Warm/cold summary timing and immediate interaction feedback in the real
    issue panel and My Approvals.

Record deployment, migration, UI rendering, authentication ceremony, Jira
mutation, audit evidence, and final read-back as separate results.

## 12. Deferred scope

- Jira-native approval as an approval provider.
- Jira Service Management approval as an approval provider.
- Ungated walk-forward or connective-tissue buttons.
- Scheduled UI polling.
- Restoration of comments, worklogs, attachments, external assets, or Jira's
  immutable issue identity/history beyond the existing explicit tree contract.
