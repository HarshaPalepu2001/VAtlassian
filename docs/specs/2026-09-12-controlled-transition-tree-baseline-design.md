# Controlled transition authentication and recursive tree baselines

**Date:** 2026-09-12
**Status:** Approved for implementation
**Extends:** `2026-09-11-workflow-driven-transitions-design.md`

## 1. Objective

Every controlled Jira transition must execute exactly the authentication method
configured on that workflow edge. Electronic signature and biometric approval
must use one server-owned approval lifecycle from the transition screen, issue
panel, and My Approvals. Baseline capture and drift handling remain edge policy
controls: they run only when that controlled transition asks for them.

When a baseline is captured for an issue, the protected object is not only the
root issue. It is the root and its complete native Jira parent-child subtree.
Every node carries the full active controlled-field catalogue (16 fields in the
current configuration), and the parent-child structure is captured alongside
the field values. Restoration is successful only when a fresh Jira read proves
the reconstructed tree and every captured field match the baseline contract.

## 2. Non-negotiable invariants

1. A controlled transition has one valid configured authentication method.
2. The server selects that method from the exact Jira transition id. Clients
   never select, downgrade, or substitute an authentication provider.
3. A challenge and its evidence are bound to the tenant, issue, actor,
   transition id, controlled content, and current baseline version.
4. Baseline capture occurs only when `capture_baseline` is true for that exact
   transition.
5. With no active baseline there is no drift.
6. A published tree baseline is all-or-nothing. Every discovered node, every
   parent edge, and every active controlled field is present, including null or
   empty values.
7. Retained restorable values are mandatory for every field covered by the
   restoration promise. A policy that discards a required value cannot claim
   complete restoration.
8. Rejection never reports `COMPLETE` until Jira has been re-read and the whole
   governed tree verifies. A partial write, permission failure, missing value,
   unsupported field, or digest mismatch ends in a visible non-complete state.
9. Newly added descendants are removed on rejection. A baseline descendant
   that still exists is restored and moved back under its baseline parent when
   necessary; it is never deleted by the new-descendant rule.
10. A hard-deleted baseline descendant may be recreated with equivalent
    controlled content and tree placement, but Jira cannot restore its original
    issue id, key, changelog, or audit history. The replacement mapping is
    permanent audit evidence and the UI must not call it the same Jira object.
    Such a result is `COMPLETE_WITH_REPLACEMENTS`, not identity-exact
    `COMPLETE`.

## 3. Controlled-transition policy and authentication

### 3.1 One exact edge

The policy key is the exact Jira `issueTransition.id` together with the issue's
project, issue type, and source/target statuses. The transition-screen custom
field must pass Jira's extension `issueTransition.id` to the backend. Panel and
My Approvals already start from a selected Jira transition and must pass the
same id.

The backend resolves one policy record and returns a signing context containing
the transition id, meaning, printed actor name, required authentication method,
baseline consequence, and drift consequence. Missing, ambiguous, disabled, or
mismatched policy data fails closed.

### 3.2 One provider dispatcher

Challenge and submit use the same server dispatcher on every surface:

- an electronic-signature policy invokes the electronic-signature provider;
- a biometric policy invokes the WebAuthn provider;
- an unknown or unavailable provider denies the operation;
- evidence from one provider can never satisfy another provider's policy.

There is no weaker-method fallback. The signed approval record preserves the
configured and obtained assurance, provider evidence digest, actor identity,
transition meaning, and exact transition id.

The two Jira transition-screen fields may remain separate because Jira screens
are configured by administrators, but each field is only a presentation shell.
It asks the server for the exact transition context. A field placed on the wrong
kind of controlled transition explains the configuration error and cannot
submit evidence.

## 4. Recursive governed-tree baseline

### 4.1 Boundary

The baseline root is the issue on which the baseline-capturing transition is
approved. Starting at that root, capture every issue reachable through Jira's
native `parent` relationship. Ordinary issue links are controlled separately by
the existing linked-issue field and do not cause linked issues to be recursively
captured.

For every node, record:

- an immutable baseline-local logical node id used during restoration;
- Jira issue id and key at capture time;
- project, issue type, and native parent identity;
- canonical values and digests for the complete active controlled-field
  catalogue selected by the root policy;
- explicit null, empty-array, and not-applicable values;
- a node content digest and capture status.

For the aggregate, record the root, sorted node membership, sorted parent-child
edges, node count, field count, aggregate digest, approval id, assurance,
capture timestamps, and schema version.

### 4.2 Stable capture

Tree discovery and content collection can race Jira edits, so capture uses a
stability check:

1. Discover the complete descendant set and parent map.
2. Read every controlled field for every node.
3. Re-read membership and parent relationships.
4. If the tree changed, discard the unpublished attempt and retry within a
   bounded limit.
5. Persist nodes and values under a `CAPTURING` aggregate.
6. Verify row counts, field counts, and digests before atomically publishing
   `COMPLETE`.

Capture fails closed when traversal is incomplete, permissions hide a node,
the 500-node safety limit is exceeded, a field cannot be represented, value
retention is disabled for a restorable field, or persistence is incomplete. No
partial baseline becomes active.

## 5. Drift semantics

Drift is computed only against an active `COMPLETE` tree baseline. It has four
independent categories:

- `NODE_ADDED`: a descendant absent from the baseline now belongs to the tree;
- `NODE_REMOVED`: Jira no longer returns a baseline descendant by its captured
  issue id;
- `NODE_MOVED`: a baseline descendant still exists but has a different native
  parent, including a move outside the baseline root;
- `FIELD_CHANGED`: a controlled field digest differs on a baseline node.

Each drift row identifies the affected issue, baseline parent, current parent,
field when applicable, old/new digest, materiality, and observation time. The
aggregate drift count shown in the issue panel and My Approvals includes both
structural and field drift. `block_on_drift` continues to decide whether an
edge is blocked; it does not decide whether drift is measured.

## 6. Rejection restoration

Restoration runs under the existing durable operation lock and is resumable.
Before changing Jira it builds a deterministic plan and preflights the required
issue visibility, edit, move, create, transition, and delete permissions.

The plan performs these logical operations:

1. Re-read the current tree and refuse stale approval evidence.
2. Restore controlled fields on baseline nodes that still exist.
3. Move surviving baseline nodes back to their baseline parents.
4. Recreate the controlled content of hard-deleted baseline nodes, parent first,
   and record every logical-node/original-issue/replacement-issue mapping.
5. Delete every post-baseline descendant branch, deepest node first. The delete
   is allowed only after proving that no node in that branch belongs to the
   baseline.
6. Re-read the complete resulting tree, canonicalize every controlled field,
   resolve replacement mappings to their baseline-local logical node ids, and
   verify logical node membership, parent edges, and field digests.

Steps are idempotent and journaled so a retry does not create a second
replacement or delete a baseline node. Destructive deletion is last wherever
dependencies permit. Jira has no transaction spanning all issue operations;
therefore any mid-flight failure remains `ERROR`/`PARTIAL`, retains the lock or
resumable operation record as appropriate, and exposes exact recovery details.
Only full read-back verification releases the item as `BASELINED` with zero
drift. The restore result is `COMPLETE` when every original Jira identity still
exists, or `COMPLETE_WITH_REPLACEMENTS` when the content and logical tree match
but at least one Jira identity had to be replaced.

## 7. User-visible behavior

The transition screen, issue panel, and My Approvals receive the same server
signing context and use the same challenge/submit contract.

- The configured authentication method is named before the user acts.
- Baseline language appears only when that transition captures a baseline.
- The baseline record shows root, node count, edge count, total controlled-field
  count, retained count, assurance, and aggregate digest.
- Drift lists added, removed, moved, and field-changed nodes clearly.
- Reject confirmation names every issue that will be moved, recreated, or
  permanently deleted.
- Replacement issues are shown with their old and new keys.
- The UI never says "restored and verified" for partial, unverified, or
  content-equivalent-without-identity results without explaining the identity
  replacement.

## 8. Error handling and audit

Configuration errors, missing transition ids, unavailable authentication
providers, unstable trees, incomplete captures, stale approvals, permission
failures, unsupported values, failed deletes, failed recreation, and read-back
mismatches use stable machine-readable reason codes. All surfaces translate the
same reason codes into consistent user messages.

The ledger records challenge issuance, provider verification, approval,
baseline capture start/completion/failure, tree drift observations, restoration
plan, each destructive action, replacement mappings, verification, and final
state. Raw authenticator secrets and biometric material are never logged.

## 9. Verification

### 9.1 Automated tests

Add failure-first tests for:

- exact transition-id selection when two outbound edges require different
  authentication methods;
- electronic signature and biometric challenge/submit from each surface;
- conditional baseline capture and no-baseline/no-drift behavior;
- a 16-field root with zero, one, and multiple descendant levels;
- null, empty, ADF, option, user, date, relationship, and unsupported values;
- a concurrent child add/move/delete during capture;
- added descendant deletion on rejection;
- moved descendant restoration;
- deleted baseline descendant replacement and idempotent retry;
- permission denial before and during restoration;
- persistence failure, replayed events, duplicate submit, stale evidence, and
  operation-lock expiry/resume;
- full-tree fresh read-back, proving that one unmatched node or field blocks
  `COMPLETE`;
- consistent consequences and error messages across transition screen, issue
  panel, and My Approvals.

The existing full backend and frontend suites, module-import verification,
TypeScript check, and production bundle must continue to pass.

### 9.2 Live Jira acceptance

Local tests are not completion. After deployment and installation/migration are
verified on the intended tenant, exercise at least these live journeys:

1. Electronic-signature edge without baseline capture.
2. Electronic-signature edge with recursive baseline capture.
3. Biometric edge without baseline capture.
4. Biometric edge with recursive baseline capture.
5. Add and modify descendants, reject, and verify deletion/restoration.
6. Move and hard-delete baseline descendants, reject, and verify move or
   replacement behavior and audit mapping.
7. Repeat applicable actions through transition screen, issue panel, and My
   Approvals.
8. Remove a required permission or provider configuration and prove denial is
   closed, specific, and recoverable.

Deployment, migration, UI rendering, provider ceremony, Jira mutations, ledger
evidence, and final tree read-back are reported separately. No single one is
presented as proof of the others.

## 10. Scope limits

This design covers native Jira parent-child descendants and the active
controlled-field catalogue. Comments, worklogs, attachments, external assets,
and Jira's immutable issue identity/history are not restored unless they are
separately added to the controlled-content model. Ordinary issue links remain a
tracked relationship field and do not recursively import the linked issue's
content.
