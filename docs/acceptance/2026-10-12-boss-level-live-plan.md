# Boss-level live plan. 2026-10-12

Merges the suite structure and tree semantics of the 2026-10-05 plan (A–I, named cast,
"who decides, which versions move, what holds") with the oracles and combined-risk cases
of the 2026-10-08 plan (T01–T17). Tenant `mgtechdemo.atlassian.net`, project `VAT`,
development environment. Fresh fixture, prefix `LIVE-DR-20261012`.

## What "Boss" means here

1. **Every case combines at least three dimensions.** Tags: `TREE` (child/parent/root
   level), `ATT` (attachment), `ADF` (rich text), `LINK`, `FIELD` (scalar), `AUTH`
   (signature, stale, replay, role), `CAP` (a capture happens in the same step).
2. **A pass needs all three independent reads:** fresh Jira read-back (fields, parent,
   links, attachments by id/name/size/SHA-256, raw ADF); the panel or diff screenshot
   (version, drift, changed fields, gate); and `forge logs` (`drift:live`, `gate:*`,
   `approval:hash-basis`, restore worker). Rendered text or a "Restored and verified"
   receipt alone never passes.
3. **Versions are relative.** Record `vN` from the panel before and after each step. Never
   infer the next number.
4. **Stop at the first mismatch** (partial restore, unexpected version, panel vs
   `drift:live` disagreement, any `gate:deny` that is not expected). Preserve the evidence
   and report before continuing. No code change without the user's go-ahead.
5. **The user performs every signature.** I name the issue key and action; I never enter
   TOTP, Touch ID or WebAuthn material. Creating issues and any delete need the user's
   explicit yes in chat immediately before.

## Cast

Project allows Epic > Story/Task > Sub-task only (three levels).

| Alias | Type | Role |
|---|---|---|
| E | Epic | root; rich ADF (heading, 2 paragraphs, bullets, hard-break, table), priority, labels, due date, assignee; **no attachment at baseline** |
| C1 | Story | child of E; different ADF; one deterministic attachment (SHA-256 recorded); this is the **first-capture regression subject** |
| C2 | Story | child of E; different ADF, priority, labels; no attachment |
| S1 | Sub-task | child of C1; **description never set**; one label |
| S2 | Sub-task | child of C2; created later, in A7 |
| L1–L4 | Task | standalone linked issues; L1 linked to E at baseline, L2 left unlinked, L3/L4 used in link suites |
| B | Task | a baselined standalone issue for two-owner link tests |
| X | Epic | second Epic for move tests |

Pre-flight: record the declared controlled field ids and the controlled transitions per
type (Admin screens), including `issuelinks`, `parent`, `subtasks`, `attachment`. Record
the deployed app version and the `forge logs` terminal.

Oracles: every attachment is a deterministic synthetic file (record SHA-256, name, bytes,
Jira attachment id); every file added after baseline has a new hash and name. Rich
descriptions carry stable markers and the raw ADF is saved before baseline and after every
restore. S1's null versus empty-ADF equivalence is checked on the raw response.

## Fixture as created (2026-10-12, app 8.6.0 on development)

Created through Jira REST in the signed-in tenant session, then read back. All six start In Review.

| Alias | Key | Type | Read-back |
|---|---|---|---|
| E | VAT-65 | Epic | priority High, due 2026-11-15, assignee set, labels `live-dr-20261012` `e-base`; ADF: heading, 2 paragraphs, bullet list, hard-break paragraph, table; no attachment; linked to VAT-66 (Relates) |
| L1 | VAT-66 | Task | ADF as above; linked to E |
| L2 | VAT-67 | Task | ADF as above; no links |
| C1 | VAT-68 | Story | parent VAT-65; due 2026-11-18; labels `c1-base`; ADF; attachment id 12180 `LIVE-DR-20261012-C1-baseline.txt`, 108 B, SHA-256 `2543f90e 2e873c92 41635c4d b5246bd3 9a9bcf6b 7f9f0e64 378db7af 88df94d8` (local and downloaded copies match) |
| C2 | VAT-69 | Story | parent VAT-65; priority Low; labels `c2-base`; ADF; no attachment |
| S1 | VAT-70 | Sub-task | parent VAT-68; label `s1-base`; description never set (null); no attachment |

Gaps: raw ADF JSON not yet saved to file; Admin controlled-field list and transitions not yet read (the Forge admin iframe is opaque to text reads).

## Suite A. core path (the A1–A9 flow, now with files and ADF)

| ID | Scenario | Expected | Dims |
|---|---|---|---|
| A1 | Assemble E, C1, C2, S1, L1–L2; link E–L1; baseline E with the normal ceremony; confirm C1's file is vaulted by hash. | E v1; C1, C2, S1 each v1 "Baselined with E v1"; vault row `OBJECT_STORE`, key `vault/sha256/<hash>`; E and S1 have no attachment baseline. | TREE ATT ADF LINK CAP |
| A2 | Remove E–L1 and change E's description ADF; reject at E. | Held while drifted; link recreated once, ADF restored exactly; "Restored and verified"; E still v1; no new version. | LINK ADF TREE AUTH |
| A3 | Add a new child C3 with an attachment and ADF; approve at E. | E v+1; C3 v1 with its own file vaulted; C1/C2/S1 re-versioned only as spec §4.1 says; drift clears. | TREE ATT ADF CAP |
| A4 | C1 gets a link to L2 and a second attachment; decide at C1. | Drift on C1 and E; C1 v+1; C2 untouched; E's flag clears, E's version unchanged. | TREE LINK ATT CAP |
| A5 | C1 gets a link to L3 and an edited ADF; decide at E. | E v+1, C1 v+1; review groups by issue; C2 untouched in content. | TREE LINK ADF CAP |
| **A6** | **Regression for the VAT-59 failure.** After E's baseline, C1 (covered by E, never captured on its own) takes its own controlled transition In Review → To Do with "Captures a new baseline"; C1 carries the vaulted attachment. | Transition succeeds on the **first** attempt. `approval:hash-basis` and the validator's recomputed hash agree; no `gate:deny` with `CONTENT_OR_EVIDENCE_CHANGED`. If it denies, the two basis blocks (scope source, field ids, attachments) name the cause. | TREE ATT CAP AUTH |
| A7 | Add S2 under C2 with a file and ADF, plus a link on C2; decide at E. | `NODE_ADDED` for S2; mixed field save unavailable and explained; S2 v1 with own file vaulted; all flags clear; transitions open. | TREE ATT ADF LINK CAP |
| A8 | S1 (description null at baseline): add a rich description, then reject at S1. | Empty-ADF compares as no content; zero drift; no phantom structure change; no new version; parent settles. | ADF TREE |
| A9 | E: structured ADF edit (paragraph, list, hard-break, table cell) plus priority and labels; approve. | Structured diff, exact count, one new version from current ADF, no restore write. | ADF FIELD AUTH CAP |

## Suite B. which side decides (scope and symmetry)

| ID | Scenario | Expected | Dims |
|---|---|---|---|
| B1 | Link and a new file on C1; reject at C1. | Link removed, file deleted, C1 version unchanged, E not restored, E's flag clears. | TREE LINK ATT |
| B2 | E's own field, C1's link and C1's ADF all drifted; reject at E. | Each restored to its latest baseline; no new versions anywhere. | TREE LINK ADF FIELD |
| B3 | Same drift; approve at E. | E v+1, C1 v+1, other children by spec §4.1; one signature covers both. | TREE LINK ADF CAP |
| B4 | Two siblings drifted (C1 file, C2 link); decide one child at a time. | Each child advances independently; E stays flagged until the last is decided. | TREE ATT LINK |
| B5 | Three levels: S1 file and description drifted; approve at the middle (C1). | S1 and C1 advance; C2 untouched; E clears only for what C1 covered. | TREE ATT ADF CAP |
| B6 | C1 approved alone (newer signed content); then E's field drifts; reject at E. | E's field restored; **C1 keeps its newer signed content and file**. | TREE ATT FIELD AUTH |
| B7 | After B6, approve at E. | C1 gets a new version over its current content, never over older E-captured content. | TREE ATT CAP |

## Suite C. attachments end to end (the two earlier fails, T07 and T08, rerun)

| ID | Scenario | Expected | Dims |
|---|---|---|---|
| C1 | E has no baseline attachment; add a file and a label; reject the whole set. | The added file is **deleted** (fresh Jira read), label restored, no vault row required, no new version. | ATT FIELD AUTH |
| C2 | Remove C1's baseline file and change its ADF; reject at C1. | The exact file is re-uploaded from the vault, SHA-256 matches, no duplicate; ADF restored; version unchanged. | ATT ADF TREE |
| C3 | Replace a file under the same name (new bytes). | Seen as remove + add, not a no-op; reject restores the original bytes by hash. | ATT AUTH |
| C4 | One reject covering a removed file, an added file, an edited ADF and a scalar. | All four settle in one write set; the target attachment set equals the baseline set by id, name, size and hash. | ATT ADF FIELD AUTH |
| C5 | Child file added and removed under a parent reject. | Child restored through the parent; child panel reads "Restored and verified through <parent>'s rejection". | ATT TREE |
| C6 | Legacy `storage = CONFLUENCE` row, if any exists. | Restore refuses with "stored in Confluence, which is no longer supported". | ATT AUTH |

## Suite D. per-field (mixed) decisions

| ID | Scenario | Expected | Dims |
|---|---|---|---|
| D1 | E: ADF, file, priority, label changed; approve ADF and label, reject file and priority. | Save disabled until full coverage; one signature; one mixed baseline version; rejected values and file restored, approved ones kept. | ADF ATT FIELD AUTH CAP |
| D2 | Every changed item approved (C2: ADF, file, priority). | Behaves as whole-set approve: no restore, one version, new file vaulted. | ADF ATT FIELD CAP |
| D3 | Every changed item rejected (C2). | Behaves as whole-set reject: file removed, ADF and priority restored, no new version. | ADF ATT FIELD |
| D4 | E: summary, description, priority, labels, assignee changed; 3 approve, 2 reject; close and reopen the diff. | Decisions survive close and reopen; one signature; evidence hash unchanged. | FIELD ADF AUTH |
| D5 | E five fields and C1 three fields; open the child diff. | The child shows exactly its three fields with its own controls; the parent stays separately reviewable. | TREE FIELD |

## Suite E. links (two owners)

| ID | Scenario | Expected | Dims |
|---|---|---|---|
| E1 | Link C1→B (B baselined); approve at C1. | B gets a derived version with the link; pending marker shown, then cleared; no second signature. | LINK TREE CAP |
| E2 | Same link, decided at B's side. | C1 receives the link record; one decision settles both ends. | LINK AUTH |
| E3 | Remove a link whose other end is baselined; reject one end. | One Jira write seen by both ends; the other end's signature is never overwritten. | LINK AUTH |
| E4 | Link between siblings C1↔C2, plus a type change. | One decision settles both; direction and type recreated exactly on reject. | LINK TREE |
| E5 | Add then remove a link before any decision. | Drift clears by itself; no decision, no version. | LINK |

## Suite F. stale, cancel, replay (fail-closed)

| ID | Scenario | Expected | Dims |
|---|---|---|---|
| F1 | Start a mixed challenge on E; before signing, change the ADF and replace the file in a second tab. | Submit fails closed as changed evidence; no approval, restore, version or file op; reload names the fresh state. | AUTH ADF ATT |
| F2 | Cancel authentication mid-way; retry and sign once; replay the consumed submit. | Cancel records nothing; one decision only; replay refused or idempotent. | AUTH CAP |
| F3 | Double click Approve on a child with a file. | One version, no duplicate ledger rows. | AUTH ATT TREE |
| F4 | Attempt the controlled transition before and after settlement. | Blocked while drift remains; succeeds only after fresh verification. | AUTH TREE CAP |

## Suite G. validator holds and agreement

| ID | Scenario | Expected | Dims |
|---|---|---|---|
| G1 | Child drifted, parent clean by its own fields. | Child's transition held; parent's not (spec §6). | TREE |
| G2 | For every flagged issue read Diagnostics → Server Diagnostics. | Live check agrees with the lozenge and panel (2026-10-01 defect class). | TREE |
| G3 | After any decision, run the issue's controlled transition. | Refused before the decision; succeeds with a signature after; no `CONTENT_OR_EVIDENCE_CHANGED`. | AUTH CAP |
| G4 | Second user or role, if available. | Wrong role sees the drift but cannot decide; server refuses. | AUTH |

## Suite H. structure

| ID | Scenario | Expected | Dims |
|---|---|---|---|
| H1 | Move C2's child S2 to C1. | Drift on old parent, new parent and E; approve keeps lineage; reject moves it back. | TREE |
| H2 | Move a child to X and back. | Child's baseline survives; no permanent drift against E. | TREE |
| H3 | Delete a child (**separate explicit confirmation immediately before**). | `NODE_REMOVED`; record what restore does; ledger holds the full values first. | TREE ATT |

## Suite I. ledger, evidence, health

After each decision: chain is `Approval recorded → Baseline captured (per issue) →
Signature consumed` (or the restore chain), hash-chained, one approval id on every child
baseline it captured. `captured_by_baseline_id`, `approved_by` and `assurance_level` on each
child equal the parent's approval. Health shows no stuck link, restore or vault jobs.

## Run order

A → B → C → D → E → F → G → H → I. **A6 first after A1**, since it is the open regression
and the new logging only fires on a first capture of a new child.

## Results

| ID | Keys / version before | Decision | Version after | Jira / ADF / file read-back | Panel / diff | Logs | Result / finding |
|---|---|---|---|---|---|---|---|
| A1 | VAT-65 (E) In Review, no baseline; VAT-66..70 unbaselined | APPROVE at VAT-65 (In Review → To Do), electronic signature, 5:05 PM IST (11:35 UTC) | E v1; VAT-68, VAT-69, VAT-70 each v1 "Baselined with VAT-65 version 1" | Jira: E now To Do, children and L1/L2 unchanged (`updated` stamps from fixture creation); C1 file id 12180 still present, downloaded SHA-256 matches local (`2543f90e…88df94d8`); E has no attachment; link E–L1 intact; S1 description still null. | E panel: "Matches baseline version 1", IN SYNC, 18 tracked fields across 4 work items, "None since the latest baseline", next transition To Do → In Progress "Does not capture a baseline". C1 (VAT-68), C2 (VAT-69), S1 (VAT-70): each v1, IN SYNC, 18 tracked fields. C1 and C2 next transition In Review → To Do "Captures a new baseline" (electronic signature); S1's is biometric. | `approval:hash-basis` (VAT-65): mode `tree`, scope `own`, type 10000, 18 field ids incl. `attachment`, no attachments on E. `gate:allow SIGNATURE_CONSUMED`, `transitioned: true`. `vault:copied` VAT-68 file 12180, key `vault/sha256/2543f90e…88df94d8`, `OBJECT_STORE`, no fallback. No other file vaulted. | PASS. baseline propagation, sync and vault proof verified. Open: raw ADF JSON not saved; vault row not read from SQL (log only); no ledger chain read. |
| A6 | VAT-68 (C1) In Review, v1 "Baselined with VAT-65 version 1", never captured on its own; covered by E's baseline | APPROVE at VAT-68 (In Review → To Do, captures), electronic signature, 11:39 UTC (5:09 PM IST) | Unchanged to the user: approval VOID, transition not made, VAT-68 still In Review. The capture itself ran (new baseline `5407e417…`, file re-vaulted). | Jira unchanged apart from the refused transition; attachment 12180 still present. | Panel showed "Approval recorded. Jira refused the transition: This work item changed after approval…" | `approval:hash-basis` (signing): mode `tree`, scope **`governing-root`**, issue type **10000 (Epic)**, **18** field ids incl. `customfield_10001` and `customfield_10017`, attachment 12180 `isRichText:false`. `gate:deny CONTENT_CHANGED / CONTENT_OR_EVIDENCE_CHANGED` (validator): `evidenceValid:true`, approval hash `e0898f9b…cc9de`, recomputed `6964c5b4…c3c3`, mode `tree`, scope **`own`**, issue type **10007 (Story)**, **16** field ids (no `customfield_10001`, no `customfield_10017`), same attachment flags. | **FAIL. root cause confirmed.** The capture makes VAT-68 the root of its own baseline, so `scopeForItem` flips it from `governing-root` (Epic's 18 fields) to `own` (Story's 16 fields) between signing and the validator's recompute. Same hash inputs, different tracked field set. Attachment/rich-text candidate ruled out (flags identical on both sides). Same defect as VAT-59 at 11:04 UTC; a retry passes because the item is already its own root. Fix not yet made. |
| A6b | VAT-69 (C2, no attachment) In Review, v1, never captured on its own | APPROVE at VAT-69 from the **transition screen** (not the panel), electronic signature, 11:44 UTC | Unchanged: approval refused, VAT-69 still In Review. Screen showed "This work item changed after approval…" | Jira unchanged. | Review Gate dialog showed the error. | `approval:hash-basis`: `governing-root`, type 10000, 18 fields, no attachments, hash `04d57649…2b84`. `gate:deny CONTENT_OR_EVIDENCE_CHANGED`: `own`, type 10007, 16 fields (same two missing), recomputed `e7117bfd…3582`, no attachments. | **FAIL, same cause, route-independent, attachment-independent.** Panel and transition screen both go through `prepareApproval` and the validator. VAT-68's later retry passed on the transition screen only because the first attempt had already made it its own root. |
| A6c | VAT-70 (S1) In Review, v1, never captured on its own; app **8.8.0** (scope fix in `scopeForItem`: a covered child that is also its own root stays governed by the covering root) | APPROVE at VAT-70 from the panel (biometric), 12:00 UTC (5:30 PM IST) | VAT-70 To Do | Jira: VAT-70 status To Do (`updated` 17:30:48); no attachments; other fixture issues unchanged. | VAT-68 (already its own root, now on To Do) after the deploy: "Matches baseline version 3", IN SYNC, 16 tracked fields across 2 work items, no phantom drift. | `approval:hash-basis` (VAT-70): mode `tree`, scope `governing-root`, 16 fields, no attachments, hash `19da27da…8b7f`. **No `gate:deny`**: `gate:allow SIGNATURE_CONSUMED`, `transitioned: true`, first attempt. | **PASS. A6 regression fixed on a never-captured child, first attempt.** Note: VAT-70's governing root resolved to VAT-68's tree (most recent approval, Story type, 16 fields), not E's 18; signing and validation both use that same resolution. |
| A6d | VAT-69 (C2, no attachment) In Review; failed first attempt at 11:44 UTC (A6b) had already captured it; app 8.8.0 | RETRY APPROVE at VAT-69 from the **transition screen** (`approval:challenge/submit`), 12:03 UTC | VAT-69 To Do | Jira: VAT-69 status To Do, no attachment, labels `c2-base`, priority Low, parent VAT-65. | Not captured (panel not screenshotted). | `approval:hash-basis`: `governing-root`, type 10000, 18 fields, no attachments, hash `04d57649…2b84` matches the signing hash of the failed 11:44 attempt. The same content now hashes the same on both sides. `gate:allow SIGNATURE_CONSUMED` at 12:04:04, no `gate:deny`. | **PASS. fix holds on the transition screen route and on an item already in the "both" state.** |

Observed in the same log window, not part of this plan row (run by the user, not by the agent): after A6d, VAT-69 showed drift (`click:open:changes`, driftCount 1 then 3, 12:08–12:10 UTC) and a MIXED per-field decision was signed at 12:14 UTC (panel, TOTP, approval `2711e869…` CONSUMED, `transitioned:false`). Its `approval:hash-basis` listed attachment 12181 with `isRichText:true`. The outcome of that decision was not read.
