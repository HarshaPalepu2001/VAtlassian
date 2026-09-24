# Validator scenario run — 2026-09-24

The `va-gate` validator is now the whole Jira-side setup. It is attached to every
transition, holds a baselined work item whose tracked content has drifted until
someone approves or rejects the change, and asks for a signature only on
transitions VAtlassian controls. This run checks that behaviour against changes
made in the app and in Jira.

- **How:** `test/validator-scenarios.test.js` (112 scenarios) runs the **real**
  validator runtime (`gateRuntime` + `gate.js`) and the **real** panel summary
  (`getSummary`) against a simulated Jira site and database
  (`test/helpers/validator-world.js`). Only Jira REST, SQL and the ledger are
  simulated. `test/drift-functional.test.js` adds 5 scenarios that run the real
  approve/reject decision code.
- **Invariants checked:** (1) drift holds every transition, whatever has
  happened to the controlled transitions since; (2) whatever the validator
  holds, the panel can decide; (3) the signature half is unchanged; (4) a
  disabled project holds nothing for drift.
- **Result:** 1256 backend tests pass, 0 fail, 3 open decisions (marked `todo`).
  183 UI tests, smoke test and UI build all pass.

## Coverage

| Area | Scenarios | What changes |
|---|---|---|
| Drift hold basics | S01–S17 | edits, reverts, rich text, multi-value order, materiality, approve, reject, partial restore, audit |
| VAtlassian-side changes | S18–S46 | controlled transition deleted, retired, re-added or its role changed; wildcards; tracked fields added or removed; project disabled or re-enabled; eligibility revoked; restore states; database faults |
| Jira-side changes | S47–S65 | no transition id in the payload, sibling transitions, unreadable transition list or issue, concurrent status change, project or type move, field deleted, transition screen edits, new or replaced workflow, id formats |
| Signature half | S66–S78 | missing, valid, spent, expired or changed-content signature; signing for a sibling; eligibility or policy changed; token on the screen; voiding; raw code; drift beats signature |
| Tree baselines | S79–S82 | root untouched or edited, unreadable root digests, approval |
| Random sequences | S83–S94 | 12 seeded runs of 25 mixed operations, checking that the validator and the panel agree after every step |
| Health check | S95–S100 | validator removed or disabled, controlled vs uncontrolled, creation, all rules deleted |
| Restore in ERROR | S101–S104 | failed restore with clean content or with drift, controlled edge, restore genuinely running |
| No app consent | S105–S112 | user never opened VAtlassian, automation, hidden controlled transition |

The scenario asked for (baseline captured, then its controlled transition
deleted) is S18–S21 plus the decision scenarios in `drift-functional.test.js`.
Drift still holds every transition, including the one the item was signed on.
Approve and reject both still work, because their policy comes from the
baseline itself. After an approval the item moves freely, and the old edge asks
for no signature.

## Bugs found and fixed

| # | Bug | Found by | Fix |
|---|---|---|---|
| 1 | A 6-digit value (a postcode, a count) typed on **any** transition screen was refused as a raw authenticator code, which matters now that the validator is on every transition | S60 | `gate.js`: the raw-code check runs only where a signature is being checked |
| 2 | An item left in `ERROR` by a failed restore was refused on **every** transition with "restoring… wait", and nothing clears `ERROR` while the content is clean, so it stayed frozen permanently | S101–S102 | `gate.js`: `ERROR` refuses controlled transitions only; drift still holds the rest |
| 3 | When every controlled transition for a project/issue type is deleted, the Health check stopped watching that workflow, although its baselined items still depend on the validator | S100 | `gatecheck.js` checks every pair that has rows **or** active baselines; `diffWorkflow` takes a `scope` |
| 4 | A user who never opened VAtlassian (and automation) was refused on every transition: the validator read the issue as that user, and Forge cannot act as a user without consent | S105–S108 | `runtime.js`: read as the user, and fall back to the app only on "could not act as this user" (throw, 401 or 403) |
| 5 | Reading the transition list as the app could miss a controlled transition hidden from the app by a workflow condition, and let the user take it unsigned | review of fix 4, S111 | `runtime.js`: `hidesControlledTransition` guard on the fallback path |

Earlier the same day: a disabled project refused drift decisions on the panel
while the validator held the drift, so items froze. The validator no longer
holds drift in a disabled project.

## Open decisions

| # | Behaviour today | Scenario |
|---|---|---|
| A | A field's kind is part of its drift fingerprint. **Reclassifying a tracked field** in admin (for example SCALAR to TEXT) makes every baselined item in that scope show as drifted and held. It can be decided, but it creates noise. | S30 |
| B | Drift is judged with the **current** project/issue type's tracked fields. **Moving a baselined item** to a project or type with no tracking stops its hold. The validator and the panel agree (S110), so nothing deadlocks, but the move drops governance. | S56, S57 |
| C | Known limitation, not a bug: Jira's validator payload has no transition id. When two transitions go from the same status to the same status and one is controlled, a move without a signature on the screen is refused on both (fail closed). | S50 |
| D | Known gap: changes only to **child** issues of a tree baseline are recorded, but the panel offers no decision for them, so the validator does not hold on them. | — |

## Cost per transition

1–2 Jira reads (issue, plus the transition list when Jira sends no id), or
up to 4 without user consent, plus about six indexed SQL reads. The approval
content hash, which reads the whole tree for tree baselines, is only computed
on a signature check.
