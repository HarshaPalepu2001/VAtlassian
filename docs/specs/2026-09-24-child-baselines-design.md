# Child baselines: every child carries its own baseline

**Date:** 2026-09-24
**Status:** Approved 2026-09-24
**Extends:** `docs/specs/2026-09-12-controlled-transition-tree-baseline-design.md`,
`src/lib/capture.js` (`writeCapturedTreeBaseline`), `src/lib/tree/capturePlan.js`,
`src/lib/treeCollect.js`.

---

## 1. The problem

When a parent is baselined, its whole hierarchy is captured: every child (through
Jira's `parent` link, all the way down) is read, hashed and stored as a node of
the parent's tree baseline. The parent's signature covers that tree hash, so the
children's content is already authenticated at that moment.

After that, though, a child has no baseline of its own. An edit to a subtask is
recorded only as drift against the parent's tree, and:

- **no panel can decide it.** The parent's panel offers decisions only for the
  parent's own fields, and the subtask's panel has no baseline to decide against.
- **the subtask is not held.** The validator holds an item on its own active
  baseline, and the subtask has none.
- **the subtask is tracked with the parent's fields.** `planTreeCapture` projects
  every node with the root's controlled fields, not the fields configured for
  the child's own project and issue type.

## 2. What the user wants

1. When a parent is baselined, every child automatically gets **its own baseline
   version**, authenticated by the parent's signature.
2. When a child's tracked content changes, **the child** shows the drift and is
   held. Someone opens the child and approves or rejects there.
3. A child with its own controlled transition can be baselined on its own. The
   parent and each child keep independent versions (the parent at v1, a subtask
   at v5). **A new version is never drift, as long as it was created by an
   authenticated act.** Anything else that changes tracked content is drift.
4. **Tracked fields:** every baseline tracks exactly the fields on the Controlled
   Fields page for **its own** project and issue type. That holds for the parent
   and for each child.
5. **Scope:** every child through the `parent` link, recursively. Linked issues
   stay as today: only the link is hashed (the `issuelinks` field, kind
   `LINKS`), never the linked issue's content.
6. **While a child is drifted,** only the child is held. The parent is held only
   for its own fields and for its structure (children added, removed or moved).

## 3. Approaches considered

**A. Materialise a baseline for each child at the parent's capture (recommended).**
The parent's capture also writes an ordinary single-issue baseline row for every
child, marked as captured by the parent's baseline and approval. From then on
each child is simply a baselined item: the validator, the panel, the flat drift
collector, approve and reject all work on it unchanged.

**B. Decide children from the parent's panel.** This extends today's tree
model. It was rejected because the user wants drift addressed inside the child,
and because it keeps the child unheld.

**C. Virtual child baselines**, derived on every read from the parent's stored
node. No new rows, but every reader (validator, panel, collector, restore,
decisions) would need a second "baseline via my parent" path. That is more code
and more places for the two verdicts to disagree.

## 4. Design (approach A)

### 4.1 Capture

`writeCapturedTreeBaseline` (parent):

1. Reads the tree as today.
2. **Projects each node with its own controlled fields.** It looks up
   `controlledFields({ projectId, issueTypeId })` per distinct project/issue
   type in the tree, and `planTreeCapture` takes a per-node field set instead of
   one list. The tree hash still covers every node's content hash plus the
   structure, so the parent's signature authenticates each child's content
   exactly as captured.
3. Writes the parent's tree baseline as today.
4. **For every non-root node, writes a child baseline row** (`va_baseline`, flat:
   `tree_hash` NULL) with:
   - the child's next version in its own lineage;
   - `field_digests` and stored values from the child's projection over its own
     fields;
   - the approval and signer of the parent's capture (`approval_id`,
     `approved_by`, `assurance_level`) — this is the authentication attached;
   - the parent's policy as provenance (`transition_id`, `required_role`,
     `required_assurance`), so the child's drift is decided under the rule that
     signed it;
   - a new column, `captured_by_baseline_id`, pointing to the parent's baseline.
5. Publishes the parent and all child rows together. Each child's previous
   ACTIVE baseline becomes SUPERSEDED, and its item state is set to BASELINED at
   the new version.

A child whose project/issue type has **no controlled fields** gets no baseline
row. It still counts as a node in the parent's structure.

### 4.2 A child's own controlled transition

This is unchanged. The child is captured as it is today (a flat baseline, or a
tree baseline if it has children of its own) at its own next version. If the
parent is baselined later, the child gets another version from the parent's
capture. Both are authenticated acts, so neither is drift.

### 4.3 Drift

- **Child:** a normal flat baseline, so the existing flat collector
  (`collect.js`), the panel's `baselineDrift` and the validator all judge it
  against its own active baseline with its own fields. The child is held and
  decided in its own panel.
- **Parent:** `collectTree` stops reporting **field changes on non-root nodes**
  (`FIELD_CHANGED` for a child) as parent drift. The parent's drift is its own
  fields plus structural changes: a node added, removed or re-parented.
  Otherwise a child's own approved change would leave the parent permanently
  drifted against the child content it captured.

### 4.4 Deciding a child's drift

In the child's panel, exactly as for any baselined item:

- **Approve** captures the child's next version in place, under the policy on
  its current baseline (here, the parent's role and assurance), authenticated by
  that approval.
- **Reject** restores the child's tracked fields to its active baseline.

Neither touches the parent.

### 4.5 Deciding the parent's drift

- **Approve** captures the parent's next version, which, by 4.1, also gives
  every child a new version authenticated by this approval.
- **Reject** returns everything to its **latest recorded baseline**:
  - the parent's own fields and its structure go back to the parent's active
    baseline (for example v3);
  - each child's tracked fields go back to **that child's own** active baseline.
    Normally that is exactly what the parent's capture recorded. If a child has
    since been re-baselined by its own authenticated act, its newer baseline
    wins, because restoring the older parent-captured content would undo a
    signed decision.

### 4.6 Panel and validator

- **Validator:** no change. A child with an active baseline is held on its own
  drift, like any item. The parent is held only on its own fields and structure.
- **Child panel:** shows "Baselined with PARENT-1 v3, signed by …" from
  `captured_by_baseline_id`. Its review and decisions cover only the child.
- **Parent panel:** offers a decision whenever the parent **or any child** has
  drifted, because a parent decision covers the whole tree (4.5). When only
  children have drifted it says so ("2 subtasks have changes awaiting a
  decision"). The parent is not held by children's drift, so it can still move.

### 4.7 Reviewing a parent: changes grouped by issue

The parent may have drifted (say against v5) while some of its children have
drifted too. The parent's review diff shows everything its decision would cover,
grouped by issue:

- **the parent** (key and summary): its own changed fields, against its own
  active baseline;
- **structure**: children added, removed or moved;
- **each drifted child** (key and summary): its changed fields against **that
  child's own active baseline**, which is exactly what a parent reject restores
  it to (4.5).

Each group reads as "in this issue, these changed". Children with no drift are
not listed. The flat `fields` list stays for existing consumers (counts,
filtering by visibility); groups are added alongside it, and the review diff UI
renders one section per issue.

## 5. Existing data

Today's tree baselines already hash and store each child's content, but with
the **parent's** tracked field list. No backfill: each existing tree's children
get their own baselines, over their own fields, at the parent's next
authenticated capture. Until then they behave as today.

## 6. Out of scope

- The content of linked issues. Only the link is hashed, as today.
- Holding the parent while a child is drifted. (Still true. But **superseded downward on 2026-10-12**: a drifted
  parent now holds every item below it, and the flag climbs to every ancestor, not only the root. See
  `src/lib/ancestorHold.js` and `docs/acceptance/2026-10-12-assurance-run.md`.)
- Changing how a controlled transition on the child itself works.

## 7. Testing

- **Validator scenarios** (`test/validator-scenarios.test.js` and its harness):
  - a parent capture creates child baselines;
  - a child edit holds the child only, and is decidable on the child's panel;
  - child approve and child reject;
  - independent versions (a child at v5, the parent at v1);
  - a child baselined on its own and then by its parent is not drift;
  - a child type with no controlled fields;
  - grandchildren;
  - a child added, removed or re-parented is parent drift;
  - linked issues are unchanged.
- **Capture:** per-node field sets, the tree hash with mixed issue types, the
  publish (and its failure) of parent and child rows together, and retries.
- **Tree collector:** child field changes are not parent drift; structural
  changes still are.
- **Restore:** a parent reject restores structure and the parent's fields only.

## 8. Decisions

1. **Existing tree baselines:** no backfill. Children get their own baselines at
   the parent's next capture (section 5).
2. **Rejecting the parent:** restore to the latest recorded baseline of each
   issue, children included (section 4.5).
3. **Parent and children drifted together:** the parent's review groups the
   changes by issue, and a parent decision covers them all; a child can still be
   decided on its own (sections 4.6, 4.7).
