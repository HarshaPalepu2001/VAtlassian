# Live baseline, drift, approval, and reject plan — 2026-10-08

## Purpose and evidence boundary

This is the focused live Jira suite for the updated diff view and the new
whole-set / per-field approval and reject paths. It uses one fresh tree in the
VAT project and one signed-in reviewer; it does not claim multi-user or
multi-project coverage. Every case combines at least two risk dimensions so a
green result means more than one happy-path field changed.

The browser is the verified live tenant: `mgtechdemo.atlassian.net`, project
`VAT` / `VAtlassian`. The Atlassian connector currently resolves to another
tenant, so connector results are not evidence for this run. Every pass needs
all of these independent reads:

1. Fresh Jira read-back for fields, parent, links, subtasks, and issue history.
2. A panel or diff-view screenshot showing the baseline version, drift state,
   changed fields, decision result, and transition gate.
3. Forge logs for the live drift/decision/restore result where available.

Versions are recorded from the panel after each step as `vN`; never infer the
next version from the previous one. Existing VAT-42 through VAT-55 are not
used as fixtures.

## Fresh fixture

Create only after the user confirms the exact creation step in the browser.
Use a timestamped prefix such as `LIVE-DR-20261008` and record actual keys as
soon as Jira returns them.

| Alias | Jira type | Relationship | Required content |
|---|---|---|---|
| E | Epic | tree root | non-empty rich ADF description, priority, labels, components, due date, assignee if available, fix/affects versions if available; **no attachment at baseline** |
| C1 | Story or Task | child of E | different rich ADF description, labels, due date, and one deterministic baseline attachment |
| C2 | Story or Task | second child of E | different rich ADF description, priority, labels, and no attachment |
| S1 | Sub-task | child of C1 | summary, **description never set at baseline**, label, no attachment |
| L1 | Task | standalone, linked to E | summary and rich ADF description |
| L2 | Task | standalone; linked to C1 in T12 | summary and rich ADF description |

At pre-flight, read Admin → Controlled fields / Transitions and copy the
actual declared field IDs and names into the results document. The fixture
must explicitly exercise `issuelinks`, `parent`, and `subtasks` if they are
declared. Do not silently substitute a guessed field list. For each issue,
record which declared fields are populated, null, editable, retained, and
restorable.

## Oracles that make this run special

- Use deterministic synthetic files only. Record SHA-256, filename, byte
  length, Jira attachment id, baseline version, and (if vaulted) the vault
  record for the C1 baseline attachment. Use a different hash and filename
  for every attachment added after baseline.
- Put stable markers in the rich descriptions: a heading, two paragraphs, a
  bullet list, a hard-break, and a small table. Record the exact ADF before
  baseline and after every restore; matching plain-text rendering is not
  enough.
- S1 must have no description before baseline. After a later description is
  added and rejected, verify both the raw Jira response and the normalized
  comparison: Jira may return `{type:"doc", version:1, content:[]}` instead
  of `null`, and that must settle as no content rather than leave drift.
- Do not count `ATTACHMENT_VAULT_*` telemetry, an upload/copy event, or a
  baseline row alone as attachment restoration. Restoration passes only after
  a fresh Jira attachment read and content-hash comparison prove the exact
  target set.

## Run contract

- Baseline E only after E, C1, C2, and S1 are fully assembled and their links
  are read back.
- The user performs every VAtlassian signature. I will say the issue key and
  action; I will never enter TOTP, Touch ID, or WebAuthn material.
- A field-only change may use the new mixed diff workflow. A tree structure
  change must use whole-set Approve or Reject and must visibly explain why
  field-by-field save is unavailable.
- For every attachment decision, record the before/after set by id, filename,
  size, and SHA-256. For every description decision, record ADF markers, not
  only rendered text.
- Before each decision, capture the current version and exact changed-field
  list. After each decision, reread every affected Jira field and the panel.
- Stop at the first mismatch, stale read, partial restore, unexpected version
  change, or disagreement between the panel and `drift:live` logs. Preserve
  the evidence and report the finding before continuing.

## Seventeen live scenarios

| ID | Scenario and action | Expected result | Evidence to record |
|---|---|---|---|
| T01 | Assemble E/C1/C2/S1 plus L1/L2; link E–L1 and leave L2 unlinked for T12; populate rich ADF on E/C1/C2/L1/L2, leave S1 description and E attachment empty, and upload the C1 baseline attachment. | Jira preserves the exact tree, link, ADF markers, null/empty distinctions, and attachment bytes before any approval. | Fresh reads of all six issues; parent/link/subtask reads from both sides; ADF JSON and file hashes; Admin field configuration. |
| T02 | Baseline the complete tree from E with the normal approval ceremony, then wait for and independently verify attachment vaulting before proceeding. | One signature publishes E and child baselines; C1's file is proven vaulted by hash; E/S1 have no attachment baseline; all nodes are in sync. | User signs E; panel screenshots for E/C1/C2/S1; baseline/version table; vault row plus fresh Jira attachment read; capture/vault/ledger logs. |
| T03 | Edit E's rich description by changing paragraph text, list content, hard-break, and table cell; also change priority and labels; open View changes without deciding. | Diff shows structured ADF change details plus scalar changes, exact field count, materiality, and attribution; no collapse to plain text or false empty-document drift. | Before/after ADF; diff screenshot; Jira read-back; `drift:live`; held transition read-back. |
| T04 | On T03, use whole-set Approve. | One signature creates exactly E vN+1 from the current rich ADF and scalar values; no restore write; the new baseline re-reads the same ADF markers and drift clears. | User signs E; Jira history; exact ADF/hash comparison; panel version/tracked-field count; ledger and logs. |
| T05 | Restore rich content across the tree: change E's description to a different structured document, clear C1's rich-text description that was populated at baseline, and change E due date; use whole-set Reject at E. | Both original ADF structures and the scalar value return exactly; no new version; restore verification is clean; no empty-block artifact or “Partly restored” residue remains on E or C1. | User signs E reject; raw E/C1 ADF read-back and canonical hashes; due-date read-back; restore-worker outcome; E/C1 panel receipts and logs. |
| T06 | S1 has description `null` at baseline. Add a non-empty rich description, then reject S1's drift through the child panel. | Jira may leave an empty ADF document after the restore, but the live comparison treats it as no content; S1 has zero drift, no phantom critical structure change, no new version, and its parent settles correctly. | S1 raw description before/add/after; normalized digest evidence; child/root screenshots; restore status; `drift:live`; transition gate. |
| T07 | E has no attachment at baseline. Add a deterministic new attachment, change E labels, and reject the whole set. | The added file is deleted, no vault record is incorrectly required for it, labels return to baseline, no new version is created, and a fresh Jira read proves the attachment set is empty. | Pre/post attachment IDs, names, sizes, hashes; Jira attachment read after restore; restore plan’s `willDelete`; panel receipt; logs. |
| T08 | C1's baseline attachment is removed; its rich description is changed; reject at C1. | The exact baseline file is re-uploaded from the vault with matching bytes/hash and no duplicate; the original rich ADF returns; C1 remains at vN and the parent/child state settles. | Vault proof before decision; Jira attachment content hash after restore; ADF read-back; attachment restore/ledger events; C1/E screenshots. |
| T09 | Create a mixed drift on E: edit rich description, add an attachment, change priority, and remove one tracked label; choose description APPROVE, attachment REJECT, priority REJECT, label APPROVE. | Save is disabled until complete coverage; one authentication restores only the rejected scalar/file values, deletes the added file, preserves approved current ADF/label, and publishes exactly one mixed baseline version. | Diff decision counts and field identities; user signs once; all four Jira reads plus file hash; mixed map/hash, restore plan, receipt, ledger, and vN+1. |
| T10 | Repeat mixed review with every changed item approved: change C2's rich ADF, add an attachment, and change priority. | Mixed path behaves like whole-set approval: no restore, one version, exact current ADF and file remain, vaulting of the new baseline is independently confirmed, and drift is zero. | Decision summary; one signature; Jira ADF/file reads; new vault hash; no restore action; panel and logs. |
| T11 | Repeat mixed review with every changed item rejected: change C2's rich ADF, add an attachment, and change priority. | Mixed path behaves like whole-set reject: added file is removed, rich ADF and priority return to baseline, no new version is created, and no stale restore/empty-block state remains. | Decision summary; one signature; fresh Jira ADF/file/scalar reads; unchanged version/history; restore verification and panel. |
| T12 | Remove E–L1, add C1–L2, and change C1's rich description before opening the diff; reject at E. | Diff separates both link directions/types and the child ADF change; one parent restore recreates/removes the right links exactly once and restores C1's description without overwriting unrelated baselines. | Link reads from E/L1/C1/L2; ADF read-back; diff screenshot; restore plan/actions; link-worker and panel logs. |
| T13 | Add a new subtask under C2 after baseline with rich ADF description and a deterministic attachment; open View changes, then use whole-set Approve. | Diff shows `NODE_ADDED`; mixed field save is unavailable; whole-set approval captures the new node with its own rich-text and attachment baseline, proves the file vault copy, and clears tree drift without changing unrelated nodes. | New key; E/C2 screenshots; user signs whole-set approval; child baseline provenance; ADF/file hash and vault proof; logs. |
| T14 | Start a mixed challenge on E covering a rich description and attachment decision; before signing, change the description ADF and replace the file in Jira. | Submit fails closed as stale/changed evidence; no approval, restore, new version, or partial file operation is published; the reloaded diff names the fresh ADF/file state. | Two-tab timestamps; failed receipt/error; Jira history and attachment reads prove no governance write; panel/log evidence. |
| T15 | Exercise cancellation and replay protection using a mixed rich-text/attachment map, then verify the transition gate. Cancel authentication; retry and complete one decision; replay the consumed submit; attempt the controlled transition before and after settlement. | Cancellation records nothing and choices remain editable; one successful decision causes exactly one approval/version or restore; replay is refused/idempotent; transition is blocked while drift remains and succeeds only after fresh ADF/file verification. | User performs cancel/sign actions; challenge/approval counts; attachment and ADF read-back; ledger count/map; panel and transition evidence; logs. |
| T16 | Create attachment-free mixed drift on E: change Summary, Description, Priority, Labels, and Assignee; review each field independently, save per-field decisions, close/reopen the diff, then test native final decision controls. | Diff shows exactly five tracked changes; per-field decisions survive `Save changes` and diff close/reopen; native Approve/Reject either remains the single final action or is clearly separated without conflicting with the saved field map. | Decision counts/field identities; close/reopen state; final user signature if submitted; fresh Jira values and version/history; panel/transition evidence. |
| T17 | Create attachment-free mixed drift on E and C1: change five visible parent fields and three child fields, then open the child diff to decide the child independently. | The child diff exposes exactly its three fields for independent approve/reject decisions; the parent remains separately reviewable; no attachment is changed or restored. | Parent and child field lists/counts; child decision controls; baseline provenance; fresh Jira values; panel/diff evidence; no signature until the child behavior is confirmed. |

## Result table to fill during the run

| ID | Actual keys / version before | Decision | Version after | Jira / ADF / file read-back | Panel / diff | Logs | Result / finding |
|---|---|---|---|---|---|---|---|
| T01 | VAT-56..VAT-61; unbaselined | Fixture preparation only | — | Fresh Jira reads confirmed six issues, parent/subtask/link directions, S1 blank description, E/C1/C2/L1/L2 rendered rich content, and C1 filename/92 B/local SHA `2fa321e687072747b2e1e3924345da1338c130ef874d10acdde0476566b280e4`; raw ADF JSON and Jira attachment id were not captured. | E pre-approval panel: IN REVIEW, `Approve to To Do`, no baseline; L2 visibly unlinked. | Forge harness text was visible; Admin field configuration and vault/ledger logs were not independently read. | PARTIAL — fixture ready; rendered markers confirmed, with raw ADF/table-hardbreak/Admin/vault evidence gaps remaining. |
| T02 | VAT-56..VAT-61; no baseline | APPROVE at VAT-56; signed by Palepu Sai Sri Harsha | VAT-56 baseline v1; panel reports 18 tracked fields across 4 work items | VAT-56 is TO DO with the approval recorded; E/C1/C2/S1 content and fields were preserved; C1 attachment remains `LIVE-DR-20261008-C1-baseline.txt`, 92 B; S1 remains blank; local C1 SHA `2fa321e687072747b2e1e3924345da1338c130ef874d10acdde0476566b280e4`; no raw ADF/Jira attachment id/vault row/hash was read. | E, C1, C2, and S1 reads show baseline v1 and IN SYNC; C1 shows `Baselined with VAT-56 version 1`; child transitions remain held where expected. | Harness observations were visible; capture/vault/ledger logs were not independently retrieved. | PARTIAL PASS — baseline propagation and sync verified; vault proof and raw ADF evidence remain open. |
| T03 | VAT-56 baseline v1; root edited after approval | Diff review only; no final save/approval/rejection submitted | Unchanged; baseline remains v1 | Diff view showed the root description edit; Jira root visibly contains the revised description, priority `Medium`, and added label `t03-scalar-drift`. | Diff modal showed `3 changes · 3 edits`: Description (`1 paragraph added, 7 removed`), Priority (`High → Medium`), and Labels (`1 added`). Timeline movement was observed as buggy/not free-flowing. The tentative per-field decision was cleared; the final `Save changes` action was not submitted. | No backend diff/decision logs independently retrieved. | OBSERVATION — diff content and three-field detection visible; timeline slider interaction is a UX defect candidate. No decision committed. |
| T04 | VAT-56 baseline v1; 3 reviewed root changes | APPROVE changes at VAT-56; signed by Palepu Sai Sri Harsha | VAT-56 baseline v2; panel reports 18 tracked fields across 4 work items | VAT-56 latest approval recorded at 11:09 AM; revised description, `Medium` priority, and `t03-scalar-drift` label preserved. Fresh reads confirmed VAT-57/C1 description and attachment `LIVE-DR-20261008-C1-baseline.txt` at 92 B, VAT-58/C2 content, and VAT-59/S1 blank description. | VAT-56, VAT-57, VAT-58, and VAT-59 all show baseline v2 and `IN SYNC`; no restoration ran. | Harness observations were visible; capture/vault/ledger logs and raw ADF/hash comparisons were not independently retrieved. | PARTIAL PASS — approval, baseline v2 propagation, sync, and content read-back verified; vault/raw ADF evidence remains open. |
| T05 | VAT-56 baseline v2; VAT-57 baseline v2 | REJECT and restore at VAT-56; signed by Palepu Sai Sri Harsha | Unchanged; VAT-56 remains at baseline v2 | Fresh Jira reads show VAT-56 restored to the v2 root rich description and due date Oct 15, 2026. VAT-57 restored its rich description markers; `LIVE-DR-20261008-C1-baseline.txt` remains present at 92 B. | VAT-56 reports `Restored and verified`, `Back to version 2`, and `IN SYNC`; VAT-57 reports `Restored and verified through VAT-56's rejection`, baseline v2, and `IN SYNC`. No empty-block or `Partly restored` residue was visible. | Harness showed `restore:getState` at VAT-56 and `panel:getEvidence` at VAT-57; raw ADF/canonical hashes, restore-worker, vault, ledger, and backend logs were not independently retrieved. | PASS WITH FINDING — whole-set rejection restored both rich descriptions and the scalar due date, preserved the attachment, created no new version, and cleared drift. The due-date mutation was restored but was not listed in the pre-decision diff. |
| T06 | VAT-59 baseline v2 with null/blank description | REJECT and restore at VAT-59; signed by Palepu Sai Sri Harsha | Unchanged; VAT-59 remains at baseline v2 | Fresh Jira read shows VAT-59 Description is empty again (`Add Description` / `Add a description...`), with no attachment, and version history remains 3 entries. | VAT-59 reports `Restored and verified`, `Back to version 2`, `IN SYNC`, `None since the latest baseline`, and `Rejected Oct 8, 2026, 11:19 AM`; VAT-57 reports no changes since its latest baseline, `Restored and verified through VAT-56's rejection`, and `IN SYNC`. | Harness showed `restore:getState` at VAT-59 and `panel:getEvidence` at VAT-57; raw null/empty ADF, normalized digest, restore-worker, ledger, and backend logs were not independently retrieved. | PASS — rejection restored the baseline-null description without a phantom drift or new version; the parent settled cleanly. Raw ADF/null-equivalence proof remains open. |
| T07 | VAT-56 baseline v2 with no attachment; label `t07-attachment-drift` added; user uploaded `TCSA CSA STAR Level 1 (CAIQ) Scoping Questionnaire (Fillable) copy.pdf` (433 KB) | REJECT and restore at VAT-56; signed by Palepu Sai Sri Harsha | VAT-56 remains at baseline v2; added attachment should be deleted and labels should return to baseline | Fresh Jira read after rejection shows the uploaded 433 KB PDF still present; root labels returned to `live-dr-20261008` and `t03-scalar-drift`; no new version was created. | VAT-56 reports `Restored and verified`, `Back to version 2`, `IN SYNC`, and `Rejected Oct 8, 2026, 11:25 AM`; the diff before decision showed exactly 2 changes: Attachment (1 added, Major) and Labels (1 added). | Harness showed `restore:getState` and `panel:getSummary`; Jira attachment name/size were visible, but raw attachment ID/hash, restore plan `willDelete`, vault/ledger rows, and backend logs were not independently retrieved. | FAIL WITH FINDING — label restoration and no-new-version checks passed, but the added root attachment was not deleted despite the rejection and the `Restored and verified` receipt. Residual attachment must be resolved before another case is layered on this tree. |
| T08 | VAT-57/C1 baseline v2 with `LIVE-DR-20261008-C1-baseline.txt` (92 B) | REJECT and restore at VAT-57; signed by Palepu Sai Sri Harsha at 11:46 AM | Unchanged; VAT-57 remains at baseline v2 with version history 3 | Fresh Jira read shows the original rich description restored with its baseline markers, but VAT-57's attachment section is empty after the baseline file was removed. VAT-56's Jira fields remain unchanged (baseline root description, labels, due date Oct 15, 2026, Medium priority); no new version was observed. | Before decision, VAT-57 showed exactly 2 changes: Description changed (Critical) and Attachment 1 removed (Major). After rejection and a panel refresh, VAT-57 reports `Restored and verified`, `Back to version 2`, `IN SYNC`, and `Rejected Oct 8, 2026, 11:46 AM`; no attachment is rendered. A fresh parent panel receipt was not captured because the parent panel reloaded incompletely. | Harness showed `restore:getState` and `panel:getSummary`; raw ADF, attachment ID/content hash, vault lookup, restore plan, ledger, worker, and backend logs were not independently retrieved. | FAIL WITH FINDING — rich-description restoration, no-new-version, and child sync passed, but the removed baseline attachment was not restored despite the `Restored and verified` receipt. This repeats the attachment-restore gap seen in T07 and must be resolved before layering another attachment case. |
| T09 |  |  |  |  |  |  |  |
| T10 |  |  |  |  |  |  |  |
| T11 |  |  |  |  |  |  |  |
| T12 |  |  |  |  |  |  |  |
| T13 |  |  |  |  |  |  |  |
| T14 |  |  |  |  |  |  |  |
| T15 |  |  |  |  |  |  |  |
| T16 | VAT-56 baseline v2; attachment-free drift in Description, Priority, Assignee, Summary, and Labels | Per-field map: 3 approve, 2 reject; close and reopen the diff without saving | Reopened diff retained `3 approve · 2 reject · 0 undecided`; `Save changes` then opened assurance and the signed mixed decision completed | Live modal retained evidence hash `e7f0·dab3`; after the retry the panel showed “Decided field by field,” baseline version `3`, electronic signature, “No changes since the latest baseline,” `IN SYNC`, and “Restored and verified”; native `Approve to In Progress` remained untouched | Not applicable for this sub-step | PASS — read-only tree-node digest overlay defect fixed; backend (1,719), frontend (262), and build verification passed; app `7.34.0` deployed; live mixed save created and signed baseline v3 with the 3/2 field decision map. |
| T17 | VAT-56 baseline v3; visible parent mutations: Description, Priority, Assignee, Summary, and label `t17-parent-scope`; VAT-57/C1 child mutations: Description, Priority, and Summary; C1 attachment left untouched | Pending user field map; no signature submitted | Unchanged; VAT-56 remains baseline v3 and VAT-57 remains baseline v3 | Fresh Jira reads show the parent’s five visible mutations and the child’s three mutations; C1 attachment `LIVE-DR-20261008-C1-baseline.txt` remains present at 92 B. | After app 7.36.0 deployment and Jira installation refresh, VAT-57 shows exactly `3 changes · 3 edits`: Description, Priority, and Summary, each with separate Approve/Reject controls; summary is `0 approve · 0 reject · 3 undecided`, and `Save changes` is disabled until complete coverage. Native Approve changes / Reject and restore remain separate footer actions. | No signature, approval, rejection, or native transition was used. Local suites passed 1,725 backend and 262 frontend tests; production build passed; Forge deployment and Jira install both report current. | READY FOR USER DECISION — child field-level review is live and verified. The earlier legacy-message defect is fixed. The parent label omission remains a separate read-only diff finding and is not being folded into this child decision. |

## Stop and safety rules

- No mutation of VAT-42 through VAT-55.
- No signature is entered by the agent.
- Attachment evidence must contain content hashes; attachment counts or
  filenames alone do not pass.
- Description evidence must contain raw ADF and the normalized comparison;
  rendered text alone does not pass.
- T13's structural test needs a fresh subtask; deleting or permanently
  removing an issue is not part of the first pass. A deletion/removal variant
  requires a separate explicit confirmation immediately before that action.
- Do not retry a failed approval blindly. Capture the panel, Jira history,
  live-drift log, and operation/restore state first.
- A green local test/build/deploy is not live acceptance. The result document
  must state the exact deployed app version and the tenant evidence used.
