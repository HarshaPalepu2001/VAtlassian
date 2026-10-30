# Workflow-driven transitions

**Date:** 2026-09-11
**Status:** Approved for implementation, Phase 1
**Supersedes:** nothing. Extends `src/lib/journey.js`, `src/lib/gateDrift.js`.

---

## 1. The problem

VAtlassian decides what to offer a reviewer from its own configuration. Jira
decides what is actually possible, and whether anything of ours is attached to
the edge. Today those two answers are never compared at the moment a button is
drawn, and three consequences follow.

**A detached validator still draws a button.** `src/lib/journey.js` already
accepts an `enforced[]` array and already defines the `GATE_NOT_ENFORCED`
blocker for exactly this case. No caller passes it. `src/usecases/panel.js:60`
and `src/usecases/queue.js:112` both call `resolveActions` without it, so the
branch at `journey.js:152` is dead code. An administrator who detaches
VAtlassian Approval from a controlled transition leaves every panel offering
"Sign to move to Done" for an edge where the signature is collected and then
enforces nothing. `src/lib/gateDrift.js` calls this the one failure mode in the
app that produces a silent permit.

**The scope of a wildcard rule never reaches the signer.** `describeAction`
(`journey.js:74-89`) computes `anyStatus` from `gate.matched_any_status` and a
`label`, and `src/usecases/panel.js:125` transports both to the client.
`frontend/src/panel/sections/ApprovalControls.tsx:111` renders Jira's raw transition name, `t.name`, and re-derives its own button text at `:131-138`.
`label` is declared in `frontend/src/panel/types.ts:3` and never read.
`anyStatus` is not in the frontend type at all. A standing permission to close
an item from anywhere is therefore presented identically to one step in a
sequence.

**Native Jira validators are invisible.** `isOurGate` deliberately matches only
our own module. Nothing models a JSM approval or a built-in Jira validator on
the same edge, so the panel cannot tell a reviewer that Jira is also going to
intercept the move.

### 1.1 The same shape, four times over

An audit on 2026-09-11 of the twelve fixes described in the preceding
walkthrough found five fully correct, six partially correct, and one
unverifiable. Every one of the six partials is the same defect: the fix landed
in one place and its siblings were missed.

| Behaviour | Correct in | Missed in |
|---|---|---|
| Done/self-transition suppression | `panel.js:39-41`, `signing.js:37-44` | `queue.js:96-112` |
| "No baseline implies no drift" | `panel.js:109-113` (`getState`) | `panel.js:173-175` (`getGlanceState`), `queue.js:42-43`, `resolvers/issueStatus.js:21` |
| Timestamp string/ISO handling | `frontend/src/ui/format.ts:83-96` | `frontend/src/ui/feedback.tsx:26` |
| Status *name* rather than id | `ApprovalControls.tsx` (partly) | `frontend/src/field/ApprovalField.tsx:209` |

`journey.js` already provides one decision function for four views. Those views
still assemble different inputs. This design gives them one shared function
to assemble those inputs.

---

## 2. The model

Jira's workflow is the source of truth for what is **possible**. VAtlassian
configuration is the source of truth for what is **controlled**. A button
appears only where the two overlap, and it states which edge it means.

For each transition Jira offers from the issue's current status:

| Validator on the edge in Jira | Our config | Outcome |
|---|---|---|
| VAtlassian Approval, enabled | present | **Checkpoint.** Role check, assurance, baseline, drift. Panel **and** My Approvals. |
| VAtlassian Approval, enabled | absent | **Orphaned.** Explain the dead end. Show no button because `gate.js` would deny `NOT_CONFIGURED`. |
| VAtlassian Approval, detached or disabled | present | **Unenforced.** Warning, no button. Never a plain move. |
| Native Jira validator (JSM approval, built-in) | any | **Jira is intercepting.** Surfaced as context. We never claim to satisfy another vendor's validator. |
| None | absent | **Ungated transition.** Plain move, ledger entry, no signature. Panel **only** (Phase 2). |
| Jira offers no transition at all | any | Show nothing. Our configuration alone must never draw a button. |

Two distinct things exist at once and must not be conflated:

- A **global transition** is an administrator-configured `Any -> X` edge carrying our
  validator. Fully gated, role-checked, signed, and labelled with its scope.
  Appears on both surfaces.
- An **ungated transition** moves between checkpoints. It records a ledger entry without a signature and appears only in the panel,
  because it is not an approval.

From `Open`, a reviewer may see *"Move to In Review"* (walking toward a
downstream checkpoint) and *"Sign to close this as Done · available from any
status"* (the global transition) side by side, distinguished by weight and label.

### 2.1 Visibility

Everyone sees the map: where the next checkpoint is and which role it waits on.
Only the holder of that role gets clickable controls. This applies to the
ungated moves as well as to the checkpoints. These moves
let the approver reach their checkpoint. Anyone else advances the item
through Jira's own UI.

---

## 3. Compliance basis

**11.10(f). Permitted sequencing.** The clause requires the system to enforce
the sequence the organisation *permits*, not linearity. An administrator who
configures a global `Any -> Done` transition and attaches VAtlassian Approval
to it has defined a permitted sequence. Honouring it is a shortcut, not a
bypass: the signature is still collected, the role still checked, drift rules
still applied. A configured edge whose validator is detached is
an unenforced control. This design shows no button for that edge.

**11.50. Signature manifestation.** The signer must see the scope of what they
sign at the moment of signing. `anyStatus` must reach the screen. Two further
manifestation defects found in the audit are in scope for Phase 1:

- `actorFrom` (`src/usecases/panelAccess.js:14-17`) returns `{ accountId }`
  only, so `panel.js:119` (`actorName: actor.displayName`) and `signing.js:92`
  are always `null`. `src/ui-kit/edit.jsx:169` feeds that to `signerName` and
  the attestation at `edit.jsx:398` renders "I, **the signer**, have
  reviewed…". 11.50(a)(1) requires the printed name of the signer. The
  persisted record is unaffected because `approval.js` resolves identity through
  `lib/approval/runtime.js:31-37`. The attestation text carries no name.
- Raw Jira status ids can reach the screen: `ApprovalControls.tsx:132` falls
  back to `toStatusId`, and `ApprovalField.tsx:209` renders
  `${o.name ?? o.toStatusId}` with an `Option` type (`:40`) that does not
  declare `toStatusName` even though the backend sends it.

**11.10(e). Audit trail.** The route that reached a gated status, whether a
direct global transition or a linear walk, is recorded with actor, time, edge,
and method (Phase 2).

**11.10(k)(2). Change control over configuration.** `va_workflow_snapshot`
(§4.2) retains a dated record of the workflow as Jira served it. Jira's own
workflow history expires after 60 days; this converts a procedural assertion
the customer must defend at audit into a detective control the app supplies.

---

## 4. Phase 1. Enforce configured transitions

Phase 1 enforces configured transitions and can be verified independently. It
requires no graph traversal or new decision module.

### 4.1 `src/lib/gateDrift.js`, edge classification (pure)

Add `classifyEdges({ workflow, appId, moduleKey })`, returning a Map keyed
`"<fromStatusId>><toStatusId>"` with `{ transitionId, transitionType,
validatorClass }` where `validatorClass` is one of:

- `OURS_ENABLED` means our validator is attached and not disabled.
- `OURS_DISABLED` means our validator is attached and `parameters.disabled` is true or `"true"`.
- `NATIVE` means at least one validator is present and none is ours.
- `NONE` means there are no validators.

Reuses the existing `isOurGate` and `isDisabled`, which already encode two
live-instance findings worth preserving: both expression- and function-based
Forge validators report under `forge:expression-validator`, and Jira sends
`disabled` as the string `"true"`. `GLOBAL` transitions are expanded against
every status in the workflow, mirroring `transitionCovers`. A global edge can
be taken from anywhere and therefore needs a gate wherever the row says. This
goes here rather than into `journey.js` because `gateDrift.js` already owns
validator identity; `journey.js` is about people and authority, not Jira wire
formats.

### 4.2 `src/lib/workflowSource.js`, cached read (I/O)

Lifts `fetchWorkflowForPair` out of `src/jobs/gatecheck.js` unchanged, so the
panel and the job share one implementation and one API constraint: **one
project/issue-type pair per call**, because the bulk response carries no mapping
back to the pair that produced each workflow (verified against a live instance
2026-08-31, where four issue types collapsed into one unattributed workflow).

`src/lib/cache.js` cannot serve this. Its `memo` is a module-scope `Map` that is
empty at the start of every invocation. Its documentation specifies
request-local caching. Cross-request freshness needs storage.

New migration `v031_workflow_snapshot`:

```sql
CREATE TABLE IF NOT EXISTS va_workflow_snapshot (
  project_id     BIGINT       NOT NULL,
  issue_type_id  VARCHAR(32)  NOT NULL,
  workflow_id    VARCHAR(191) NULL,
  workflow_name  VARCHAR(255) NULL,
  edge_map       TEXT         NOT NULL,
  content_hash   CHAR(64)     NOT NULL,
  fetched_at     BIGINT       NOT NULL,
  PRIMARY KEY (project_id, issue_type_id),
  KEY idx_workflow_snapshot_fetched (fetched_at)
)
```

Read path: one indexed primary-key read (the panel already performs several SQL
reads, so the marginal cost is negligible). If `fetched_at` is within the TTL,
use `edge_map`. If stale or absent, fetch from Jira, upsert, use the fresh
result. TTL is a project config value defaulting to **5 minutes**: a detached
validator disappears from every panel within five minutes, and the admin-scoped
POST leaves the common path entirely.

`content_hash` over the normalised edge map makes a configuration change
detectable without diffing TEXT, and is what gives the table its 11.10(k)(2)
value. `jobs/gatecheck.js` writes to the same table on its hourly run, so the
job warms the panel's cache rather than duplicating its work.

### 4.3 `src/lib/journey.js`, extended, not replaced

`resolveActions` keeps every existing parameter and the documented `enforced[]`
semantics unchanged. The change is additive, so existing callers and
`test/journey.test.js:149-173` continue to pass untouched. Added:

- `validatorClass[]` is a new optional parallel array. When supplied, `enforced[i]`
  is derived from it (`OURS_ENABLED` implies enforced; `OURS_DISABLED` and
  `NONE` imply not) and the function also distinguishes `NATIVE`. When absent,
  behaviour is exactly as today, including an explicitly passed `enforced[]`.
- A new blocker, `GATE_ORPHANED`, means our validator is present with no config row
  behind it. `GATE_NOT_ENFORCED` means a configured control has a detached
  validator. Each requires a different administrator action.
- `describeAction` gains `scope`: `'ANY_STATUS'` when `gate.matched_any_status`,
  otherwise `'EDGE'`. For the former, `label` is `"Sign to close this as
  Done"` with a `scopeNote` of `"Available from any status"`. For the latter,
  it is `"Sign to move to Selected for Development"`. The two parts
  stay separate fields so the client decides typography rather than parsing a
  sentence.
- `nativeValidator: boolean` on the action, so a surface can say Jira is also
  intercepting without suppressing our own control.

**The fail-open rule is preserved verbatim.** `enforced[i] === undefined` means
the workflow could not be read, and is treated as enforced. Failing closed on
an unreadable workflow would silently empty every reviewer's panel during a
Jira outage, indistinguishable from "nothing needs signing". The authority
decision lives in `gate.js`, which fails closed; this flag only decides whether
to *draw*.

**Warnings require a confirmed read.** The unenforced warning
fires only after the workflow has been read. An outage must never manufacture a compliance
warning accusing an administrator of detaching something.

Use the first matching blocker in the following order. A detached validator
requires administrator action before a reviewer role can help:

1. `GATE_NOT_ENFORCED` means the validator is detached or disabled on a configured edge.
2. `GATE_ORPHANED` means our validator is present with no config.
3. `WRONG_FIELD_FOR_RULE` is an existing blocker.
4. `NOT_ELIGIBLE_FOR_RULE` is an existing blocker.
5. No blocker applies.

### 4.4 `src/usecases/transitionInputs.js`, one assembly path (new)

To fix §1.1, add a single function that, given
`{ issue, projectId, issueTypeId, actor }`, returns the four parallel arrays
consumed by `resolveActions`, namely `offered`, `gates`, `eligible`, and
`validatorClass`. It first applies:

- self-transition filtering (`toStatusId === fromStatusId`)
- done-status-category suppression
- the edge classification from §4.1

`panel.js`, `queue.js` (`actionsForIssue`) and `signing.js` all call it.
Today `queue.js:96-112` applies neither filter and passes Jira's raw `offered`
straight through, so the worklist offers actions the panel refuses. After this
change all three callers use the same filters.

### 4.5 `src/lib/driftReport.js`, the invariant by derivation (new, pure)

"Drift is not there if baseline is not there" is currently enforced in one of
four reporting paths. A pure `reportedDrift(row)` returns zeroed counters
whenever the row carries no active baseline, and is called by:

- `panel.js` `getGlanceState` (`:173-175`)
- `queue.js` (`:42-43`)
- `resolvers/issueStatus.js` also has an ordering defect. It
  tests `drift_count > 0` at `:21` **before** the state checks, so a stale
  counter overrides `ARCHIVED`. `archive()` (`itemStateStore.js:313-318`) sets
  `ARCHIVED` without zeroing `drift_count`, which is how a row gets there.
- `panel.js` `getState`, which keeps its existing guard as an additional check on the shared rule.

### 4.6 Frontend

Render the labels, scope, names, and timestamps the backend already sends.

- In `ApprovalControls.tsx:111`, render the backend `label` + `scopeNote`. Delete
  the locally re-derived `transitionLabel`/`transitionTarget` (`:131-138`) so
  the sentence is maintained in one place. Remove the `toStatusId` fallback;
  there is no case where showing a human a numeric status id is correct.
- In `frontend/src/panel/types.ts`, add `scope`, `scopeNote`, `nativeValidator`.
- In `ApprovalField.tsx`, add `toStatusName` to `Option` (`:40`) and render it
  (`:209`).
- In `frontend/src/ui/feedback.tsx:26`, drop the `Number()` coercion that makes
  `formatTimestamp`'s ISO branch unreachable and renders every ISO string as
  "Time not recorded".
- New blocker notices for `GATE_NOT_ENFORCED` and `GATE_ORPHANED`, written for
  the reviewer and naming who to go to.
- Delete the component-level `events.emit('VA_ISSUE_CHANGED')` calls in
  `ApprovalControls.tsx:62` and `RestoreStatus.tsx:22`.
  `frontend/src/lib/bridge.ts:7-11` already emits unconditionally for all four
  resolver keys, so these are duplicates. The one at `:62` fires *after*
  `view.refresh()`, which reloads the host view and can tear the iframe down
  mid-call.
- `view.refresh()` moves to cover the transition-pending, transition-error and
  `catch` paths, not only the success branch. `retryTransition` (`:74`)
  currently gates on `result.transitioned`, leaving Jira stale until the 15s
  poll when a transition was applied but reported pending.

### 4.7 Also in scope

- In `src/usecases/panelAccess.js`, make `actorFrom` resolve `displayName`, fixing the
  nameless attestation (§3).
- In `src/lib/diff/index.js:254-267`, store direction-aware link labels. An
  inward link currently renders with the outward type name, so *"is blocked by
  VJIRA-8"* displays as *"Blocks: VJIRA-8"*. The signer sees the reversed
  relationship as a fact about the record.
- In `src/lib/alerts.js:146`, replace the stale string. *"Electronic signature required"* is
  not what the validator is called. `manifest.yml:44` names it **VAtlassian
  Approval**.
- In `src/usecases/signing.js:77`, import `BLOCKER` rather than comparing the
  string literal `'NOT_ELIGIBLE_FOR_RULE'`.

---

## 5. Phase 2. Route planning and the journey record

Designed here, planned separately.

**Route planning.** BFS from the current status over the edge map to the
nearest edge carrying `OURS_ENABLED` + config. Offer the first hop toward it.
Terminal statuses (`statusCategory: done`) end the walk. Equidistant
checkpoints are both shown rather than guessed between; ties among single hops
break deterministically on `toStatusName`. Cycles are legal in Jira workflows,
so the traversal must be visited-set guarded.

**Open question, deliberately deferred.** Whether the traversal lives in
`journey.js` or in its own pure module is decided at Phase 2 with real code in
hand. The Phase 1 decision to extend `journey.js` was correct because Phase 1
needs no graph at all. That argument does not automatically carry forward, and
pre-committing either way now would be guessing.

**Ungated moves.** A new `src/usecases/move.js` performs an ungated
transition, writes a ledger event, and creates no approval row. Role-gated to
the holder of the downstream checkpoint's role per §2.1.

**Journey record.** Each step and each global transition writes a hash-chained
ledger event through `src/lib/ledger.js` with actor, time, from, to, and method. When
a signature is finally collected, the approval row carries the route that
reached it, so the signed record is self-contained at export rather than
requiring a chain query. Needs migration `v032` adding a route column to
`va_approval`, and a corresponding field in `src/lib/exportRecord.js`.

---

## 6. Testing

Written test-first.

`classifyEdges` and `reportedDrift` are pure and get exhaustive table-driven
cases. The workflow fixtures: the linear five-status workflow from the
requirements discussion; one carrying a global `Any -> Done`; a detached
validator; a disabled validator sending `"true"` as a string; a native JSM
validator; an orphaned gate; a workflow with no matching edge at all.

Two existing tests are **not** adequate and are rewritten rather than extended:

- `test/panel-state.test.js:236-246` is tautological. It sets
  `activeBaseline: async () => null`, but `panelAccess.js:69-70` already
  returns `diff = null` in that case, so the assertion passes with the guard at
  `panel.js:110-111` deleted. The replacement asserts against a row carrying
  non-zero counters and no baseline, as occurs after
  `archive()`. It covers all four reporting views, including `getState`.
- `:248-262` asserts only the camelCase half of the history mapping. If both
  shapes are the contract, both are asserted. Note the two are not built from
  the same fallback chain: `approvedAt` falls back through `captured_at` while
  `transition_at` does not, so a row carrying only `captured_at` yields one and
  not the other.

New coverage required where there is currently none: `listStatusesForProject`
(zero tests, despite `'*'` being a live UI option at
`TransitionsPage.tsx:199`), the `'*'` branch of `listAvailableRoles` (only the
narrow branch is asserted, at `test/admin-configuration.test.js:33-40`), and
done-suppression plus self-transition filtering on the signing surface
(`test/signing-context.test.js` covers neither).

No glob or reference includes `test/smoke-settings.mjs`.
Add it to `npm run smoke` or delete it.

---

## 7. Out of scope

- Remediation. Reattaching a validator means writing to a customer's workflow
  and needs authorisation from a named administrator, not from a panel load.
  `jobs/gatecheck.js` already documents this boundary and it holds here.
- The 777 kB UI bundle. Noted because this design touches the panel's load
  path, but chunking is its own piece of work.
- Backend type checking and linting. `npm run verify` runs neither. `tsc -b`
  executes only inside `frontend/`. Decide on backend checks separately.
