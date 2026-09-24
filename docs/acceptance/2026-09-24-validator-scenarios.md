# Validator scenario run — 2026-09-24

The `va-gate` validator is now the whole Jira-side setup. It is attached to every
transition, holds a baselined work item whose tracked content has drifted until
someone approves or rejects the change, and asks for a signature only on
transitions VAtlassian controls. This run checks that behaviour against changes
made in the app and in Jira.

- **How:** `test/validator-scenarios.test.js` (137 scenarios) runs the **real**
  validator runtime (`gateRuntime` + `gate.js`) and the **real** panel summary
  (`getSummary`) against a simulated Jira site and database
  (`test/helpers/validator-world.js`). Only Jira REST, SQL and the ledger are
  simulated. `test/drift-functional.test.js` adds 5 scenarios that run the real
  approve/reject decision code.
- **Invariants checked:** (1) drift holds every transition, whatever has
  happened to the controlled transitions since; (2) whatever the validator
  holds, the panel can decide; (3) the signature half is unchanged; (4) a
  disabled project holds nothing for drift.
- **Result:** 1340 backend tests pass, 0 fail, no open decisions. 187 UI tests,
  smoke test and UI build all pass (`npm run verify`).

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
| Fields added later, moves | S113–S114 | a field tracked after v1 |
| Sibling transitions (C) | S115–S125 | the saved transition id, stale or copied ids, Health check |
| Child baselines (D) | S126–S137 | a parent capture gives each child its own baseline over its own fields; a child edit holds the child only and is decided on its panel; the parent is not held but its panel offers the covering decision; approve or reject from either side; independent versions (child v5, parent v1); a child type with no tracked fields; grandchildren; linked issues |

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

## Decisions

| # | Behaviour today | Scenario |
|---|---|---|
| A | **Decided: keep.** A field's kind is part of its drift fingerprint, so reclassifying a tracked field shows as drift on every baselined item in scope. The signer approved a value, and a type change can alter what the field holds, so it is decided like any other drift. | S30 |
| B | **Decided: follow the destination.** A baselined item moved to another project or issue type is judged by the destination's tracked fields, as a codebeamer item follows its new tracker. The move is recorded once in the audit trail (`BASELINE_SCOPE_CHANGED`, `lib/scopeMove.js`). | S56, S57 |
| C | **Fixed.** The validator's setup screen now saves the transition's id into its configuration, and the validator uses it to tell sibling transitions apart. The Health page flags a saved id that doesn't match its transition (critical), and a missing one where siblings make it matter (warning). | S115–S125 |
| D | **Built.** When a parent is baselined, every child (through `parent`, recursively) gets its own baseline over its own project and issue type's fields, signed by the parent's approval (`captured_by_baseline_id`). A child's drift holds and is decided in the child; the parent is held only by its own fields. The parent's review groups changes by issue, each child against its own latest baseline, and one parent decision re-baselines or restores every child to its own latest baseline. Existing trees get child baselines at their next capture. (`docs/specs/2026-09-24-child-baselines-design.md`) | S126–S137, plus `child-baseline-capture`, `child-baseline-decisions`, `tree-node-fields`, `tree-drift-functional` and `panel-state` tests |

## Cost per transition

1–2 Jira reads (issue, plus the transition list when Jira sends no id), or
up to 4 without user consent, plus about six indexed SQL reads. The approval
content hash, which reads the whole tree for tree baselines, is only computed
on a signature check. Child baselines add nothing here: a child's hold reads
its own single-issue baseline, like any item. The panel summary adds one
indexed read for a tree parent (children waiting) or a parent-captured child
(which capture it came with).
