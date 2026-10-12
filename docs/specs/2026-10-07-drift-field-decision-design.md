# Per-field drift decisions with authenticated save

Status: design approved in conversation; implementation pending spec review

## Purpose

Upgrade the existing drift review without weakening the current approval and
restore controls. Reviewers must be able to choose the outcome of each changed
field, authenticate that complete choice once, restore rejected fields, and
publish the resulting state as the next approved baseline. Reviewers who do
not want a field-by-field review must retain the existing whole-set Approve and
Reject actions outside the diff view.

The attached reference image is a visual cue for the two-sided comparison and
per-field Apply affordance. It is not a source of product or security rules.

## Existing contracts that remain

- The issue panel and review-window footer keep the current whole-set Approve
  and Reject actions.
- Those actions use the existing challenge, authentication provider,
  evidence-hash binding, approval record, restore/capture path, audit trail,
  and refresh behavior.
- A decision is never accepted because the browser claims that a field was
  applied. The server remains the authority for eligibility, policy,
  evidence, locks, writes, verification, and final state.
- A stale evidence read, a changed field map, a missing retained value, an
  unavailable Jira write, or an incomplete restore fails closed and leaves the
  item reviewable/blocked according to the existing restore state rules.

## User experience

### Two separate workflows

1. **Whole-set workflow**

   The reviewer uses the existing Approve changes or Reject changes action
   outside the diff review. The action applies to the full current drift set
   and opens the existing authentication panel/receipt.

2. **Mixed field workflow**

   The reviewer opens View changes. The diff review hides duplicate whole-set
   decision controls inside the comparison surface and shows an explicit
   per-field decision control for every visible changed field. The native
   whole-set actions remain outside the diff view, so opening the diff never
   removes the fast path.

### Comparison layout

Each field card presents:

- the signed/original value on the left, labelled Approved value;
- the current/drifted value on the right, labelled Current value;
- the field name, materiality, retention/restorability status, and any
  available attribution;
- a keyboard-accessible decision track and explicit buttons.

The track has one uncommitted state and two committed states:

- dragging left to right records **Reject change** for that field;
- dragging right to left records **Approve change** for that field;
- keyboard arrows, Enter/Space, and the explicit buttons produce the same
  state transitions;
- a Reset decision control returns the card to undecided.

The interaction must not rely on colour or drag alone. The selected decision
is written in text and exposed through an accessible live/status description.
Reduced-motion users receive the same state change without animation.

### Save action and authentication

The diff view shows a summary such as “3 approve · 2 reject · 0 undecided” and
an **Save changes** button. Save changes is disabled while any eligible field
is undecided, while evidence is loading, while evidence has failed, or while
the current reviewer is not eligible.

If a field cannot be rejected because its approved value was not retained or
Jira cannot currently write it, the card is marked non-restorable and explains
the reason. It is not silently treated as approved. The mixed workflow cannot
submit until every changed field has an explicit decision, and a non-restorable
field cannot be assigned Reject.

Clicking Save changes does not write Jira or record an approval. It opens the
same authentication panel used for the latest-baseline ceremony. The panel
shows:

- the mixed meaning, for example “Save selected drift decisions”;
- the exact approve/reject counts;
- the fields in each set;
- the evidence identifier/hash being signed;
- the existing affirmation, TOTP or device-authentication control, and
  signed receipt behavior.

Authentication is requested once, after all decisions are recorded. A failed
or cancelled authentication leaves the map editable and records nothing.

## Authoritative decision model

The browser sends a canonical field-decision map, not a list whose order can
change the meaning:

```text
{
  intent: "DRIFT_MIXED",
  evidenceHash: "...",
  decisions: [
    { fieldId: "summary", decision: "APPROVE" },
    { fieldId: "description", decision: "REJECT" }
  ]
}
```

The canonical form is sorted by stable field identity. For tree reviews the
identity includes the logical node identity and field identity, so two issues
with the same field name cannot collide. The server validates that the map is
an exact one-to-one coverage of the visible authoritative changed-field set:
no missing fields, duplicates, unknown fields, or extra fields.

The field map is included in the challenge operation-plan hash and in the
audited approval payload. The server never trusts the labels, before/after
values, counts, or field list returned by the browser; it re-reads the
current evidence and baseline values before applying anything.

The approval/decision domain gains a first-class mixed decision rather than
pretending a mixed operation was a whole-set Approve or Reject. The record
retains the original policy, assurance level, signer, evidence hash, baseline
version, canonical decision map, and per-field outcome summary.

## Server flow

### Challenge

1. Receive `intent: DRIFT_MIXED`, evidence hash, and decision map.
2. Authenticate the caller's identity and resolve the immutable baseline
   policy exactly as the existing drift challenge does.
3. Recompute the authoritative current drift projection and validate exact
   field coverage and per-field restoratability.
4. Build a deterministic mixed operation plan containing the approved fields,
   rejected fields, restore strategies, and the baseline/candidate hashes.
5. Store the challenge with the existing five-minute expiry, required
   assurance, signer identity, candidate hash, and operation-plan hash.

No provider call, Jira write, restore lock, baseline publication, or approval
record occurs during challenge creation.

### Authenticated submit

1. Load and consume the pending challenge only after identity, expiry, issue
   binding, evidence hash, policy, and operation-plan hash all match.
2. Verify the configured TOTP or WebAuthn provider using the same binding and
   affirmation rules as the existing ceremony.
3. Acquire the existing per-item decision lock and re-read the issue,
   baseline, evidence, edit metadata, tree, and decision map.
4. Refuse if the content, changed-field set, field configuration, policy,
   baseline version, or restorable target changed after the challenge.
5. Persist the authenticated mixed approval and its canonical field map/audit
   payload before starting mutations.
6. Restore only the fields marked Reject. The restore plan must be scoped to
   those field identities, including attachment/link/tree handlers and their
   existing preflight and verification rules.
7. Re-read the issue/tree after the restore. If any rejected field is not at
   its approved value, do not publish a clean baseline. Keep the item in the
   existing partial/error/drift state that accurately describes the failure.
8. Capture and publish a new baseline from the resulting state. This baseline
   contains the retained current values for fields marked Approve and the
   restored approved values for fields marked Reject. It must preserve the
   baseline policy lineage and record the mixed approval as its provenance.
9. Mark only the drift covered by the authenticated map decided. Any
   unexpected or unverifiable drift remains outstanding and continues to block
   controlled transitions.
10. Release the lock, emit the normal refresh event, and return the receipt
    summary. A queue or vault failure remains represented by its existing
    durable operational state; it cannot turn into an unverified success.

The implementation must choose one durable operation boundary for the
restore-plus-capture sequence. It must not capture a baseline before the
rejected-field restore is verified, because that would re-approve a value the
reviewer explicitly rejected.

For example, if the active baseline is v2 and six fields drift, with three
approved and three rejected, the three rejected fields are first returned to
their v2 values. The three approved fields retain their current values. The
resulting combined state is captured once as v3; v2 remains immutable history.
If every field is rejected, the operation completes as a whole-set restore and
v2 remains active without creating v3. If every field is approved, the
operation is equivalent to whole-set approval and creates v3 from the current
state. Any failed restore verification prevents v3 from being published.

## Data and API changes

- Add a first-class mixed drift intent to the challenge/submit contract.
- Add a canonical decision-map hash and durable decision-map payload to the
  approval/audit representation. The storage migration must preserve existing
  whole-set records unchanged.
- Extend the operation-plan hash to cover the exact field identities,
  decisions, baseline identity/version, evidence hash, and restore plan.
- Extend the restore planner/executor interfaces to accept a scoped field set
  and reject any request that names a field outside the authoritative diff.
- Extend baseline capture provenance so the next record can explain that its
  state resulted from a mixed drift decision and can expose the field outcome
  summary without treating it as a whole-set approval.
- Keep response projections authorization-filtered. A decision map must never
  reveal hidden descendant issue keys or values outside the reviewer's visible
  tree scope.

## Failure and concurrency rules

- Save changes is not enabled from a held or non-authoritative evidence read.
- A concurrent edit after challenge creation returns the existing stale
  evidence failure and reloads the review; it never applies the old map.
- A duplicate submit, consumed challenge, expired challenge, wrong actor,
  wrong assurance provider, or changed operation plan records no second
  decision.
- A concurrent approval or restore is refused by the existing CAS lock.
- A rejected non-restorable field is refused before authentication is spent.
- A restore that completes only partially remains partial/drifted or failed as
  appropriate, with fresh read-back evidence and retry guidance.
- If baseline publication fails after an authenticated approval, the durable
  approval and operational state must explain that publication is incomplete;
  the UI must not show “changes saved” as a clean result.

## Testing and acceptance

### Pure/backend tests

- canonical decision maps are stable regardless of input order;
- duplicate, unknown, missing, hidden, and out-of-scope field identities are
  refused;
- only restorable fields may be assigned Reject;
- the operation-plan hash changes when any field decision changes;
- whole-set Approve/Reject behavior remains unchanged;
- mixed planning scopes restore only rejected fields;
- mixed apply captures only after rejected-field verification;
- stale evidence, policy changes, replay, wrong actor, wrong provider,
  concurrent lock, and partial restore all fail closed;
- the approval/audit record contains the exact map and outcome counts.

### Frontend tests

- opening View changes hides duplicate whole-set controls inside the diff
  content while the outside actions remain available;
- swipe directions map exactly to Reject and Approve;
- explicit buttons, keyboard actions, reset, and reduced-motion behavior match
  swipe outcomes;
- Save changes remains disabled for loading, failed, ineligible, undecided,
  or non-restorable states;
- the authentication panel opens only after complete field coverage;
- the challenge payload includes the evidence hash and canonical map;
- failed/cancelled authentication leaves choices intact and performs no submit;
- the receipt shows mixed decision counts and field names;
- whole-set actions still open the existing authentication path.

### Verification gates

Local unit/frontend tests, UI build, smoke imports, lint, and diff checks are
separate evidence from Forge deploy/install and fresh Jira acceptance. Live
acceptance must prove both paths on a controlled issue: whole-set decision,
then mixed decision with at least one approved and one rejected field,
followed by fresh Jira read-back of every affected field, baseline version,
drift count, audit record, and controlled-transition blocking/clearance.

## Out of scope

- Changing the configured assurance method or adding a new authenticator.
- Removing whole-set Approve/Reject from the issue panel or queue.
- Treating a client-side swipe as evidence of a server-side write.
- Adding AI to decide field outcomes.
- Changing the meaning of the existing whole-set Reject restore ceremony.
