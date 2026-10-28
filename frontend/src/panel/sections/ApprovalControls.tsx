import { view } from '@forge/bridge';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Button from '@atlaskit/button';
import { invoke } from '../../lib/bridge';
import { Badge, CodeInput, Field, Select } from '../../ui/primitives';
import { AssuranceChip, Notice } from '../../ui/feedback';
import { Avatar, Icon } from '../../ui/brand';
import { formatTimestamp } from '../../ui/format';
import { plural } from '../../ui/format';
import { approvalMode, assuranceLabel } from '../../lib/assurance';
import type { AssuranceLevel } from '../../lib/assurance';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { PanelEvidence, PanelSummary, RejectedFile } from '../types';
import type { DiffField, DiffItem } from '../../review/types';
import { recordHarnessEvent } from '../../lib/harness';
import type { FieldDecision } from '../approvalModel';
import {
  PROGRESS, approvalPayload, approvalReady, captureFact, driftFact, movingTo, recordingProgress, resolveSelectedAction,
  restoreStateLabel, transitionApproveLabel, transitionDestination, transitionOptionLabel, transitionScopeLabel
} from '../approvalModel';

import { biometricStatus, confirmBiometric, enrolBiometric } from '../deviceAuth';

type Decision = 'APPROVE' | 'REJECT' | 'MIXED';
/** What a signature recorded, kept on screen as the signer's receipt. */
type Receipt = { decision: Decision; meaning: string; note: string; level: AssuranceLevel; at: number; approvalId?: string;
  evidenceHash: string | null; signer: string | null; role: string | null; reviewingDrift: boolean; destination: string | null;
  /** A per-field decision: the fields on each side, by name, and anything the reviewer must be told. */
  mixed?: { approved: string[]; rejected: string[]; notice?: string } };
type Phase = 'challenge' | 'submit' | 'retry' | 'device';
type Challenge = { id: string; nonce: string; decision: Decision; expiresAt: number; meaning: string; requiredAssurance?: AssuranceLevel; linkPolicyNotice?: string;
  /** A per-field decision: the exact map the server was asked about, re-sent verbatim at submit, and the fields it names. */
  decisions?: FieldDecision[]; fields?: DiffField[] };

/**
 * A request to sign a per-field decision, from the review window's Save button.
 * Each new request carries a new `token`. Saving only asks the server for a
 * challenge — which validates the whole map before anything is signed and
 * records nothing — and then opens the same signing sheet every decision uses.
 */
export type MixedRequest = { token: number; decisions: FieldDecision[]; fields: DiffField[] };

/**
 * EVERYTHING GATHERED FOR ONE ACTION — the code, the confirmation, the note,
 * the open challenge, the in-flight phase and its progress copy, and any
 * message. It belongs to exactly one action key and one generation: choosing
 * another action replaces it in the same event, and an async result carrying
 * an older generation is dropped.
 */
type Session = {
  actionKey: string;
  generation: number;
  code: string;
  confirmed: boolean;
  note: string;
  challenge: Challenge | null;
  phase: Phase | null;
  phaseDecision: Decision | null;
  progress: string;
  message: string;
  failed: boolean;
};

const blankSession = (actionKey: string, generation: number): Session => ({
  actionKey, generation, code: '', confirmed: false, note: '', challenge: null,
  phase: null, phaseDecision: null, progress: '', message: '', failed: false
});

const WITHDRAWN = 'The action you selected is no longer available to you. Nothing was signed.';
/** "spec.pdf (VAT-2), data.csv (VAT-3)": each file with the work item it is on. */
const fileList = (files: RejectedFile[]) => files.map(f => f.issueKey ? `${f.filename} (${f.issueKey})` : f.filename).join(', ');

/**
 * `evidence`/`evidenceLoading`/`evidenceError` are the authoritative current
 * record read owned by IssuePanel — see usePanelEvidence.ts. Selection is
 * controlled by the parent when `onSelectTransition` is given; it does not
 * create a competing evidence read.
 */
export default function ApprovalControls({ summary, issueKey, onDone, disabled = false, evidence, evidenceLoading, selectedTransitionId, onSelectTransition, variant = 'panel', onFinished, mixedRequest = null, fieldDecisions, lead }: {
  summary: PanelSummary;
  issueKey?: string;
  onDone: () => Promise<void>;
  disabled?: boolean;
  evidence?: PanelEvidence | null;
  evidenceLoading?: boolean;
  evidenceError?: string;
  /** A previous same-baseline read is still on screen while its replacement
   *  loads. Keeps the facts line steady; never enables a decision. */
  evidenceHeld?: boolean;
  selectedTransitionId?: string;
  onSelectTransition?: (transitionId: string) => void;
  /**
   * Where these controls sit. 'panel' is the issue panel's Approvals section
   * (or, while drift is open, its Baseline card); 'window' is the footer of the
   * review window, which signs in a sheet over the window and ends on a receipt.
   */
  variant?: 'panel' | 'window';
  /** Window only: the reviewer chose Save on their field-by-field decisions. */
  mixedRequest?: MixedRequest | null;
  /** Window only: the reviewer closed the receipt. */
  onFinished?: () => void;
  /** Window only, field by field: the running count and the one Sign button that signs every choice. */
  fieldDecisions?: { text: string; enabled: boolean; reason: string; onSave: () => void };
  /** Panel only, while drift is open: what sits at the start of the decision row (Review changes). */
  lead?: ReactNode;
}) {
  const transitions = summary.transitions ?? [];
  const fromStatusName = summary.issue?.status?.name;
  const targetKey = issueKey ?? summary.issue?.key;
  const [internalSelection, setInternalSelection] = useState('');
  const selectedId = selectedTransitionId ?? internalSelection;
  const setSelection = onSelectTransition ?? setInternalSelection;
  const { reviewingDrift, eligible, transition, actionKey } = resolveSelectedAction(summary, selectedId);

  const generation = useRef(0);
  const lock = useRef<number | null>(null);
  const [stored, setStored] = useState<Session>(() => blankSession(actionKey, 0));
  const [outcome, setOutcome] = useState<{ message: string; failed: boolean } | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [device, setDevice] = useState<{ enrolled: boolean; usableHere: boolean } | null>(null);
  const [deviceNonce, setDeviceNonce] = useState(0);

  // Derived rather than synchronised: state gathered for another action is
  // never rendered, even for the one commit before the effect below drops it.
  const session = stored.actionKey === actionKey ? stored : blankSession(actionKey, -1);

  // A remembered selection that is no longer applicable is forgotten, so it
  // cannot silently come back if that transition is offered again later.
  useEffect(() => {
    if (selectedId && !eligible.some(t => t.transitionId === selectedId)) setSelection('');
  }, [selectedId, eligible, setSelection]);

  // A refresh that removes the action — or its eligibility — fails closed:
  // everything gathered for it is discarded, and a reviewer who was part-way
  // through signing is told why it disappeared.
  useEffect(() => {
    if (stored.actionKey === actionKey) return;
    const engaged = stored.actionKey !== '' && Boolean(stored.challenge || stored.confirmed || stored.code || stored.phase);
    generation.current += 1;
    lock.current = null;
    setStored(blankSession(actionKey, generation.current));
    if (engaged) setOutcome({ message: WITHDRAWN, failed: true });
  }, [actionKey, stored]);

  const configuredLevel: AssuranceLevel = (reviewingDrift ? summary.approval.requiredAssurance : transition?.requiredAssurance)
    ?? summary.approval.requiredAssurance ?? 'ESIGNATURE';
  const level = session.challenge?.requiredAssurance ?? configuredLevel;
  const mode = approvalMode(level);

  useEffect(() => {
    if (mode !== 'biometric') { setDevice(null); return; }
    let active = true;
    biometricStatus().then(result => { if (active) setDevice(result?.ok ? { enrolled: Boolean(result.enrolled), usableHere: result.usableHere === true } : null); }).catch(() => { if (active) setDevice(null); });
    return () => { active = false; };
  }, [mode, deviceNonce]);

  const canApproveDecision = reviewingDrift ? summary.drift.canApprove : !!transition;
  const canRejectDecision = reviewingDrift && summary.drift.canReject;
  const canAct = reviewingDrift ? (summary.drift.canApprove || summary.drift.canReject) : eligible.length > 0;
  const busy = session.phase !== null;
  const deviceReady = mode !== 'biometric' || device === null || device.usableHere;
  const canSign = session.challenge?.decision === 'REJECT' ? canRejectDecision : canApproveDecision;
  // Signing with the meaning on screen is the affirmation; there is no separate tick box.
  const ready = approvalReady({ level, code: session.code, confirmed: true, busy: busy || disabled, eligible: canSign });
  const pending = summary.approval.pending;
  const driftEvidenceBlocked = reviewingDrift && (Boolean(evidenceLoading) || !evidence);

  function choose(transitionId: string) {
    recordHarnessEvent('UI', 'select:transition', { transitionId, issueKey: targetKey });
    generation.current += 1;
    lock.current = null;
    setStored(blankSession(resolveSelectedAction(summary, transitionId).actionKey, generation.current));
    setOutcome(null);
    setSelection(transitionId);
  }

  const patch = (gen: number, next: Partial<Session>) => setStored(prev => prev.generation === gen ? { ...prev, ...next } : prev);

  /** Starts an action synchronously — progress shown and duplicates refused
   *  in the same click — or returns null if one is already running. */
  function begin(phase: Phase, progress: string, phaseDecision: Decision | null = null): number | null {
    if (lock.current !== null) return null;
    const gen = generation.current;
    lock.current = gen;
    setOutcome(null);
    patch(gen, { phase, phaseDecision, progress, message: '', failed: false });
    return gen;
  }


  function end(gen: number) {
    if (lock.current === gen) lock.current = null;
    patch(gen, { phase: null, phaseDecision: null, progress: '' });
  }

  async function requestChallenge(decision: Decision, mixed?: MixedRequest) {
    recordHarnessEvent('UI', 'click:requestChallenge', {
      decision,
      reviewingDrift,
      transitionId: reviewingDrift ? undefined : transition?.transitionId,
      issueKey: targetKey,
      note: session.note
    });
    if (driftEvidenceBlocked) return;
    const gen = begin('challenge', PROGRESS.preparing, decision);
    if (gen === null) return;
    try {
      const result = assertResult(await invoke<Result & { challengeId: string; nonce: string; meaning: string; expiresAt: number; requiredAssurance: AssuranceLevel; linkPolicyNotice?: string }>('signature:challenge', approvalPayload({
        issueKey: targetKey,
        transitionId: reviewingDrift ? undefined : transition?.transitionId,
        toStatusId: reviewingDrift ? undefined : transition?.toStatusId,
        intent: mixed ? 'DRIFT_MIXED' : reviewingDrift ? 'DRIFT' : 'WORKFLOW',
        decision: decision === 'MIXED' ? undefined : decision, decisions: mixed?.decisions, code: '', note: session.note, evidenceHash: reviewingDrift ? evidence?.evidenceHash : undefined, confirmed: true, level
      })));
      recordHarnessEvent('UI', 'challenge:received', { challengeId: result.challengeId, requiredAssurance: result.requiredAssurance, issueKey: targetKey });
      patch(gen, { challenge: { id: result.challengeId, nonce: result.nonce, decision, expiresAt: result.expiresAt, meaning: result.meaning, requiredAssurance: result.requiredAssurance,
        linkPolicyNotice: result.linkPolicyNotice,
        ...(mixed ? { decisions: mixed.decisions, fields: mixed.fields } : {}) } });
    } catch (e) {
      recordHarnessEvent('ERROR', 'challenge:failed', { decision, issueKey: targetKey }, e);
      patch(gen, { failed: true, message: errorMessage(e) });
    } finally {
      end(gen);
    }
  }

  // Save, in the review window, opens the signing sheet for the decisions made.
  const handledMixed = useRef(0);
  useEffect(() => {
    if (!mixedRequest || mixedRequest.token === handledMixed.current) return;
    handledMixed.current = mixedRequest.token;
    void requestChallenge('MIXED', mixedRequest);
  }, [mixedRequest?.token]);

  async function submit() {
    const challenge = session.challenge;
    if (!challenge) return;
    recordHarnessEvent('UI', 'click:submitSignature', {
      decision: challenge.decision,
      mode,
      challengeId: challenge.id,
      issueKey: targetKey
    });
    const recording = recordingProgress({ decision: challenge.decision, reviewingDrift, transition });
    const gen = begin('submit', mode === 'biometric' ? PROGRESS.biometric : recording, challenge.decision);
    if (gen === null) return;
    const { code, note } = session;
    const confirmed = true;
    try {
      // The device check happens before anything is recorded: a refusal here
      // leaves the challenge open, records nothing, and notifies nobody.
      let webauthn;
      if (mode === 'biometric') {
        const check = await confirmBiometric({ approvalChallengeId: challenge.id }).catch(e => ({ ok: false as const, error: errorMessage(e) }));
        if (!check.ok) {
          recordHarnessEvent('ERROR', 'submit:biometricCheckFailed', { challengeId: challenge.id, error: check.error, issueKey: targetKey });
          patch(gen, { failed: true, message: check.error ?? 'The device check did not complete. Nothing has been recorded.' });
          return;
        }
        webauthn = check.assertion;
        patch(gen, { progress: recording });
      }
      const result = assertResult(await invoke<Result & { approvalId: string; transitioned?: boolean; state?: string; transitionError?: string; restore?: { state?: string } | null }>('signature:submit', {
        challengeId: challenge.id, note, confirmed, issueKey: targetKey, ...(mode === 'totp' ? { code } : {}), ...(webauthn ? { webauthn } : {}),
        // The same map the challenge validated; the server refuses any other.
        ...(challenge.decision === 'MIXED' ? { decisions: challenge.decisions } : {})
      }));
      recordHarnessEvent('UI', 'submit:recorded', { approvalId: result.approvalId, transitioned: result.transitioned, state: result.state, issueKey: targetKey });
      // The signature is spent either way; it is never offered again.
      if (lock.current === gen) lock.current = null;
      patch(gen, { challenge: null, confirmed: false, note: '', code: '', phase: null, phaseDecision: null, progress: '' });
      if (result.transitioned === false && result.transitionError) {
        setOutcome(result.state === 'PENDING'
          ? { failed: true, message: `${result.transitionError} The approval is recorded; retry the transition when Jira allows it.` }
          : { failed: true, message: `${result.transitionError} A fresh signature may be required.` });
      } else {
        const split = challenge.decision === 'MIXED' ? splitDecisions(challenge.decisions ?? [], challenge.fields ?? []) : null;
        // Decisions are recorded but the restore never started: said plainly, never as a clean save.
        const notice = split && result.restore?.state === 'QUEUING_FAILED'
          ? 'Your decisions are recorded, but the restoration could not be started, so the rejected fields are not yet put back and the new baseline is not published. Use Retry on the restoration.'
          : undefined;
        setOutcome({ failed: Boolean(notice), message: notice ?? (split ? 'Decisions recorded. Check the restoration result below.'
          : challenge.decision === 'APPROVE' ? 'Approval recorded.' : 'Rejection recorded. Check the restoration result below.') });
        setReceipt({ decision: challenge.decision, meaning: challenge.meaning, note: note.trim(), level, at: Date.now(),
          approvalId: result.approvalId, evidenceHash: reviewingDrift ? evidence?.evidenceHash ?? null : null,
          signer: summary.actorName ?? null, role: reviewingDrift ? summary.approval.requiredRole ?? null : transition?.requiredRole ?? null,
          reviewingDrift, destination: transition ? transitionDestination(transition) : null,
          ...(split ? { mixed: { approved: split.approved, rejected: split.rejected, notice } } : {}) });
        view.refresh().catch(() => {});
      }
      await onDone();
    } catch (e) {
      recordHarnessEvent('ERROR', 'submit:failed', { challengeId: challenge.id, issueKey: targetKey }, e);
      patch(gen, { failed: true, message: errorMessage(e), code: '' });
    } finally {
      end(gen);
    }
  }

  async function setupDevice() {
    recordHarnessEvent('UI', 'click:setupDevice', { issueKey: targetKey });
    const gen = begin('device', 'Setting up biometric approval');
    if (gen === null) return;
    try {
      const result = await enrolBiometric();
      if (result.ok === false) {
        recordHarnessEvent('ERROR', 'setupDevice:failed', { error: result.error, issueKey: targetKey });
        patch(gen, { failed: true, message: result.error ?? 'The device setup did not complete. Nothing has been recorded.' });
      } else {
        recordHarnessEvent('UI', 'setupDevice:success', { issueKey: targetKey });
        patch(gen, { message: 'This device is registered. You can now approve with a biometric check.' });
        setDeviceNonce(n => n + 1);
      }
    } catch (e) {
      recordHarnessEvent('ERROR', 'setupDevice:exception', { issueKey: targetKey }, e);
      patch(gen, { failed: true, message: errorMessage(e) });
    } finally {
      end(gen);
    }
  }

  async function retryTransition() {
    if (!pending?.transitionId) return;
    recordHarnessEvent('UI', 'click:retryTransition', {
      approvalId: pending.approvalId,
      transitionId: pending.transitionId,
      issueKey: targetKey
    });
    const gen = begin('retry', movingTo(transitions.find(t => t.transitionId === pending.transitionId)));
    if (gen === null) return;
    try {
      const result = assertResult(await invoke<Result & { transitioned?: boolean; transitionError?: string }>('approval:retryTransition', { issueKey: targetKey, approvalId: pending.approvalId, transitionId: pending.transitionId }));
      recordHarnessEvent('UI', 'retryTransition:result', { transitioned: result.transitioned, error: result.transitionError, issueKey: targetKey });
      if (lock.current === gen) lock.current = null;
      patch(gen, { phase: null, phaseDecision: null, progress: '' });
      if (result.transitioned) { setOutcome({ failed: false, message: 'Transition completed.' }); view.refresh().catch(() => {}); }
      else setOutcome({ failed: true, message: result.transitionError ?? result.message ?? 'Transition is still pending.' });
      await onDone();
    } catch (e) {
      recordHarnessEvent('ERROR', 'retryTransition:exception', { issueKey: targetKey }, e);
      patch(gen, { failed: true, message: errorMessage(e) });
    } finally {
      end(gen);
    }
  }

  const liveRegion = <div role="status" aria-live="polite" className="va-secondary">{session.progress}</div>;
  const selector = !reviewingDrift && eligible.length > 1 && (
    <Field label="Approval transition">
      <Select
        value={transition?.transitionId ?? ''}
        placeholder="Choose a transition"
        disabled={disabled || session.phase === 'submit' || session.phase === 'retry'}
        onChange={choose}
        options={eligible.map(t => ({ value: t.transitionId, label: transitionOptionLabel(t, fromStatusName) }))}
      />
    </Field>
  );

  // THE RECEIPT. In the review window a recorded signature ends on the record
  // of it — who, when, how, what it meant and exactly what it covered — rather
  // than on a toast that disappears. It is what an auditor will later ask for.
  if (variant === 'window' && receipt) {
    return <div className="va-sheet" role="dialog" aria-modal="true"><SignedReceipt receipt={receipt} issueKey={targetKey} onFinished={onFinished} /></div>;
  }

  // THE SIGNING MOMENT. One sheet, the same wherever a signature starts: what
  // it means, who is signing, an optional reason, then the credential. The
  // method is only the last line — a code box, or a note that a device window
  // opens. The hash, method and exact coverage go on the receipt afterwards.
  if (session.challenge && canSign && mode !== 'unavailable') {
    const decline = session.challenge.decision === 'REJECT';
    const mixedSheet = session.challenge.decision === 'MIXED';
    const role = reviewingDrift ? summary.approval.requiredRole : transition?.requiredRole;
    const authors = [...new Set((evidence?.drift?.fields ?? []).flatMap(f => (f.attribution ?? []).map(a => a.authorName).filter(Boolean)))] as string[];
    const ownEdits = reviewingDrift && Boolean(summary.actorName) && authors.includes(summary.actorName!);
    const rejection = evidence?.rejection;
    const signingView = <section className={decline ? 'va-sign va-sign--decline' : 'va-sign'} aria-label={mixedSheet ? 'Sign decisions' : decline ? 'Sign rejection' : 'Sign approval'}>
      <h3 className="va-sign__title">{mixedSheet ? 'Sign decisions' : decline ? 'Sign rejection' : 'Sign approval'}</h3>
      <p className="va-sign__meaning">{session.challenge.meaning}</p>
      {session.challenge.linkPolicyNotice && <p className="va-secondary">{session.challenge.linkPolicyNotice}</p>}
      {mixedSheet && <MixedConsequence decisions={session.challenge.decisions ?? []} fields={session.challenge.fields ?? []} />}
      {decline && (
        <ul className="va-sign__impact">
          <li>The signed values are put back on every changed field.</li>
          {evidenceLoading && !evidence && <li className="va-muted">Loading what this puts back…</li>}
          {!!rejection?.deleteIssueKeys?.length && <li className="va-warning-text">Deletes {rejection.deleteIssueKeys.join(', ')}</li>}
          {!!rejection?.recreateCount && <li className="va-warning-text">Recreates {plural(rejection.recreateCount, 'missing work item')}</li>}
          {!!rejection?.attachments?.deleteFiles?.length && <li className="va-warning-text">Deletes {fileList(rejection.attachments.deleteFiles)}</li>}
          {!!rejection?.attachments?.restoreFiles?.length && <li>Uploads {fileList(rejection.attachments.restoreFiles)} again from the vault</li>}
          {!!rejection?.attachments?.unrestorableFiles?.length && <li className="va-warning-text">Can't bring back {fileList(rejection.attachments.unrestorableFiles)}: no copy is kept</li>}
          {!!rejection?.attachments?.mediaUnknownFiles?.length && <li className="va-warning-text">{fileList(rejection.attachments.mediaUnknownFiles)} come back, but images of them in text may not</li>}
        </ul>
      )}
      {selector}
      {liveRegion}
      {session.message && <Notice danger={session.failed}>{session.message}</Notice>}
      {mode === 'totp' && summary.credentialEnrolled === false && <Notice>Set up your authenticator first: Jira personal settings, then VAtlassian authenticator.</Notice>}
      <div className="va-sign__signer">
        <Avatar name={summary.actorName} size={32} />
        <div className="va-stack va-stack--tight">
          <strong>{summary.actorName ?? 'You'}</strong>
          {role && <span className="va-subtlest">{role}</span>}
        </div>
      </div>
      {ownEdits && <p className="va-warning-text">Some of these changes are yours. That is recorded with your signature.</p>}
      {/* The reason travels with the signature: it is read at submit and stored on the approval. */}
      <Field label="Reason (optional)">
        <textarea className="va-input" value={session.note} maxLength={4000} disabled={busy || disabled} onChange={e => patch(session.generation, { note: e.target.value })} rows={2} />
      </Field>
      {mode === 'totp' && <Field label="Authenticator code"><CodeInput value={session.code} onChange={code => patch(session.generation, { code })} disabled={busy || disabled} onSubmit={() => { if (ready) void submit(); }} /></Field>}
      <p className="va-sign__fine">
        {mode === 'biometric' ? 'A small window opens for Face ID, Touch ID or Windows Hello. ' : ''}
        Your name, the time and this meaning are recorded and can't be changed afterwards.
      </p>
      <div className="va-sign__actions">
        <Button appearance="subtle" isDisabled={busy || disabled} onClick={() => patch(session.generation, { challenge: null, message: '', failed: false })}>Cancel</Button>
        <Button appearance={decline ? 'danger' : 'primary'} isDisabled={!ready} onClick={() => void submit()}>{session.phase === 'submit' ? session.progress : mixedSheet ? 'Sign decisions' : decline ? 'Sign and restore' : 'Sign and approve'}</Button>
      </div>
    </section>;
    return variant === 'window' ? <div className="va-sheet" role="dialog" aria-modal="true">{signingView}</div> : signingView;
  }

  const explanation = noActionExplanation(summary, reviewingDrift);
  const decisionLabel = (decision: Decision, label: string) => session.phase === 'challenge' && session.phaseDecision === decision ? session.progress : label;
  const approveButton = canApproveDecision && (
    <Button appearance="primary" isDisabled={busy || disabled || !deviceReady || driftEvidenceBlocked} onClick={() => void requestChallenge('APPROVE')}>
      {decisionLabel('APPROVE', reviewingDrift ? 'Approve changes' : transitionApproveLabel(transition!))}
    </Button>
  );
  const rejectButton = canRejectDecision && (
    <Button isDisabled={busy || disabled || !deviceReady || driftEvidenceBlocked} onClick={() => void requestChallenge('REJECT')}>{decisionLabel('REJECT', 'Reject and restore')}</Button>
  );
  const providerNotices = <>
    {mode === 'unavailable' && <Notice>This approval provider is not configured. Ask an administrator to configure a supported assurance level.</Notice>}
    {mode === 'biometric' && device && !device.usableHere && <Notice>
      {device.enrolled ? 'Your registered device cannot be used at this address. Register this browser before approving.' : 'This approval is signed with Face ID, Touch ID or Windows Hello. Register this device first.'}
      {' '}<Button isDisabled={busy || disabled} onClick={() => void setupDevice()}>{session.phase === 'device' ? session.progress : 'Register this device'}</Button>
    </Notice>}
  </>;
  const messages = <>
    {liveRegion}
    {outcome && <Notice danger={outcome.failed}>{outcome.message}</Notice>}
    {session.message && <Notice danger={session.failed}>{session.message}</Notice>}
    {pending?.state === 'PENDING' && pending.transitionId && (
      <Notice>Approval already recorded. <Button isDisabled={busy || disabled} onClick={() => void retryTransition()}>{session.phase === 'retry' ? session.progress : 'Retry transition'}</Button></Notice>
    )}
  </>;

  // THE WINDOW'S FOOTER. Field by field, it counts the choices and signs them
  // all at once; otherwise it carries the whole-set decision.
  if (variant === 'window') {
    const byField = reviewingDrift && canAct && fieldDecisions;
    return <div className="va-decision-bar">
      <div className="va-decision-bar__messages">{messages}{!canAct ? (explanation && <Notice>{explanation}</Notice>) : providerNotices}</div>
      <div className="va-decision-bar__row">
        {byField ? <>
          <span className="va-secondary va-grow">{fieldDecisions.text}</span>
          <Button appearance="primary" isDisabled={!fieldDecisions.enabled || busy || disabled || !deviceReady}
            onClick={fieldDecisions.onSave}>{decisionLabel('MIXED', 'Sign decisions')}</Button>
        </> : <>
          <span className="va-secondary va-grow">
            {reviewingDrift ? 'Decide all of these changes together.'
              : transition ? `Approve the move to ${transitionDestination(transition)}.` : 'Choose which transition to approve.'}
          </span>
          {selector}
          {/* Jira puts a window's primary action rightmost — in the markup too,
              so keyboard order matches what the eye sees. */}
          {canAct && mode !== 'unavailable' && <>{rejectButton}{approveButton}</>}
        </>}
      </div>
    </div>;
  }

  // DRIFT, ON THE BASELINE CARD: the whole-set decision beside Review changes.
  if (reviewingDrift) {
    return <div className="va-stack va-stack--tight">
      {messages}
      {canAct && providerNotices}
      <div className="va-row va-decision-row">
        {lead}
        {canAct && mode !== 'unavailable' && <span className="va-decision-row__actions">{rejectButton}{approveButton}</span>}
      </div>
      {!canAct && explanation && <p className="va-subtlest">{explanation}</p>}
    </div>;
  }

  // THE NEXT CONTROLLED MOVE, when nothing is waiting on the baseline.
  if (!transitions.length) return messages;
  return <div className="va-stack va-stack--tight">
    {messages}
    {!canAct ? (explanation && <p className="va-subtlest">{explanation}</p>) : <>
      {selector}
      {providerNotices}
      {mode !== 'unavailable' && <div className="va-row va-decision-row">
        {approveButton}
        <span className="va-spacer" />
        {transition?.requiredRole && <span className="va-subtlest">{transition.requiredRole}</span>}
      </div>}
    </>}
  </div>;
}

/** The fields on each side of a per-field decision, by the names the reviewer read. */
function splitDecisions(decisions: FieldDecision[], fields: DiffField[]) {
  const name = (id: string) => fields.find(f => f.fieldId === id)?.fieldName ?? id;
  return {
    approved: decisions.filter(d => d.decision === 'APPROVE').map(d => name(d.fieldId)),
    rejected: decisions.filter(d => d.decision === 'REJECT').map(d => name(d.fieldId))
  };
}

/** What the receipt claims. It never says a baseline is published until it is: a restoration comes first. */
function mixedHeadline({ approved, rejected }: { approved: string[]; rejected: string[] }): string {
  if (rejected.length === 0) return 'Decisions saved. A new baseline is now the approved record.';
  return approved.length
    ? 'Decisions saved. The rejected fields are being restored; the new baseline is published once they are verified.'
    : 'Decisions saved. The rejected fields are being restored to the approved record.';
}

const fileName = (item: DiffItem) => typeof item === 'string' ? item : item.filename || item.id || 'a file';

/**
 * What signing a per-field decision does, field by field, before it is signed:
 * which are approved, which will be put back, any files that change as a result
 * (derived from the very changes the reviewer was shown), and whether a new
 * baseline version results.
 */
function MixedConsequence({ decisions, fields }: { decisions: FieldDecision[]; fields: DiffField[] }) {
  const { approved, rejected } = splitDecisions(decisions, fields);
  const rejectedFields = decisions.filter(d => d.decision === 'REJECT').map(d => fields.find(f => f.fieldId === d.fieldId)).filter((f): f is DiffField => Boolean(f));
  const deleted = rejectedFields.filter(f => f.kind === 'attachments').flatMap(f => (f.added ?? []).map(fileName));
  const uploaded = rejectedFields.filter(f => f.kind === 'attachments').flatMap(f => (f.removed ?? []).map(fileName));
  return (
    <div className="va-sign__impact va-stack va-stack--tight">
      <span><strong>{plural(approved.length, 'change')} approved:</strong> {approved.join(', ') || 'none'}</span>
      <span><strong>{plural(rejected.length, 'change')} rejected:</strong> {rejected.join(', ') || 'none'}{rejected.length ? ', put back to their signed values' : ''}</span>
      {!!deleted.length && <span className="va-warning-text"><strong>Permanently delete files:</strong> {deleted.join(', ')}</span>}
      {!!uploaded.length && <span><strong>Upload again from the vault:</strong> {uploaded.join(', ')}</span>}
      <span>{approved.length
        ? (rejected.length ? 'A new baseline is captured from the result once every rejected field is verified.' : 'A new baseline is captured from the current content.')
        : 'No new baseline version is created: the work item returns to the baseline it was approved on.'}</span>
    </div>
  );
}


/** "9f3a·c21e" — enough of a hash to compare by eye, the whole of it on hover elsewhere. */
function shortHash(hash: string): string {
  const clean = hash.replace(/[^0-9a-z]/gi, '');
  return clean.length > 10 ? `${clean.slice(0, 4)}·${clean.slice(-4)}` : clean;
}

/**
 * THE SIGNED RECORD, as the signer sees it the moment it is made.
 *
 * Name, date and time (local and UTC), and meaning are the three things 21 CFR
 * 11.50 asks a signature to show; the method, the reason and exactly what was
 * covered are what an auditor asks next. All of it is what was just sent and
 * accepted — nothing here is inferred.
 */
function SignedReceipt({ receipt, issueKey, onFinished }: { receipt: Receipt; issueKey?: string; onFinished?: () => void }) {
  const approved = receipt.decision === 'APPROVE';
  const mixed = receipt.decision === 'MIXED' ? receipt.mixed : undefined;
  const utc = new Date(receipt.at).toISOString().replace('T', ' ').slice(0, 19);
  return <section className="va-receipt" aria-label="Signed record">
    <header className="va-receipt__head">
            <div className="va-stack va-stack--tight">
        <h2 className="va-receipt__title">{mixed ? mixedHeadline(mixed)
          : approved
            ? (receipt.reviewingDrift ? 'Changes approved. A new baseline is now the approved record.' : `Approved${receipt.destination ? ` to ${receipt.destination}` : ''}.`)
            : 'Changes rejected. The approved record is being restored.'}</h2>
        {issueKey && <span className="va-secondary">{issueKey}</span>}
      </div>
    </header>
    <dl className="va-receipt__facts">
      <dt>Decision</dt><dd>{mixed ? 'Saved field decisions' : approved ? 'Approved' : 'Rejected'}</dd>
      {mixed && <>
        <dt>Approved</dt><dd>{mixed.approved.length} · {mixed.approved.join(', ') || 'none'}</dd>
        <dt>Rejected</dt><dd>{mixed.rejected.length} · {mixed.rejected.join(', ') || 'none'}</dd>
      </>}
      <dt>Signed by</dt><dd>{receipt.signer ?? 'You'}{receipt.role ? ` · ${receipt.role}` : ''}</dd>
      <dt>Time</dt><dd><time>{formatTimestamp(receipt.at)}</time> <span className="va-subtlest">· {utc} UTC</span></dd>
      <dt>Method</dt><dd>{assuranceLabel(receipt.level)}</dd>
      <dt>Meaning</dt><dd>{receipt.meaning}</dd>
      <dt>Reason</dt><dd>{receipt.note ? `“${receipt.note}”` : <span className="va-muted">None given</span>}</dd>
      {receipt.evidenceHash && <><dt>Evidence</dt><dd><code className="va-hash" title={receipt.evidenceHash}>{shortHash(receipt.evidenceHash)}</code></dd></>}
      {receipt.approvalId && <><dt>Record</dt><dd><code className="va-hash">{receipt.approvalId}</code> <span className="va-subtlest">· added to the audit ledger</span></dd></>}
    </dl>
    {mixed?.notice && <Notice danger>{mixed.notice}</Notice>}
    <div className="va-row">
      <span className="va-spacer" />
      <Button appearance="primary" onClick={() => onFinished?.()}>Done</Button>
    </div>
  </section>;
}

/** Why a viewer has no enabled decision control, in words that name who can act. */
function noActionExplanation(summary: PanelSummary, reviewingDrift: boolean): string {
  if (reviewingDrift) {
    if (summary.drift.policyIncomplete) return '';
    return `You can see these changes, but only ${summary.approval.requiredRole ?? 'the required role'} can decide them.`;
  }
  const roles = [...new Set((summary.transitions ?? []).map(t => t.requiredRole).filter(Boolean))];
  if (summary.transitions?.length) return `You can see this control, but only ${roles.length ? roles.join(' or ') : 'the required role'} can approve it.`;
  const reason = summary.eligibility?.reason;
  return reason && reason !== 'NOT_ELIGIBLE' ? reason : '';
}

/**
 * The control summary every viewer receives from `panel:getSummary`.
 *
 * Every controlled transition from here is listed as its own row — where it
 * goes, who signs, how, and what it does to the baseline — so an ineligible
 * viewer knows exactly what they are waiting for and an eligible one knows
 * exactly what they are about to sign. While drift is open the rows say they
 * are held, and why, instead of offering a button that would be refused.
 */
/**
 * The Restoration row. A parent's rejection restores each child under the
 * parent's signature, so a child's own restores never mention it: when that is
 * the newest restore to have touched this item, say so, and name the parent.
 */
export function restorationLabel(restore: PanelSummary['restore'], via: PanelSummary['restoredVia']): string {
  const viaIsNewer = via && (!restore || (via.finishedAt ?? 0) > (restore.finishedAt ?? 0));
  if (via && viaIsNewer) {
    const when = formatTimestamp(via.finishedAt);
    return `${restoreStateLabel(via.state)} through ${via.parentIssueKey ?? 'its parent'}'s rejection${when ? ` · ${when}` : ''}`;
  }
  return restore ? restoreStateLabel(restore.state) : 'No restoration has run';
}

/** A parent's rejection that rewrote this work item, when that is the newest restore here; otherwise nothing. */
export function restoredViaLine(summary: PanelSummary): string | null {
  const via = summary.restoredVia;
  if (!via || (summary.restore && (summary.restore.finishedAt ?? 0) >= (via.finishedAt ?? 0))) return null;
  return restorationLabel(summary.restore, via);
}

export function ControlFacts({ summary, fromStatusName, authoritativeReady = true, held = false }: { summary: PanelSummary; fromStatusName?: string; authoritativeReady?: boolean; held?: boolean }) {
  const { baseline, drift, approval, restore } = summary;
  const transitions = summary.transitions ?? [];
  return (
    <dl className="va-facts-grid">
      <dt>Control state</dt>
      <dd>{summary.state} <Badge tone={summary.controlled ? 'brand' : 'neutral'}>{summary.controlled ? 'Controlled' : 'Not controlled'}</Badge></dd>
      <dt>Current status</dt>
      <dd><span className="va-lozenge va-lozenge--progress">{fromStatusName ?? 'Not reported'}</span></dd>
      <dt>Controlled transitions</dt>
      <dd>
        {transitions.length ? (
          <ul className="va-transitions">
            {transitions.map(t => (
              <li key={t.transitionId} className={held ? 'va-transition va-transition--held' : 'va-transition'}>
                <div className="va-transition__main">
                  <strong>{transitionScopeLabel(t, fromStatusName)}</strong>
                  <span className="va-secondary">{[t.requiredRole ?? 'Any approver role', captureFact(t), driftFact()].join(' · ')}</span>
                </div>
                <AssuranceChip level={t.requiredAssurance} />
                {held && t.canApprove && <span className="va-transition__held"><Icon name="lock" size={14} />Held until the changes are decided</span>}
              </li>
            ))}
          </ul>
        ) : 'None offered from this status'}
      </dd>
      <dt>Changes since approval</dt>
      <dd>
        {!baseline ? 'Not tracked until a baseline is captured'
          : !authoritativeReady ? 'Checking the current record…'
          : drift.count ? <>{plural(drift.count, 'change')} to decide{approval.requiredRole ? ` by ${approval.requiredRole}` : ''} {approval.requiredAssurance && <AssuranceChip level={approval.requiredAssurance} />}</>
            : 'None since the latest baseline'}
      </dd>
      <dt>Restoration</dt>
      <dd>{restorationLabel(restore, summary.restoredVia)}</dd>
    </dl>
  );
}
