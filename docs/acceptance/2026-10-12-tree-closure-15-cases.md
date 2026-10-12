# Tree governance closure: 15 compound cases

Date: 2026-10-12. Target: `mgtechdemo.atlassian.net`, VAT, VAtlassian DEV.

## Verdict

**NOT ACCEPTED against the user's latest contract.** Live inspection found upward drift in the parent panel; local source inspection found inherited parent field lists. Both contradict the user's clarifications in this chat. No full case is certified PASS. This is an initial acceptance record, not a completed 15-case run.

Existing uncommitted application changes were preserved. No source change, deployment, issue creation, field mutation, transition, approval, rejection, or signature was performed in this run. Browser refreshes and read-only inspections were performed. Earlier results are historical evidence only.

## Contract frozen from this conversation

The user's later correction supersedes the original request for upward propagation.

1. A baseline ceremony on issue R covers R and all supported descendants through the parent hierarchy. Each issue snapshots **its own project/type's controlled fields**. R supplies the signature/assurance; its field list is not inherited by every child.
2. Each previously unbaselined member receives its own v1. Existing members have independent version sequences; a parent's version number must not overwrite them. Record exactly which baseline, approval, signer, method, field configuration, and parent lineage cover each member.
3. Drift scope runs **downward**, like signature scope. An issue's own changed controlled data causes its own drift and an inherited hold on descendants. It must not cause ancestor or sibling drift. Do not fabricate changed field values on untouched descendants to express that hold.
4. Ordinary issue links retain relation identity/type/direction and the other issue's stable identity/key. They do not pull that issue's fields into a hierarchy baseline. Editing one endpoint's ordinary fields must not drift or rebaseline the other endpoint.
5. A decision at R covers R's subtree only. Approve captures the accepted final state. Reject restores the selected subtree to the applicable latest baselines. A mixed decision restores rejected changes before capturing the accepted final state. All-approve and all-reject field saves must match the whole-set actions.
6. Decisions use the policy/assurance recorded on the applicable latest baseline, not an unrelated future workflow transition or a weaker fallback. Descendant workflows may differ.
7. A drift hold blocks all outgoing transitions where enforced. Once all applicable holds are gone, uncontrolled transitions work and controlled transitions require their configured assurance without phantom content-change denial.
8. Baselined attachment bytes must exist in Object Store and be retrieved during restore. Rich-text restoration must preserve the entire ADF structure and render embedded media in the correct positions. A green receipt alone is insufficient.

### Explicit boundaries and unresolved details

- The existing fixture has three hierarchy levels (Epic > Story > Sub-task). It cannot prove arbitrary depth. Record the tenant's supported hierarchy and product traversal limits; any deeper requirement remains unverified until exercised on a supported fixture.
- A relationship add/remove affects Jira's shared link at both endpoints. The assertion that ordinary field drift never spreads through links is distinct from whether a signed link decision may create a derived link-only baseline at the peer. Current `src/jobs/linkWorker.js` does create those derived versions. Confirm that policy before accepting peer-version behavior; do not silently interpret "unaffected" to permit it.
- A descendant decision must not clear a hold caused by an unresolved ancestor. This follows from downward scope and must be tested explicitly.
- Restore to the latest applicable baseline must preserve independently approved newer child content. It must never silently revert to an obsolete ancestor snapshot.
- Skipping versions for unchanged descendants is an optimization, not a mandatory pass condition. Exact changed/unchanged version behavior must still be recorded, with immutable coverage provenance.
- A type with no configured controlled fields must be visible as an explicit coverage gap; a parent signature must not be presented as evidence that unconfigured fields were captured.

## Current fixture and observations

| Role | Issue | Fresh browser observation |
|---|---|---|
| Root | VAT-65 | Epic, To Do, baseline v2, 18 tracked fields across 4 work items; linked to VAT-66 |
| Child | VAT-69 | Story, parent VAT-65, To Do, baseline v5, 18 tracked fields; "Baselined with VAT-65 version 2"; Priority Low → Highest |
| Other branch | VAT-68 | Listed under VAT-65; existing plan identifies VAT-70 beneath it. Its current full baseline was not inspected in this run |
| Ordinary link peer | VAT-66 | Displayed as the root's relates-to endpoint. Its own baseline/field state was not inspected in this run |

After refreshing both panels, VAT-69 showed one changed Priority field. VAT-65 showed the same `VAT-69 · Priority Low → Highest` row, `DRIFTED`, `1 child work item has changes awaiting a decision`, and `Held until the changes are decided` for To Do → In Progress. This is a **live UI failure of the no-upward-drift requirement**. A native Jira transition was not submitted, so it is not evidence that Jira's validator actually denied the parent.

The child panel also retains a historical "Restored and verified through VAT-65's rejection" receipt while currently drifted. Such a receipt is historical and is not acceptance of the current state.

## Fifteen cases and current results

Use a single isolated tree with two branches, at least three supported levels, different issue types/field lists and workflows, plus an ordinary linked peer. Reuse that cast with recorded checkpoints. Do not assume older fixtures are disposable.

| ID | Compound case and decisive assertions | Current result |
|---|---|---|
| T01 | Initial parent capture: different field lists/types/workflows, one rich ADF document, one file, one null description, one ordinary link. Each node uses its own fields, fresh nodes v1, common approval provenance, Object Store bytes verified; linked peer fields excluded. | **FAIL-SOURCE / LIVE CAPTURE NOT RUN.** Production helper returns the root field list for every node. Existing child panel lists 18 inherited fields, but own admin configuration was not independently read. |
| T02 | Parent-only field drift: parent and every descendant held; siblings outside selected subtree and ordinary linked peer unchanged. Untouched descendants show the source of the inherited hold, not invented field edits. Check immediately and after trigger reconciliation. | **NOT RUN.** Local validator computes this issue's own live drift; downward hold enforcement needs direct proof. |
| T03 | Middle/leaf-only drift: hold only that issue and its descendants; ancestors, the other branch and linked peer remain unaffected. Native transitions follow the same scope as the panel. | **FAIL-LIVE-UI (ancestor isolation).** VAT-69-only Priority drift appears as held drift on VAT-65. Descendant propagation and native validator assertions not executed. |
| T04 | Whole approve at root: combine scalar, ADF, attachment and link changes across the authorized subtree. Verify final snapshots, exact versions, provenance, no restore writes, and zero remaining applicable holds. | NOT RUN |
| T05 | Whole reject at root: combine root and descendant scalar/ADF changes, removal of a vaulted file, and a post-baseline added file/link. Restore latest applicable state; no new acceptance baseline; verify all bytes and raw documents. | NOT RUN |
| T06 | Decision at middle: own and descendant drift plus separate root/other-branch drift. Only selected subtree is written/rebaselined; root and sibling work preserved; independently approved newer child content survives a later ancestor restore. An unresolved ancestor hold cannot be cleared below it. | NOT RUN |
| T07 | Mixed field save across selected subtree: approve ADF/one scalar; reject another scalar/file. Full decision coverage required, authenticate once, restore rejected items first, then one accepted final snapshot per applicable issue. Verify exact resulting values and evidence. | NOT RUN |
| T08 | All-approve through Save changes: same input shape as whole approve. One capture, no restore writes, vaulted new file, identical scope/assurance semantics, no duplicate versions. | NOT RUN |
| T09 | All-reject through Save changes: same input shape as whole reject. Restore all selected changes, no new acceptance baseline, clear only resolved holds. | NOT RUN |
| T10 | Ordinary link isolation: mutate each endpoint's fields independently; verify no cross-link field drift/capture. Separately add/remove/change link direction/type and reject/approve; verify relation identity and no peer field overwrite. Resolve derived peer-baseline policy before certification. | NOT RUN |
| T11 | Object Store restore: delete baseline file, add another, replace same filename with different bytes, include a child attachment. Fresh downloads must match original SHA-256/name/size; no duplicates or extra files. Check Object Store read and restore jobs. | NOT RUN |
| T12 | Rich-text fidelity: completely clear a structured description containing lists/table/marks/breaks and embedded media; restore via parent and directly. Compare saved raw ADF with documented platform-only ID remaps, rendered placement and media bytes. Also null/empty-ADF round trip: no phantom drift. | NOT RUN |
| T13 | Structure: add/move/remove a relationship within supported hierarchy; snapshots preserve exact lineage and authorized scope. First child capture cannot fail from a field-scope hash change. Deletion of a Jira issue requires a separately approved disposable fixture and explicit recoverability expectations. | NOT RUN |
| T14 | Assurance and race: latest baseline policy on root/middle/leaf with different workflows; insufficient assurance/role rejected, canceled/stale challenge writes nothing, replay/double submit produces one result. Change content between review and signing. | NOT RUN |
| T15 | Workflow/evidence closure: native controlled and uncontrolled transitions on own-drifted, ancestor-held and clean issues; deny/allow matches exact scope, including immediately after edit and restore. Check validator attachment on every relevant edge, ledger chain, versions and absence of pending jobs. | NOT RUN. Development logs contain HOLD_ABSENT findings for project id 10236; mapping to the VAT fixture and exact transitions remains unverified. |

## Evidence contract for every action

Record action sequence, UTC timestamp, deployment/version, actor, issue/status, own baseline id/version and governing coverage, exact mutation or decision map, expected touched and untouched issues, request/approval/restore identifiers, and actual result. Record user authentication separately; the agent must not enter codes or biometric/signature material.

Before mutation: save fresh raw Jira fields including full ADF, parent/children, link identity/type/direction, attachment ids/name/size and original file SHA-256; record policy/configuration and panel/diff screenshot.

After action: repeat fresh Jira reads for touched AND negative-control issues; download restored files and compare hashes; compare ADF structurally and visually; capture panel/diff and related Forge events. A changed Jira attachment/media id can be legitimate after re-upload, but byte identity and media references/placement must be proven. Version increments and success receipts alone never pass.

Statuses: PASS requires every assertion and artifact; FAIL identifies a contradicted assertion; BLOCKED identifies missing access/authentication/data; NOT RUN never counts as PASS. A case may contain a proven failure while its other assertions remain unexecuted. After a semantic blocker, preserve the fixture and evidence before further mutations.

## Evidence collected during this run

- Browser: verified signed-in Jira session on mgtechdemo, VAT-65 and VAT-69; root and child Refresh, settled state read-back, parent screenshot captured in chat.
- Saved screenshot: `/Users/sriharsha/.codex/visualizations/2026/10/12/01a13109-b8e5-7940-98ad-e465effd5dba/vat-65-child-drift-hold.png`.
- Executed local production-helper probe: root fields `[summary]`, expected child-own fields `[description]`; `readTreeWithNodeFields().fieldsFor(child)` returned `[summary]`, so the own-field assertion failed. No Jira calls or application edits were involved.
- Connector: raw ADF read of VAT-65 was refused with `Cloud id: 471482bd-fced-4aab-acdd-db9b03bd040e isn't explicitly granted by the user.` No other tenant was substituted.
- Forge logs: restricted attempt failed on Keychain/network; approved retry succeeded. At 2026-10-12T16:36:56.203Z and 16:36:57.527Z, VAT-69 `drift:live`, baseline 5, `DIGEST_MISMATCH`, changed `[priority]`, 18 baseline/current/scope keys. At 16:56:53.341Z and 16:56:57.989Z, successful VAT-65 summary/evidence requests.
- Logs also contain six critical HOLD_ABSENT findings for project 10236/type ids 10022, 10045, 10005 on transitions 11 and 21; scope not yet matched to this fixture. Do not claim these prove missing validators on VAT-65/VAT-69.
- Deployment identity is not freshly verified; earlier plan says 8.8.0, which is historical. No claim that the dirty local checkout equals the deployed artifact.

## Source traces (current dirty checkout, not deployed-source proof)

- `src/lib/tree/nodeFields.js:31`: `fieldsFor: () => rootFields`; `scopeForItem` selects an external governing root's field scope.
- `test/tree-node-fields.test.js`: tests explicitly assert root-field inheritance and ignoring a child-only configured field under that model. Lower-level helpers also support per-node fields, which is not proof that production readers use them.
- `src/lib/treeCollect.js:251`: issue events fan out to affected governed roots.
- `src/usecases/panelAccess.js:149`: tree-wide diff is built for parent review; line 173 derives its drift count from that aggregate.
- `src/lib/approval/runtime.js:273`: validator compares the current issue's live fields to its active baseline, then returns `drift.changed.length` at line 292. Parent-panel hold and validator enforcement must be tested independently.
- `src/lib/baselinePolicy.js:63`: decision policy is read from immutable baseline provenance. This is source evidence, not live assurance acceptance.
- `src/jobs/linkWorker.js:95`: signed link changes can write a derived baseline at the other endpoint. Ordinary field propagation must remain distinct from shared-link settlement.

## Next executable boundary

Do not certify or repeat the old 40-case plan against the superseded model. First align downward inherited holds and per-issue controlled-field scope across capture, comparison, panel, signing hash, validator, restore, immutable evidence, and existing-baseline compatibility. Preserve the confirmed failures. Then execute this same 15-case matrix on the identified deployed version, with raw-data access and user-performed assurance ceremonies. The raw-data connector access limitation must be resolved or a separately authorized supported read path established before ADF fidelity can receive PASS.
