/** The validator's refusal for a work item held from above: it names the work item to decide (lib/ancestorHold.js). */
export function ancestorDriftMessage(found) {
  return `${found.issueKey}, above this work item, has changed since it was approved, and those changes have not been reviewed. `
    + `This work item cannot move until they are approved or reverted on ${found.issueKey}.`;
}

/**
 * Has Forge refused to act as this person because they never granted the app
 * consent? @forge/api's asUser() throws this for anyone who has not clicked
 * "Allow access" — every new user, on every new site. Forge shows its consent
 * screen only when the error leaves the resolver, so a catch-all that turns it
 * into a message strands the person on "no access" with nothing to click.
 */
export function needsUserConsent(error) {
  return error?.name === 'NEEDS_AUTHENTICATION_ERR';
}

export const DENY = {
  NO_DECISION: 'This transition needs a reviewer\'s approval first. Open the VAtlassian panel on this work item, review the changes, and choose Approve — then run this transition again.',
  DECISION_EXPIRED: 'The review decision expired before this transition was performed. Open the VAtlassian panel and approve again.',
  UNDECIDED_DRIFT: 'This work item has changed since it was approved, and those changes have not been reviewed. Open the VAtlassian panel to see what changed and either approve or revert it.',
  ANCESTOR_DRIFT: 'A work item above this one has changed since it was approved, and those changes have not been reviewed. This work item cannot move until they are approved or reverted there.',
  LINK_DECISION_PENDING: 'This work item has changed since it was approved. A link approved on a linked work item is still being recorded here; if that link was the only change, try again in a few seconds.',
  NOT_ELIGIBLE: 'You are not an eligible reviewer for this work item, so this transition was blocked.',
  ELIGIBILITY_REVOKED: 'The reviewer who approved this transition is no longer eligible to do so, so it was blocked. A current reviewer needs to approve it again.',
  RESTORE_IN_PROGRESS: 'Baseline is currently restoring this work item to its approved state. Wait for that to finish, then try this transition again.',
  ALREADY_DECIDING: 'Another decision on this work item is already in progress. Wait for it to finish, then try again.',
  SERVICE_UNAVAILABLE: 'The signature service could not be reached, so this transition was blocked. No changes were made.',
  MULTI_LINK_FIELD_UNSUPPORTED: 'This work item has more than one tracked link field, so its links cannot be restored automatically. No changes were made. Ask an administrator to track a single link field.',
  RESTORE_STATUS_UNAVAILABLE: 'The work item could not be returned to its approved review status, so no changes were restored. Ask an administrator to check the workflow route.',
  NOT_CONFIGURED: 'This transition is gated but has not been configured. Contact your VAtlassian administrator.',
  LEDGER_UNAVAILABLE: 'The audit ledger could not record this action, so the transition was blocked. No changes were made.',
  NO_PENDING_SIGNATURE: 'This transition requires an electronic signature. Please open the "My Signatures" app from the top navigation bar to sign and complete this transition, or use the VAtlassian panel on the issue.',
  SIGNATURE_EXPIRED: 'Your signature expired before the transition was performed. Please sign again.',
  CONTENT_CHANGED: 'This work item changed after approval. Review the current content and approve again.',
  SEGREGATION_VIOLATION: 'The signer is not eligible to authorise this transition.',
  RECORD_LOCKED: 'This record is locked and cannot be transitioned.',
  RAW_CODE_ON_SCREEN: 'Your authenticator code was typed into an ordinary Jira field, which stores it in this work item\'s history, so this transition was blocked. The electronic signature field is not rendering correctly on this screen — it is most likely the wrong field. Sign from the VAtlassian panel on the work item instead, and report this to your VAtlassian administrator.',
  INSUFFICIENT_ASSURANCE: 'This transition requires stronger approval assurance. Open the VAtlassian panel and approve using the required method.',
  TEST_RUNS_OPEN: 'This test execution cannot be completed while a test run in it is unfinished or a failed run is still waiting for its bug. Open the Test management panel on this execution.',
  CONFIRMATION_REQUIRED: 'Confirm that you reviewed this work item before approving.',
  NEW_EVIDENCE_REQUIRES_APPROVAL: 'This work item changed after you signed. Review the new changes and decide again — the earlier signature does not cover them.',
  NO_SIGNED_CANDIDATE: 'This restore predates candidate capture, so there is no record of what was signed. Review and decide again.',
  WRONG_AUTHENTICATION_METHOD: 'The authentication method you submitted does not match what this transition requires. Use the method configured for this transition.',
  POLICY_CHANGED: 'The approval rule configuration for this transition was modified. Reopen the transition dialog to sign with the current rule.',
  STATUS_CHANGED: 'This work item\'s status no longer matches the starting status configured for this approval rule. Refresh the work item to see current actions.',
  TRANSITION_UNAVAILABLE: 'This transition is not currently available in Jira for this work item\'s status. Refresh the work item; if it is still missing, ask a Jira administrator to check the workflow transition conditions.',
  TRANSITION_MISMATCH: 'The approval rule does not match this Jira workflow transition. Ask a Jira administrator to verify the controlled transition configuration.',
  STALE_EVIDENCE: 'This work item changed while you were reviewing it. Reload it, review the current content, and sign again.',
  NO_BASELINE: 'This work item has not been baselined yet, so there is nothing to review against.',
  BASELINE_POLICY_INCOMPLETE: 'The approved baseline for this work item does not record the rule it was approved under, so it cannot be decided here. Ask your VAtlassian administrator to check this work item.',
  NO_TRACKED_FIELDS: 'No tracked fields are configured for this work item type, so there is nothing to sign. Ask your VAtlassian administrator to configure tracked fields.',
  DISABLED: 'Approvals are turned off for this project. Ask your VAtlassian administrator to enable the project.',
  MISSING_PARENT: 'A work item in this hierarchy references a parent item that is missing or not accessible. The transition was blocked.',
  MISSING_ROOT: 'The root work item for this hierarchy could not be found or has an invalid structure. The transition was blocked.',
  DUPLICATE_NODE: 'Duplicate work items were detected in the hierarchy. The transition was blocked.',
  CYCLE_DETECTED: 'A circular hierarchy was detected in this work item and its children. The transition was blocked.',
  TREE_LIMIT_EXCEEDED: 'The work item hierarchy exceeds the maximum allowed number of items (500). The transition was blocked.',
  TREE_CHANGED_DURING_CAPTURE: 'The work item hierarchy changed while it was being read. Wait a moment and try again.',
  BASELINE_VALUES_REQUIRED: 'Required baseline field values could not be captured for all items in the hierarchy. The transition was blocked.',
  CAPTURE_INCOMPLETE: 'The baseline could not be captured completely, so the transition was blocked. Try again; if it persists, contact your VAtlassian administrator.',
  MIXED_UNAVAILABLE: 'This work item\'s approved record cannot be decided field by field. Approve or reject all changes together instead.',
  DECISION_MAP_INVALID: 'The field decisions were not recognised. Reload the review and choose again. Nothing was signed.',
  DECISION_MAP_MISMATCH: 'The fields you decided no longer match the fields that changed. Reload the review, decide every changed field, and sign again. Nothing was signed.',
  FIELD_NOT_RESTORABLE: 'A field you chose to reject cannot be put back, because its approved value was not kept or Jira cannot currently write it. Approve it, or use the whole-set action. Nothing was signed.',
  MIXED_STRUCTURE_UNSUPPORTED: 'Work items were added, removed or moved, so changes cannot be decided field by field. Approve or reject all changes together instead.',
  SCHEMA_PENDING: 'VAtlassian is finishing an update, so nothing was changed. Try again in a few minutes.',
};
export const DENY_DETAIL = {
  ITEM_NEVER_OBSERVED: 'No electronic signature has been recorded for this work item, so this transition was blocked. If you just entered a code in this dialog and it did not confirm "Signed as …", the signature field is not collecting it — sign from the Electronic Signature panel on the work item instead.',
  NO_CANDIDATE_ROW: 'No review decision was recorded for this specific transition, so it was blocked. A decision is created the moment a reviewer selects Approve in the VAtlassian panel — check that the panel confirmed "Approved by …" before you selected the transition.',
  CANDIDATE_STATE_CONSUMED: 'That approval has already been used. One approval authorises one transition, by design — approve again to perform this one.',
  CANDIDATE_STATE_VOID: 'The approval for this transition was voided, because the work item changed again after it was approved. Review the new changes and approve again.',
  TRANSITION_SCREEN_TOKEN_MISMATCH: 'The signature submitted on this screen does not match the one on record for this transition, so it was blocked. The dialog may have been open since an earlier attempt — close it, reopen the transition, and enter a current code.',
  CAS_LOST_RACE: 'Another attempt at this transition used the approval a moment before this one, so this attempt was blocked. Nothing was changed twice. Approve again if the transition still needs to happen.',
  NO_ELIGIBLE_SIGNER: 'This transition requires an electronic signature, but nobody can currently give one: no active signer holds the role it requires. That is a configuration gap in VAtlassian, not a problem with this work item or with anything you entered, and signing again will not clear it. Ask a VAtlassian administrator to grant the required role to at least one person under Approver roles.',
  ITEM_NEVER_BASELINED: 'Baseline has never recorded an approved version of this work item, so there is nothing for it to gate against. If this transition should be gated, ask your Jira administrator to check the Baseline configuration for this project.',
  DRIFT_OUTSTANDING: 'This work item has unreviewed changes since it was approved. Baseline blocks the transition rather than letting an unapproved version move on. Open the VAtlassian panel, read the summary of what changed, and either approve those changes or revert them.',
  NO_ELIGIBLE_REVIEWER: 'This transition requires a reviewer\'s approval, but nobody can currently give one: no active reviewer holds the role it requires. That is a configuration gap in the Baseline app, not a problem with this work item, and trying again will not clear it. Ask your Jira administrator to grant the required reviewer role to at least one person.',
};
// Signature's object is the shared contract; never the legacy string sentinel.
export const SCREEN_EVIDENCE = Object.freeze({ NO_TOKEN: ' No approval receipt was submitted.', TOKEN_PRESENT: ' An approval receipt was submitted for a different approval.' });
export function requiredRoleClause(role) { return typeof role === 'string' && role.trim() ? ` The required role is "${role.trim()}".` : ''; }
export function driftCountClause(count) { return Number.isInteger(count) && count > 0 ? ` There are ${count} unreviewed changes.` : ''; }
export class FailClosed extends Error {
  constructor(reason, cause) { super(DENY[reason] ?? DENY.SERVICE_UNAVAILABLE); this.reason = reason; this.cause = cause; }
}
