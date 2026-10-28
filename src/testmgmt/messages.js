import { DENY, needsUserConsent } from '../lib/errors.js';
import { retryGuidance } from '../usecases/access.js';

/** What a person is told when test management refuses something. One sentence each, saying what to do. */
export const TM_MESSAGES = {
  NOT_FOUND: 'That work item could not be found, or you cannot see it.',
  NOT_ENABLED: 'Test management is not enabled for this project. A VAtlassian administrator can enable it under Test management.',
  NOT_A_TEST: 'This work item is not a test in this project.',
  NOT_AN_EXECUTION: 'This work item is not a test execution in this project.',
  NO_EDIT_PERMISSION: 'You need permission to edit this work item to do that.',
  STALE: 'Someone else changed this since you opened it. Reload and try again.',
  NO_PARENT: 'This work item has no parent. Test-management work items always sit under a parent (normally the Epic); set one, then try again.',
  NO_STEPS: 'Add at least one step before publishing.',
  STEP_INCOMPLETE: 'Every step needs an action and an expected result before publishing.',
  NO_CHANGES: 'Nothing changed since the latest version, so there is nothing new to publish.',
  NO_SIGNED_VERSION: 'This test has no signed version yet. Only a signed version can be run for the record.',
  NOT_ELIGIBLE: 'You do not hold the role this sign-off step needs.',
  NO_ELIGIBLE_SIGNER: 'Nobody holds a role this sign-off chain needs, so the run cannot be started. Ask a VAtlassian administrator to assign it under Approver roles.',
  STARTER_NOT_ELIGIBLE: 'You do not hold the role for the first sign-off step, so you cannot start this run.',
  NOT_ENOUGH_DISTINCT_SIGNERS: 'This sign-off chain needs different people for each step, and not enough people hold its roles.',
  SAME_SIGNER: 'You already signed an earlier step of this chain. A different person must sign this one.',
  AUTHOR_CANNOT_SIGN: 'You wrote or published this content since it was last signed, so someone else must sign it off.',
  CHANGE_REASON_REQUIRED: 'This result was already recorded. Give a reason for changing it; the earlier result is kept in the history.',
  STEP_HISTORY_FULL: 'This step has already been changed 20 times. Close the run as not executed with a reason and start a new run.',
  RESULTS_TOO_LARGE: 'This run\'s recorded results have reached the size limit. Shorten the actual results or comments, or close the run as not executed and start a new one.',
  RESULT_PENDING: 'A result change is still waiting for its audit record. Refresh in a moment and try again.',
  NOT_A_RECORDER: 'Only someone who recorded results in this run can sign it as executed.',
  CONTENT_CHANGED: 'This changed after you opened it. Review the current content and sign again.',
  ALREADY_SIGNED: 'This step has just been signed by someone else. Reload to see it.',
  SIGNATURE_PENDING: 'A signature is still being recorded. Refresh, or use Finish sign-off to recover the recorded audit event.',
  VERSION_PROOF_INVALID: 'This test version does not have complete, audit-confirmed approval proof. Finish its approval or ask an administrator to investigate.',
  RUN_TOO_LARGE: 'This run is too large to retain safely. Split the dataset into smaller runs.',
  RUN_SETUP_PENDING: 'The run setup is waiting for its audit record. Refresh and use Finish run setup to recover it.',
  IDEMPOTENCY_CONFLICT: 'This retry does not match the original request. Refresh and start a new action.',
  PUBLICATION_PENDING: 'Publishing is waiting for its audit record. Refresh and use Finish version to recover it.',
  RUN_NOT_OPEN: 'This run is no longer open for results.',
  RUN_NOT_SIGNING: 'This run is not waiting for a sign-off.',
  STEPS_NOT_RUN: 'Every step needs a result before the run can be signed. Record the remaining steps, or close the run as not executed.',
  NA_REASON_REQUIRED: 'A step marked Not applicable needs a reason in its comment.',
  RUN_BLOCKED: 'A blocked run cannot be signed. Resume from the blocked step once the cause is removed, or close the run as not executed.',
  RUN_HAS_FAILURE: 'A step of this run failed, and a failure is final, so it cannot be closed as not executed. Record the remaining steps (Blocked where they could not be run) and sign the run off as Failed.',
  REASON_REQUIRED: 'Give a reason.',
  EXECUTION_DONE: 'This execution is already done. Start a new execution to run more tests.',
  EVIDENCE_UNREADABLE: 'That attachment could not be read, so it was not added as evidence.',
  EVIDENCE_TOO_LARGE: 'That attachment is larger than 20 MB, so it was not added as evidence.',
  EVIDENCE_RETENTION_REQUIRED: 'This evidence has no retained copy. Add it again to an open run, or create a new run for a frozen record.',
  EVIDENCE_MISSING: 'Retained evidence is missing. Signing and complete exports are blocked until it is recovered.',
  EVIDENCE_CORRUPT: 'Retained evidence failed its integrity check. Ask an administrator to investigate.',
  RUN_LIST_INCOMPLETE: 'This execution exceeds the complete read limit of 500 runs. Ask an administrator to split future scope and investigate this execution.',
  RECORDS_INCOMPLETE: 'The full record history could not be read. Refresh or ask an administrator to investigate.',
  NOT_A_COLLECTION: 'This work item is not a mapped test plan, test set or precondition.',
  MEMBER_INVALID: 'Every member must be a visible test or precondition in this project.',
  COLLECTION_EMPTY: 'Add at least one test before publishing this collection.',
  PRECONDITION_EMPTY: 'Enter the precondition text before publishing.',
  PRECONDITION_NOT_SIGNED: 'The selected precondition needs a complete signed revision.',
  PLAN_SCOPE_REQUIRED: 'Choose the release, environment and at least one configuration before publishing the plan.',
  PLAN_NOT_SIGNED: 'The plan needs a complete signed revision before it can supply official runs.',
  COLLECTION_NOT_PUBLISHED: 'This collection revision is not waiting for sign-off.',
  SIGNATURE_STATE_PENDING: 'The signature is recorded. Use Finish confirmed sign-off to apply its outcome.',
  PLAN_EXECUTION_SCOPE: 'The plan and execution must be in the same project under the same parent.',
  PLAN_SCOPE_TOO_LARGE: 'This selection would exceed 500 runs in one execution. Split the plan scope or choose another execution.',
  PLANNING_PROOF_UNAVAILABLE: 'The frozen plan or preconditions are unavailable. Review permissions before signing.',
  SOURCE_UNAVAILABLE: 'A source is unavailable or outside this project. Review its Jira permissions.',
  SOURCE_CHANGED: 'A source changed. Review the current baseline before signing.',
  SOURCE_LINK_TYPE_REQUIRED: 'Choose a dedicated Verifies link type under Test management before publishing sources for this Test.',
  SOURCE_LINK_CONFIGURATION_CHANGED: 'The configured Verifies type differs from the signed relationship history. Restore the original mapping before synchronizing.',
  SOURCE_LINK_POLICY_BLOCKED: 'An approved Jira baseline protects these links. A new native approval must permit the relationship before synchronization can continue.',
  SOURCE_LINK_DRIFT: 'The Jira Verifies links differ from the signed scope. Review the manual link changes before synchronizing a new version.',
  SOURCE_LINK_WRITE_PENDING: 'The Test approval is recorded. Its Jira source links are still synchronizing; refresh or use Finish version.',
  SOURCE_LINK_PROOF_UNAVAILABLE: 'The complete Jira link proof could not be confirmed. Governed coverage remains Unknown.',
  SOURCE_LINK_BUSY: 'Another request is synchronizing this Test. Refresh in a moment.',
  TEST_CHANGED: 'The signed test changed. Review its latest approved version before continuing.',
  RUN_NOT_APPLICABLE: 'This run cannot be reused for this source decision. Choose a matching, fully signed run with verified evidence.',
  INVALID_CHAIN: 'The sign-off chain is invalid. Ask a VAtlassian administrator to correct it.',
  SOURCE_DECISION_EXISTS: 'A decision for this source baseline already exists. Open that decision in the history below.',
  EVIDENCE_NOT_ON_EXECUTION: 'Evidence must be an attachment on this test execution. Attach the file to the execution first.',
  INVALID_INPUT: 'Some of the values sent were not valid.',
  VERSION_NOT_PUBLISHED: 'This version is not waiting for sign-off.',
  LEDGER_UNAVAILABLE: DENY.LEDGER_UNAVAILABLE,
  SERVICE_UNAVAILABLE: 'The test-management service could not be reached. Nothing was changed.'
};

export function tmFail(reason) {
  const error = new Error(TM_MESSAGES[reason] ?? reason);
  error.reason = reason;
  error.userMessage = TM_MESSAGES[reason] ?? DENY[reason] ?? undefined;
  throw error;
}

/** Like usecases/access.js#respond, with test-management wording first. */
export async function tmRespond(operation) {
  try { return await operation(); }
  catch (error) {
    // Jira asks this user to allow the app first; the bridge shows that prompt.
    if (needsUserConsent(error)) throw error;
    const reason = error?.reason ?? 'SERVICE_UNAVAILABLE';
    if (!error?.reason) console.error('tm: unexpected error', error);
    return { error: TM_MESSAGES[reason] ?? error.userMessage ?? DENY[reason] ?? TM_MESSAGES.SERVICE_UNAVAILABLE, reason, ...retryGuidance(error) };
  }
}
