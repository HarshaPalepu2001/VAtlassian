export const DENY = {
  NO_DECISION: 'This transition needs a reviewer to approve it first. Open the Approval & Baseline panel on this work item, review the changes, and choose Approve — then run this transition again.',
  DECISION_EXPIRED: 'The review decision expired before this transition was performed. Open the Approval & Baseline panel and approve again.',
  UNDECIDED_DRIFT: 'This work item has changed since it was approved, and those changes have not been reviewed. Open the Approval & Baseline panel to see what changed and either approve or revert it.',
  NOT_ELIGIBLE: 'You are not an eligible reviewer for this work item, so this transition was blocked.',
  ELIGIBILITY_REVOKED: 'The reviewer who approved this transition is no longer eligible to do so, so it was blocked. A current reviewer needs to approve it again.',
  RESTORE_IN_PROGRESS: 'Baseline is currently restoring this work item to its approved state. Wait for that to finish, then try this transition again.',
  SERVICE_UNAVAILABLE: 'The signature service could not be reached, so this transition was blocked. No changes were made.',
  NOT_CONFIGURED: 'This transition is gated but has not been configured. Contact your VAtlassian administrator.',
  LEDGER_UNAVAILABLE: 'The audit ledger could not record this action, so the transition was blocked. No changes were made.',
  NO_PENDING_SIGNATURE: 'This transition requires an electronic signature. Please open the "My Signatures" app from the top navigation bar to sign and complete this transition, or use the Approval & Baseline panel on the issue.',
  SIGNATURE_EXPIRED: 'Your signature expired before the transition was performed. Please sign again.',
  CONTENT_CHANGED: 'This work item changed after approval. Review the current content and approve again.',
  SEGREGATION_VIOLATION: 'The signer is not eligible to authorise this transition.',
  RECORD_LOCKED: 'This record is locked and cannot be transitioned.',
  RAW_CODE_ON_SCREEN: 'Your authenticator code was typed into an ordinary Jira field, which stores it in this work item\'s history, so this transition was blocked. The electronic signature field is not rendering correctly on this screen — it is most likely the wrong field. Sign from the Approval & Baseline panel on the work item instead, and report this to your VAtlassian administrator.',
  INSUFFICIENT_ASSURANCE: 'This transition requires stronger approval assurance. Open Approval & Baseline and approve using the required method.',
  CONFIRMATION_REQUIRED: 'Confirm that you reviewed this work item before approving.',
  NEW_EVIDENCE_REQUIRES_APPROVAL: 'This work item changed after you signed. Review the new changes and decide again — the earlier signature does not cover them.',
  NO_SIGNED_CANDIDATE: 'This restore predates candidate capture, so there is no record of what was signed. Review and decide again.',
};
export const DENY_DETAIL = {
  ITEM_NEVER_OBSERVED: 'No electronic signature has been recorded for this work item, so this transition was blocked. If you just entered a code in this dialog and it did not confirm "Signed as …", the signature field is not collecting it — sign from the Electronic Signature panel on the work item instead.',
  NO_CANDIDATE_ROW: 'No review decision was recorded for this specific transition, so it was blocked. A decision is created the moment a reviewer selects Approve in the Approval & Baseline panel — check that the panel confirmed "Approved by …" before you selected the transition.',
  CANDIDATE_STATE_CONSUMED: 'That approval has already been used. One approval authorises one transition, by design — approve again to perform this one.',
  CANDIDATE_STATE_VOID: 'The approval for this transition was voided, because the work item changed again after it was approved. Review the new changes and approve again.',
  TRANSITION_SCREEN_TOKEN_MISMATCH: 'The signature submitted on this screen does not match the one on record for this transition, so it was blocked. The dialog may have been open since an earlier attempt — close it, reopen the transition, and enter a current code.',
  CAS_LOST_RACE: 'Another attempt at this transition used the approval a moment before this one, so this attempt was blocked. Nothing was changed twice. Approve again if the transition still needs to happen.',
  NO_ELIGIBLE_SIGNER: 'This transition requires an electronic signature, but nobody can currently give one: no active signer holds the role it requires. That is a configuration gap in the Electronic Signatures app, not a problem with this work item or with anything you entered, and signing again will not clear it. Ask your Atlassian administrator to grant the required role to at least one person.',
  ITEM_NEVER_BASELINED: 'Baseline has never recorded an approved version of this work item, so there is nothing for it to gate against. If this transition should be gated, ask your Jira administrator to check the Baseline configuration for this project.',
  DRIFT_OUTSTANDING: 'This work item has unreviewed changes since it was approved. Baseline blocks the transition rather than letting an unapproved version move on. Open the Approval & Baseline panel, read the summary of what changed, and either approve those changes or revert them.',
  NO_ELIGIBLE_REVIEWER: 'This transition requires a reviewer\'s approval, but nobody can currently give one: no active reviewer holds the role it requires. That is a configuration gap in the Baseline app, not a problem with this work item, and trying again will not clear it. Ask your Jira administrator to grant the required reviewer role to at least one person.',
};
// Signature's object is the shared contract; never the legacy string sentinel.
export const SCREEN_EVIDENCE = Object.freeze({ NO_TOKEN: ' No approval receipt was submitted.', TOKEN_PRESENT: ' An approval receipt was submitted for a different approval.' });
export function requiredRoleClause(role) { return typeof role === 'string' && role.trim() ? ` The required role is "${role.trim()}".` : ''; }
export function driftCountClause(count) { return Number.isInteger(count) && count > 0 ? ` There are ${count} unreviewed changes.` : ''; }
export class FailClosed extends Error {
  constructor(reason, cause) { super(DENY[reason] ?? DENY.SERVICE_UNAVAILABLE); this.reason = reason; this.cause = cause; }
}
