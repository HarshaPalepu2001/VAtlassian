# Live Jira acceptance run — 2026-09-19

Driven against the real tenant, not a local double.

- **Site:** `one-atlas-mjkg.atlassian.net` (non-production), project **VJIRA**
- **App version:** 3.61.0, development environment, deployed from the working tree
  at the start of this run (42 modified files + the untracked `structure.js`,
  harness and diagnostics modules).
- **Pre-flight:** 938/938 backend tests, frontend tests, smoke and UI build all
  green via `npm run deploy`.
- **Signing:** performed by the account holder. TOTP entered by hand on the Jira
  transition screen and in the panel; the biometric ceremony completed with
  Touch ID.

Every "verified" below means Jira itself was read back through a separate REST
client (the Atlassian MCP connector), not that the app reported success.

## What passed

| # | Behaviour | Evidence |
|---|---|---|
| 1 | Jira refuses a controlled transition when the validator denies it | `Create Baseline → Selected for Development` attempted with no approval. Jira refused and rendered the app's own message ("This transition needs a reviewer to approve it first…"). Status re-read: still `In-Review`. **Closes live item 1.** |
| 2 | Signing from the Jira transition screen | The UI Kit `Electronic Signature` field rendered on the transition screen with declaration + authenticator-code input. |
| 3 | Baseline capture from the transition screen | Produced baseline **v3**, `Complete capture`, 16 tracked fields. **Closes live item 3.** |
| 4 | Signature and transition commit atomically | Changelog entry `244396` carries **both** `customfield_10761` (null → `f6c445…`) and `status` (In-Review → Selected for Development) in one entry. |
| 5 | Drift detection on tracked fields | Summary, Priority and Labels changed externally; panel raised drift and routed it for decision. |
| 6 | Reviewer diff quality | Per-field cards with was/now (`Critical id 10000 → Medium id 3`), severity (Critical/Major), attribution and timestamp. |
| 7 | Structural drift (`NODE_ADDED`) | A subtask added after approval was reported as `Added node · VJIRA-19`, separate from field changes. |
| 8 | Destructive consequence disclosed before signing | Confirmation step states **"Permanently delete: VJIRA-19"** and names the baseline being restored to. |
| 9 | Reject restores every tracked field | Read back from Jira: Summary `test 2`, Priority `Critical (10000)`, Labels `[]`, Subtasks `[]`. Status deliberately **not** reverted — content is restored, the signed transition is not undone. |
| 10 | `DELETE_ADDED_NODE` really deletes | JQL for `VJIRA-19` returns zero rows. |
| 11 | Restore verified by read-back, not by HTTP status | Panel: "Restored and verified — All tracked fields", under the stated rule that a field counts as restored only after Jira is re-read and matched. |
| 12 | Deleted work item recorded before deletion | Ledger seq 893, `Tree restore node destroyed`, payload carries `issueKey`, `contentHash`, logical/parent node ids and the **full field values** including its summary. |
| 13 | Ordered restore trail | `Approval recorded → Tree restore plan created → step claimed ×3 → node destroyed → Restore completed`, hash-chained. |
| 14 | `jira:issueContext` lozenge renders and updates | Right-hand details column; flipped green **Baselined** → amber **Changes need review** and back. **Closes live item 5.** |
| 15 | My approvals queue | Unions drifted issues and transitions awaiting signature (VJIRA-6 shown as "Sign to move to In Progress"). |
| 16 | Biometric assurance end-to-end | VJIRA-6 `Selected for Development → In Progress` signed with Touch ID; issue now `In Progress`; ledger shows `Approval recorded → Baseline captured → Signature consumed` for role Approver. |
| 17 | A refused device check records nothing | With the popup blocked, VJIRA-6 stayed `Selected for Development` with `updated` unchanged at 2026-09-10. |
| 18 | Legacy-baseline safety | VJIRA-6 disclosed "This baseline predates recorded role/method policy… drift on it cannot be decided until the incident is resolved." |

### Platform assumptions in `manifest.yml`, now confirmed

Read directly off the live Forge iframe:

```
sandbox: allow-downloads allow-forms allow-modals allow-pointer-lock
         allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox
allow:   camera; clipboard-write; display-capture; fullscreen; microphone; local-network-access
```

Both halves of the permissions-block rationale hold on a real Jira page:

1. `publickey-credentials-get` is **absent** from `allow` — Jira does not delegate
   it, so `navigator.credentials.get()` cannot run inside the app frame. The
   popup approach is necessary.
2. The `external.fetch.client` declaration **does** yield `allow-popups` and
   `allow-popups-to-escape-sandbox` on the sandbox attribute. The documented
   workaround works.

## Defects found

### D1 — Blocked attempts never attach to a work item, and the counter reads a name nothing emits

Two independent faults that both zero the same number.

- `gate.js:38` emits `eventType: 'TRANSITION_BLOCKED'`, but
  `LedgerPage.tsx:59` counts `counts['TRANSITION_DENIED']`. Both names exist as
  distinct constants (`ledger.js:202`, `ledger.js:285`); nothing emits
  `TRANSITION_DENIED`.
- `deny()` passes `issueId` only inside `payload`, while `append()` reads it from
  the top level (`ledger.js:59`: `issue_id: event.issueId ?? null`). So every
  `TRANSITION_BLOCKED` row is written with `issue_id = NULL` and cannot appear in
  a per-issue history.

Observed: a real gate denial produced **no** entry under "History for VJIRA-18",
and the strip read `0 blocked attempts`. The page's own lead text promises
"Every signature, decline, blocked attempt … Look up a work item to see its full
history in order."

Note the early denials (`MALFORMED_PAYLOAD`, `RAW_CODE_ON_SCREEN`) run before
`deps.load`, so `issueId` genuinely is not known there; the fix needs `deny()` to
pick up the id once the snapshot resolves rather than passing it unconditionally.

**Impact:** an auditor reviewing a work item cannot see that anyone was refused a
controlled transition on it. This is the one finding I would fix before a
compliance demo.

### D2 — Drift decisions are invisible to the per-issue evidence summary

`CHANGE_APPROVED` and `CHANGE_REJECTED` are defined (`ledger.js:249`) and read
(`evidence.js:67`, `LedgerPage.tsx:61`) but **never emitted**. A drift decision is
recorded as `APPROVAL_RECORDED`.

Observed on VJIRA-18 after a genuine signed reject-and-restore:
`4 signatures · 0 declines · 0 rejects · 0 blocked attempts`, and the SIGNATURE
LOG omits the 06:09 PM reject entirely, though the event itself is present in the
history as "Approval recorded — Reject changes and restore baseline v3".

The record is intact; the summary that an auditor reads first is not.

### D3 — `restoreId` serialised as a byte map into hash-chained payloads

Ledger payloads carry `"restoreId": { "0": 233, "1": 132, "2": 92, … }` — a
Buffer/`Uint8Array` JSON-stringified index-by-index instead of hex or base64. It
bloats every tree-restore entry, and since the payload is canonicalised into the
entry hash the noise is permanent.

### D4 — Panel labels a count of changed *nodes* as "changed fields"

`DriftSection.tsx:56` renders `evidence.drift.changedFields.length`, but
`buildTreeRejection` (`panelEvidence.js:55`) pushes one `FIELD_CHANGED` entry per
**node**, each carrying its own field list. With three fields changed on one
issue the panel reads:

> 3 changes since approval · **1 changed fields**

Two contradictory numbers, plus a hardcoded plural where the rest of the file
uses `plural()`. The expanded diff is correct — this is the collapsed header only.

### D5 — `OUTCOME.SELF_REVERTED` is unreachable

`interception.js:19` defines it and `collect.js:177-190` handles it (including
appending `DRIFT_SELF_REVERTED`), but no code path returns it. Reverting a value
by hand takes the `NO_CHANGE` branch at `interception.js:98`, whose comment is
explicit and, in my view, correct: *"Returning values by hand does not erase the
outstanding review decision."*

So the behaviour is right and the dead branch is the problem — it describes a
policy the system deliberately does not implement. Either delete it or document
why it is retained.

**Not a defect, but worth a look:** after a hand-revert the panel truthfully says
both "Matches the approved baseline" and "Control state: Changes since approval
need a decision". Both are accurate but they read as a contradiction. The item
remains actionable (the transition approval is still offered) and the gate keys
off `driftCount`, not state (`gate.js:58`), so nothing is stuck — but the wording
deserves a second pass.

### D6 — Context module title collides with its own lozenge

`jira:issueContext` title "Approval & Baseline" is too long for the details
column, rendering as `Approv…line s[Changes need review]`. The `label` field
("Baseline status") is what that row wants.

## Still not covered

These need setup this run did not do, and remain open from the matrix:

1. **Live item 2 / 4** — `overrideScreenSecurity` / `overrideEditableFlag`
   against `PUT /issue/{key}` and `GET /issue/{key}/editmeta`. The restore here
   covered three fields and one node and reported "All tracked fields" verified,
   but no field was deliberately removed from the edit screen, so the override
   path is still unproven.
2. **Live item 4** — a rejection over a genuinely large tracked set.
3. **Live item 6** — capture/drift timing inside Forge invocation budgets under a
   100-field configuration.
4. **Reviewer notification** — unchanged; still the known gap, nothing reads
   `notifications.digest` or `restore.commentOnRestore`.

## Environment note

The biometric ceremony cannot be completed in an embedded browser pane: the pane
blocks the ceremony popup. The app handles this correctly — it detects the null
window, says "The device confirmation window was blocked. Allow pop-ups for this
Jira site and try again.", and records nothing. The app-side ordering is right:
`openCeremonyWindow()` runs at `deviceAuth.ts:165`, synchronously on the click
and **before** the `await` on line 168, so user activation is preserved. Use a
normal browser for this path.

## Test data left behind

- **VJIRA-18** — restored to its approved content (`test 2`, Critical, no labels,
  no subtasks); baseline v3 intact; drift cleared. One outstanding review
  decision remains on record by design (see D5).
- **VJIRA-19** — created and permanently deleted by this run, as intended.
- **VJIRA-6** — advanced to `In Progress` by a genuine biometric approval, with a
  new captured baseline.
