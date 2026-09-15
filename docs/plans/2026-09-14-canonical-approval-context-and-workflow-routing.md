# Canonical approval context and workflow routing

## Goal

Keep baseline drift decisions and ordinary workflow-transition approvals on
their own server-resolved policy paths, while preventing the panel from showing
an authoritative-looking clean state from an indexed drift counter.

## Scope

1. Route an explicit transition request by its exact Jira transition ID even
   when an active baseline exists. Preserve baseline-owned routing when no
   transition is supplied, because that path governs drift approval and
   restoration.
2. Carry the transition-authority flag through every fresh preparation in
   challenge, submit, and apply so a later re-read cannot silently switch back
   to baseline authority.
3. Add regression coverage for a biometric transition after a completed
   baseline, including exact transition binding and provider selection.
4. Make the panel's clean/decision facts wait for a fresh evidence read when a
   baseline exists; label the interim state as checking rather than clean.
5. Verify the focused regression, backend suite, UI tests, and UI build. Keep
   deployment and live Jira acceptance explicitly separate from local results.

## Invariants

- No client-supplied provider or transition fact is trusted without a server
  lookup.
- Drift approval and rejection continue to use the immutable baseline policy.
- A transition that blocks on drift cannot proceed on stale or positive drift.
- Existing user changes in the worktree remain untouched.
