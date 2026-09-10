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
`frontend/src/panel/sections/ApprovalControls.tsx:111` renders `t.name` —
Jira's raw transition name — and re-derives its own button text at `:131-138`.
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

`journey.js` opens by naming this exact pathology: *"One question, asked by four
surfaces… the differences were bugs rather than variations."* That module fixed
the **decision**. The surfaces still diverge on what they feed it. This design
closes the remaining half by giving every surface one shared way to assemble
the inputs.

---

## 2. The model

Jira's workflow is the source of truth for what is **possible**. VAtlassian
configuration is the source of truth for what is **controlled**. A button
appears only where the two overlap, and it states which edge it means.

For each transition Jira offers from the issue's current status:

| Validator on the edge in Jira | Our config | Outcome |
|---|---|---|
| VAtlassian Approval, enabled | present | **Checkpoint.** Full ceremony: role check, assurance, baseline, drift. Panel **and** My Approvals. |
| VAtlassian Approval, enabled | absent | **Orphaned.** Explain the dead end. No button — `gate.js` would deny `NOT_CONFIGURED`. |
| VAtlassian Approval, detached or disabled | present | **Unenforced.** Warning, no button. Never a plain move. |
| Native Jira validator (JSM approval, built-in) | any | **Jira is intercepting.** Surfaced as context. We never claim to satisfy another vendor's validator. |
| None | absent | **Connective tissue.** Plain move, ledger entry, no signature. Panel **only** (Phase 2). |
| — Jira offers no transition at all — | any | **Clean slate.** Nothing. Our configuration alone must never draw a button. |

Two distinct things exist at once and must not be conflated:

- **Express lane** — an administrator-configured `Any -> X` edge carrying our
  validator. Fully gated, role-checked, signed, and labelled with its scope.
  Appears on both surfaces.
- **Connective tissue** — ungated transitions between checkpoints. A plain move
  with a ledger entry and no signature. Panel only, because it is not an
  approval.

From `Open`, a reviewer may see *"Move to In Review"* (walking toward a
downstream checkpoint) and *"Sign to close this as Done · available from any
status"* (the express lane) side by side, distinguished by weight and label.

### 2.1 Visibility

Everyone sees the map: where the next checkpoint is and which role it waits on.
Only the holder of that role gets clickable controls. This applies to the
connective-tissue moves as well as to the checkpoints — the walk-forward path
exists to get the approver to their checkpoint. Anyone else advances the item
through Jira's own UI.

---

## 3. Compliance basis

**11.10(f) — permitted sequencing.** The clause requires the system to enforce
the sequence the organisation *permits*, not linearity. An administrator who
configures a global `Any -> Done` transition and attaches VAtlassian Approval
to it has defined a permitted sequence. Honouring it is a shortcut, not a
bypass: the signature is still collected, the role still checked, drift rules
still applied. The inverse — a configured edge whose validator is detached — is
an *unenforced* control, and is the case this design refuses to draw a button
for.

**11.50 — signature manifestation.** The signer must see the scope of what they
sign at the moment of signing. `anyStatus` must reach the screen. Two further
manifestation defects found in the audit are in scope for Phase 1:

- `actorFrom` (`src/usecases/panelAccess.js:14-17`) returns `{ accountId }`
  only, so `panel.js:119` (`actorName: actor.displayName`) and `signing.js:92`
  are always `null`. `src/ui-kit/edit.jsx:169` feeds that to `signerName` and
  the attestation at `edit.jsx:398` renders "I, **the signer**, have
  reviewed…". 11.50(a)(1) requires the printed name of the signer. The
  persisted record is unaffected — `approval.js` resolves identity through
  `lib/approval/runtime.js:31-37` — but the text the human agrees to carries no
  name.
- Raw Jira status ids can reach the screen: `ApprovalControls.tsx:132` falls
  back to `toStatusId`, and `ApprovalField.tsx:209` renders
  `${o.name ?? o.toStatusId}` with an `Option` type (`:40`) that does not
  declare `toStatusName` even though the backend sends it.

**11.10(e) — audit trail.** The route that reached a gated status, whether a
direct express-lane jump or a linear walk, is recorded with actor, time, edge,
and method (Phase 2).

**11.10(k)(2) — change control over configuration.** `va_workflow_snapshot`
(§4.2) retains a dated record of the workflow as Jira served it. Jira's own
workflow history expires after 60 days; this converts a procedural assertion
the customer must defend at audit into a detective control the app supplies.

---

## 4. Phase 1 — enforcement and honesty

Ships the compliance-critical half on its own, independently verifiable. No
graph traversal, no new decision module.

### 4.1 `src/lib/gateDrift.js` — edge classification (pure)

Add `classifyEdges({ workflow, appId, moduleKey })`, returning a Map keyed
`"<fromStatusId>><toStatusId>"` with `{ transitionId, transitionType,
validatorClass }` where `validatorClass` is one of:

- `OURS_ENABLED` — our validator attached and not disabled
- `OURS_DISABLED` — attached, `parameters.disabled` true or `"true"`
- `NATIVE` — at least one validator present, none of them ours
- `NONE` — no validators

Reuses the existing `isOurGate` and `isDisabled`, which already encode two
live-instance findings worth preserving: both expression- and function-based
Forge validators report under `forge:expression-validator`, and Jira sends
`disabled` as the string `"true"`. `GLOBAL` transitions are expanded against
every status in the workflow, mirroring `transitionCovers` — a global edge can
be taken from anywhere and therefore needs a gate wherever the row says. This
goes here rather than into `journey.js` because `gateDrift.js` already owns
validator identity; `journey.js` is about people and authority, not Jira wire
formats.

### 4.2 `src/lib/workflowSource.js` — cached read (I/O)

Lifts `fetchWorkflowForPair` out of `src/jobs/gatecheck.js` unchanged, so the
panel and the job share one implementation and one hard-won lesson: **one
project/issue-type pair per call**, because the bulk response carries no mapping
back to the pair that produced each workflow (verified against a live instance
2026-08-31, where four issue types collapsed into one unattributed workflow).

`src/lib/cache.js` cannot serve this. Its `memo` is a module-scope `Map` that is
empty at the start of every invocation — per-request only, by design and by its
own documentation. Cross-request freshness needs storage.

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

### 4.3 `src/lib/journey.js` — extended, not replaced

`resolveActions` keeps every existing parameter and the documented `enforced[]`
semantics unchanged. The change is additive, so existing callers and
`test/journey.test.js:149-173` continue to pass untouched. Added:

- `validatorClass[]` — a new optional parallel array. When supplied, `enforced[i]`
  is derived from it (`OURS_ENABLED` implies enforced; `OURS_DISABLED` and
  `NONE` imply not) and `NATIVE` is additionally distinguished. When absent,
  behaviour is exactly as today, including an explicitly passed `enforced[]`.
- A new blocker, `GATE_ORPHANED` — our validator present, no config row behind
  it. Distinct from `GATE_NOT_ENFORCED`, because the admin conversation is the
  opposite: one detached a control, the other configured one with nothing
  behind it.
- `describeAction` gains `scope`: `'ANY_STATUS'` when `gate.matched_any_status`,
  otherwise `'EDGE'`. `label` becomes scope-aware — `"Sign to close this as
  Done"` with a `scopeNote` of `"Available from any status"` for the former,
  `"Sign to move to Selected for Development"` for the latter. The two parts
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

**The corollary is new and equally load-bearing:** the unenforced *warning*
fires only on a confirmed read. An outage must never manufacture a compliance
warning accusing an administrator of detaching something.

Blocker precedence — first cause wins, because telling someone they lack a role
when the real problem is a detached validator sends them to the wrong person:

1. `GATE_NOT_ENFORCED` — detached or disabled on a configured edge
2. `GATE_ORPHANED` — our validator, no config
3. `WRONG_FIELD_FOR_RULE` — existing
4. `NOT_ELIGIBLE_FOR_RULE` — existing
5. clean

### 4.4 `src/usecases/transitionInputs.js` — one assembly path (new)

The root-cause fix for §1.1. A single function that, given
`{ issue, projectId, issueTypeId, actor }`, returns the four parallel arrays
`resolveActions` consumes — `offered`, `gates`, `eligible`, `validatorClass` —
having already applied:

- self-transition filtering (`toStatusId === fromStatusId`)
- done-status-category suppression
- the edge classification from §4.1

`panel.js`, `queue.js` (`actionsForIssue`) and `signing.js` all call it.
Today `queue.js:96-112` applies neither filter and passes Jira's raw `offered`
straight through, so the worklist offers actions the panel refuses. After this
change the divergence is structurally impossible rather than merely fixed.

### 4.5 `src/lib/driftReport.js` — the invariant by derivation (new, pure)

"Drift is not there if baseline is not there" is currently enforced in one of
four reporting paths. A pure `reportedDrift(row)` returns zeroed counters
whenever the row carries no active baseline, and is called by:

- `panel.js` `getGlanceState` (`:173-175`)
- `queue.js` (`:42-43`)
- `resolvers/issueStatus.js` — which additionally has an ordering defect: it
  tests `drift_count > 0` at `:21` **before** the state checks, so a stale
  counter overrides `ARCHIVED`. `archive()` (`itemStateStore.js:313-318`) sets
  `ARCHIVED` without zeroing `drift_count`, which is how a row gets there.
- `panel.js` `getState`, which keeps its existing guard; it becomes belt and
  braces over one shared rule rather than the only place the rule exists.

### 4.6 Frontend

Mostly *stop discarding data the backend already sends*.

- `ApprovalControls.tsx:111` — render the backend `label` + `scopeNote`. Delete
  the locally re-derived `transitionLabel`/`transitionTarget` (`:131-138`) so
  the sentence is maintained in one place. Remove the `toStatusId` fallback;
  there is no case where showing a human a numeric status id is correct.
- `frontend/src/panel/types.ts` — add `scope`, `scopeNote`, `nativeValidator`.
- `ApprovalField.tsx` — add `toStatusName` to `Option` (`:40`) and render it
  (`:209`).
- `frontend/src/ui/feedback.tsx:26` — drop the `Number()` coercion that makes
  `formatTimestamp`'s ISO branch unreachable and renders every ISO string as
  "Time not recorded".
- New blocker notices for `GATE_NOT_ENFORCED` and `GATE_ORPHANED`, written for
  the reviewer and naming who to go to.
- Delete the component-level `events.emit('VA_ISSUE_CHANGED')` calls in
  `ApprovalControls.tsx:62` and `RestoreStatus.tsx:22`.
  `frontend/src/lib/bridge.ts:7-11` already emits unconditionally for all four
  resolver keys, so these are duplicates — and the one at `:62` fires *after*
  `view.refresh()`, which reloads the host view and can tear the iframe down
  mid-call.
- `view.refresh()` moves to cover the transition-pending, transition-error and
  `catch` paths, not only the success branch. `retryTransition` (`:74`)
  currently gates on `result.transitioned`, leaving Jira stale until the 15s
  poll when a transition was applied but reported pending.

### 4.7 Also in scope

- `src/usecases/panelAccess.js` — `actorFrom` resolves `displayName`, fixing the
  nameless attestation (§3).
- `src/lib/diff/index.js:254-267` — store direction-aware link labels. An
  inward link currently renders with the outward type name, so *"is blocked by
  VJIRA-8"* displays as *"Blocks: VJIRA-8"* — the reversed relationship, shown
  to a signer as a fact about the record.
- `src/lib/alerts.js:146` — stale string: *"Electronic signature required"* is
  not what the validator is called. `manifest.yml:44` names it **VAtlassian
  Approval**.
- `src/usecases/signing.js:77` — import `BLOCKER` rather than comparing the
  string literal `'NOT_ELIGIBLE_FOR_RULE'`.

---

## 5. Phase 2 — the walk and the journey record

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

**Connective-tissue moves.** A new `src/usecases/move.js` performs an ungated
transition, writes a ledger event, and creates no approval row. Role-gated to
the holder of the downstream checkpoint's role per §2.1.

**Journey record.** Each step and each express jump writes a hash-chained
ledger event through `src/lib/ledger.js` — actor, time, from, to, method. When
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
  non-zero counters and no baseline — the state that actually occurs after
  `archive()` — and covers all four reporting surfaces, not just `getState`.
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

`test/smoke-settings.mjs` is dead — matched by no glob and referenced nowhere.
Either wire it into `npm run smoke` or delete it; a check that has never
executed is worse than no check.

---

## 7. Out of scope

- Remediation. Reattaching a validator means writing to a customer's workflow
  and needs authorisation from a named administrator, not from a panel load.
  `jobs/gatecheck.js` already documents this boundary and it holds here.
- The 777 kB UI bundle. Noted because this design touches the panel's load
  path, but chunking is its own piece of work.
- Backend type checking and linting. `npm run verify` runs neither — `tsc -b`
  executes only inside `frontend/`. Real gap, separate decision.
