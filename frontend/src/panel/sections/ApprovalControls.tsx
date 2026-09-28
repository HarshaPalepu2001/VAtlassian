import { view } from '@forge/bridge';
import { useEffect, useRef, useState } from 'react';
import Button from '@atlaskit/button';
import { invoke } from '../../lib/bridge';
import { Affirmation, Badge, CodeInput, Field, Select } from '../../ui/primitives';
import { AssuranceChip, Notice } from '../../ui/feedback';
import { Icon, Seal } from '../../ui/brand';
import { formatTimestamp } from '../../ui/format';
import { plural } from '../../ui/format';
import { approvalMode, assuranceLabel } from '../../lib/assurance';
import type { AssuranceLevel } from '../../lib/assurance';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { PanelEvidence, PanelSummary, RejectedFile } from '../types';
import { recordHarnessEvent } from '../../lib/harness';
import {
  PROGRESS, approvalPayload, approvalReady, captureFact, driftFact, movingTo, recordingProgress, resolveSelectedAction,
  restoreStateLabel, transitionApproveLabel, transitionDestination, transitionOptionLabel, transitionScopeLabel
} from '../approvalModel';

import { biometricStatus, confirmBiometric, enrolBiometric } from '../deviceAuth';

type Decision = 'APPROVE' | 'REJECT';
/** What a signature recorded, kept on screen as the signer's receipt. */
type Receipt = { decision: Decision; meaning: string; note: string; level: AssuranceLevel; at: number; approvalId?: string;
  evidenceHash: string | null; signer: string | null; role: string | null; reviewingDrift: boolean; destination: string | null };
type Phase = 'challenge' | 'submit' | 'retry' | 'device';
type Challenge = { id: string; nonce: string; decision: Decision; expiresAt: number; meaning: string; requiredAssurance?: AssuranceLevel };

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
export default function ApprovalControls({ summary, issueKey, onDone, disabled = false, evidence, evidenceLoading, evidenceError, evidenceHeld = false, selectedTransitionId, onSelectTransition, variant = 'panel', onFinished }: {
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
  /** Window only: the reviewer closed the receipt. */
  onFinished?: () => void;
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
  const ready = approvalReady({ level, code: session.code, confirmed: session.confirmed, busy: busy || disabled, eligible: canSign });
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

  async function requestChallenge(decision: Decision) {
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
      const result = assertResult(await invoke<Result & { challengeId: string; nonce: string; meaning: string; expiresAt: number; requiredAssurance: AssuranceLevel }>('signature:challenge', approvalPayload({
        issueKey: targetKey,
        transitionId: reviewingDrift ? undefined : transition?.transitionId,
        toStatusId: reviewingDrift ? undefined : transition?.toStatusId,
        intent: reviewingDrift ? 'DRIFT' : 'WORKFLOW',
        decision, code: '', note: session.note, evidenceHash: reviewingDrift ? evidence?.evidenceHash : undefined, confirmed: true, level
      })));
      recordHarnessEvent('UI', 'challenge:received', { challengeId: result.challengeId, requiredAssurance: result.requiredAssurance, issueKey: targetKey });
      patch(gen, { challenge: { id: result.challengeId, nonce: result.nonce, decision, expiresAt: result.expiresAt, meaning: result.meaning, requiredAssurance: result.requiredAssurance } });
    } catch (e) {
      recordHarnessEvent('ERROR', 'challenge:failed', { decision, issueKey: targetKey }, e);
      patch(gen, { failed: true, message: errorMessage(e) });
    } finally {
      end(gen);
    }
  }

  async function submit() {
    const challenge = session.challenge;
    if (!challenge) return;
    recordHarnessEvent('UI', 'click:submitSignature', {
      decision: challenge.decision,
      mode,
      challengeId: challenge.id,
      confirmed: session.confirmed,
      issueKey: targetKey
    });
    const recording = recordingProgress({ decision: challenge.decision, reviewingDrift, transition });
    const gen = begin('submit', mode === 'biometric' ? PROGRESS.biometric : recording, challenge.decision);
    if (gen === null) return;
    const { code, confirmed, note } = session;
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
      const result = assertResult(await invoke<Result & { approvalId: string; transitioned?: boolean; state?: string; transitionError?: string }>('signature:submit', {
        challengeId: challenge.id, note, confirmed, issueKey: targetKey, ...(mode === 'totp' ? { code } : {}), ...(webauthn ? { webauthn } : {})
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
        setOutcome({ failed: false, message: challenge.decision === 'APPROVE' ? 'Approval recorded.' : 'Rejection recorded. Check the restoration result below.' });
        setReceipt({ decision: challenge.decision, meaning: challenge.meaning, note: note.trim(), level, at: Date.now(),
          approvalId: result.approvalId, evidenceHash: reviewingDrift ? evidence?.evidenceHash ?? null : null,
          signer: summary.actorName ?? null, role: reviewingDrift ? summary.approval.requiredRole ?? null : transition?.requiredRole ?? null,
          reviewingDrift, destination: transition ? transitionDestination(transition) : null });
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

  // THE SIGNING MOMENT GETS ITS OWN TREATMENT. Once a challenge is open the
  // reviewer is no longer browsing, they are signing. In the window it is a
  // sheet over everything else; in the panel it replaces these controls.
  if (session.challenge && canSign && mode !== 'unavailable') {
    const decline = session.challenge.decision === 'REJECT';
    const role = reviewingDrift ? summary.approval.requiredRole : transition?.requiredRole;
    const authors = [...new Set((evidence?.drift?.fields ?? []).flatMap(f => (f.attribution ?? []).map(a => a.authorName).filter(Boolean)))] as string[];
    const automated = (evidence?.drift?.fields ?? []).some(f => (f.attribution ?? []).some(a => a.source === 'AUTOMATION'));
    const signingView = <section className={decline ? 'va-attest va-attest--decline' : 'va-attest'} aria-label={decline ? 'Sign and restore' : 'Sign and approve'}>
      <div className="va-attest__banner">
        <p className="va-attest__eyebrow">{decline ? 'Rejecting these changes' : 'Approving this work item'}</p>
        <p className="va-attest__label">What your signature means</p>
        <p className="va-attest__meaning">{session.challenge.meaning}</p>
      </div>
      <div className="va-attest__body">
        {selector}
        {liveRegion}
        {session.message && <div style={{ marginBottom: 16 }}><Notice danger={session.failed}>{session.message}</Notice></div>}
        {mode === 'totp' && summary.credentialEnrolled === false && <div style={{ marginBottom: 16 }}><Notice>Enrol your authenticator in Jira personal settings, under VAtlassian authenticator, before signing.</Notice></div>}
        <ul className="va-checks">
          <li className="va-check va-check--ok"><Icon name="check" />
            <span>Signing as <strong>{summary.actorName ?? 'you'}</strong>{role ? `, ${role}` : ''} — your name goes on the record</span></li>
          {reviewingDrift && evidence?.evidenceHash && (
            <li className="va-check va-check--ok"><Icon name="check" />
              <span>You are deciding exactly the changes you reviewed · evidence <code className="va-hash">{shortHash(evidence.evidenceHash)}</code></span></li>
          )}
          {reviewingDrift && summary.actorName && authors.length > 0 && (authors.includes(summary.actorName)
            ? <li className="va-check va-check--warn"><Icon name="warning" /><span>Some of these edits are yours. Your signature will be recorded alongside them.</span></li>
            : <li className="va-check va-check--ok"><Icon name="check" /><span>Independent review — you made none of these edits</span></li>)}
          {reviewingDrift && automated && (
            <li className="va-check va-check--info"><Icon name="info" /><span>Some edits came from an automation rule and are recorded as such</span></li>
          )}
        </ul>
        <div className="va-attest__consequence">
          <AssuranceChip level={level} />
          {decline ? (
            <div className="va-stack" style={{ marginLeft: 12 }}>
              <span>The governed issue tree will be returned to its approved content.</span>
              {evidenceLoading && !evidence && <span className="va-muted">Loading impact details…</span>}
              {evidenceError && !evidence && <span className="va-muted">Impact details could not be loaded. Signing still restores the approved record.</span>}
              {!!evidence?.rejection?.deleteIssueKeys?.length && (
                <span className="va-warning-text"><strong>Permanently delete:</strong> {evidence.rejection.deleteIssueKeys.join(', ')}</span>
              )}
              {!!evidence?.rejection?.recreateCount && (
                <span className="va-warning-text"><strong>Recreate {evidence.rejection.recreateCount} missing nodes.</strong></span>
              )}
              {!!evidence?.rejection?.attachments?.deleteFiles?.length && (
                <span className="va-warning-text"><strong>Permanently delete files:</strong> {fileList(evidence.rejection.attachments.deleteFiles)}</span>
              )}
              {!!evidence?.rejection?.attachments?.restoreFiles?.length && (
                <span><strong>Upload again from the vault:</strong> {fileList(evidence.rejection.attachments.restoreFiles)}</span>
              )}
              {!!evidence?.rejection?.attachments?.unrestorableFiles?.length && (
                <span className="va-warning-text"><strong>Cannot be restored, no copy in the vault:</strong> {fileList(evidence.rejection.attachments.unrestorableFiles)}</span>
              )}
              {evidence?.rejection?.attachments?.vaultChecked === false && !!evidence.rejection.attachments.restoreFiles.length && (
                <span className="va-muted">The vault could not be checked, so some of these files may not come back.</span>
              )}
            </div>
          ) : (
            <div className="va-stack" style={{ marginLeft: 12 }}>
              <span>{reviewingDrift || transition?.capturesBaseline ? 'A recursive baseline will be captured from the approved issue tree.' : 'This transition records the approval without replacing the active baseline.'}</span>
              {!!summary.baseline && !reviewingDrift && (
                <span className="va-warning-text">This transition is blocked if there are unapproved changes.</span>
              )}
            </div>
          )}
        </div>
        {/* The reason travels with the signature, not ahead of it: it is read
            at submit and stored on the approval, so it belongs where the
            signer is committing rather than on the browsing screen. */}
        <Field label="Reason" hint="Optional. Stored with your signature and shown in the audit trail.">
          <textarea className="va-input" value={session.note} maxLength={4000} disabled={busy || disabled} onChange={e => patch(session.generation, { note: e.target.value })} rows={3} />
        </Field>
        <div className="va-chips" role="group" aria-label="Common reasons">
          {(decline ? REJECT_REASONS : APPROVE_REASONS).map(reason => (
            <button key={reason} type="button" className="va-chip-button" disabled={busy || disabled}
              onClick={() => patch(session.generation, { note: session.note.trim() ? `${session.note.trim()} ${reason}.` : `${reason}.` })}>{reason}</button>
          ))}
        </div>
        <Affirmation checked={session.confirmed} onChange={confirmed => patch(session.generation, { confirmed })} disabled={busy || disabled}>I have reviewed this work item and the changes shown. My decision will be recorded against my name.</Affirmation>
        {session.confirmed && mode === 'totp' && <div style={{ marginBottom: 16 }}><Field label="Authenticator code"><CodeInput value={session.code} onChange={code => patch(session.generation, { code })} disabled={busy || disabled} onSubmit={() => { if (ready) void submit(); }} /></Field></div>}
        {session.confirmed && mode === 'biometric' && <p className="va-secondary" style={{ marginBottom: 16 }}>Signing opens a separate device window for Face ID, Touch ID, or Windows Hello. Nothing is recorded until that check passes.</p>}
        <p className="va-manifest">{summary.actorName ?? 'Your name'} · {formatTimestamp(Date.now())} · {session.challenge.meaning}</p>
        <div className="va-row">
          <Button appearance={decline ? 'danger' : 'primary'} isDisabled={!ready} onClick={() => void submit()}>{session.phase === 'submit' ? session.progress : decline ? 'Sign and restore' : 'Sign and approve'}</Button>
          <Button appearance="subtle" isDisabled={busy || disabled} onClick={() => patch(session.generation, { challenge: null, message: '', failed: false })}>Cancel</Button>
        </div>
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
    <Button appearance="danger" isDisabled={busy || disabled || !deviceReady || driftEvidenceBlocked} onClick={() => void requestChallenge('REJECT')}>{decisionLabel('REJECT', 'Reject and restore')}</Button>
  );
  const decisionButtons = <>{approveButton}{rejectButton}</>;
  const providerNotices = <>
    {mode === 'unavailable' && <Notice>This approval provider is not configured. Ask an administrator to configure a supported assurance level.</Notice>}
    {mode === 'biometric' && device && !device.usableHere && <Notice>
      {device.enrolled ? 'Your registered device cannot be used at this address. Register this browser before approving.' : 'This transition is signed with a biometric check. Register this device before approving.'}
      {' '}<Button isDisabled={busy || disabled} onClick={() => void setupDevice()}>{session.phase === 'device' ? session.progress : 'Set up biometric approval'}</Button>
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

  // THE WINDOW'S FOOTER. One line: what is being decided, how it is signed,
  // and the two buttons — the same decision the panel offers, reachable
  // without closing the review.
  if (variant === 'window') {
    return <div className="va-decision-bar">
      <div className="va-decision-bar__messages">{messages}{!canAct ? (explanation && <Notice>{explanation}</Notice>) : providerNotices}</div>
      <div className="va-decision-bar__row">
        <Icon name="lock" />
        <span className="va-secondary va-grow">
          {reviewingDrift
            ? <>You are deciding exactly these changes{evidence?.evidenceHash ? <> · evidence <code className="va-hash">{shortHash(evidence.evidenceHash)}</code></> : null}</>
            : transition ? <>Sign the configured transition to {transitionDestination(transition)}</> : 'Choose which transition to approve.'}
        </span>
        {selector}
        {canAct && mode !== 'unavailable' && <>
          <AssuranceChip level={level} />
          {(reviewingDrift ? summary.approval.requiredRole : transition?.requiredRole) && <span className="va-subtlest">{reviewingDrift ? summary.approval.requiredRole : transition?.requiredRole}</span>}
          {/* Jira puts a window's primary action rightmost — in the markup too,
              so keyboard order matches what the eye sees. */}
          {rejectButton}{approveButton}
        </>}
      </div>
    </div>;
  }

  // DRIFT, IN THE BASELINE CARD. The drift is flagged where the baseline is,
  // so its decision sits there too; the Approvals section only says what it
  // is waiting for.
  if (reviewingDrift) {
    return <div className="va-stack va-stack--tight">
      {messages}
      {!canAct ? (explanation && <Notice>{explanation}</Notice>) : <>
        {providerNotices}
        {mode !== 'unavailable' && <div className="va-row va-decision-row">
          {decisionButtons}
          <span className="va-spacer" />
          <AssuranceChip level={level} />
        </div>}
      </>}
      <p className="va-subtlest va-footnote">
        <Icon name="lock" size={14} />
        <span>Review the tracked changes since baseline. Approving captures a new baseline; rejecting restores the latest baseline.
          {summary.approval.requiredRole ? ` Decided by ${summary.approval.requiredRole}.` : ''}</span>
      </p>
    </div>;
  }

  return <div className="va-stack">
    {/* Every viewer — eligible or not — sees the exact rule this work item is
        controlled by. Nothing here is hidden behind a disclosure. */}
    <ControlFacts
      summary={summary}
      fromStatusName={fromStatusName}
      authoritativeReady={!summary.baseline || Boolean(evidence) || Boolean(evidenceError) || evidenceHeld}
    />
    {messages}
    {transition && <p className="va-secondary" style={{ margin: 0 }}>Sign the configured transition to {transitionDestination(transition)}.</p>}
    {!canAct ? (explanation && <Notice>{explanation}</Notice>) : <>
      {selector}
      {!transition && <p className="va-muted">Choose which transition to approve.</p>}
      {providerNotices}
      {mode !== 'unavailable' && <div className="va-row va-decision-row">
        {decisionButtons}
        <span className="va-spacer" />
        <AssuranceChip level={level} />
      </div>}
    </>}
  </div>;
}

const APPROVE_REASONS = ['Re-planned with the team', 'Agreed with the product owner', 'Correcting an error'];
const REJECT_REASONS = ['Not agreed with the approver', 'Made outside the change process', 'Made in error'];

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
  const utc = new Date(receipt.at).toISOString().replace('T', ' ').slice(0, 19);
  return <section className="va-receipt" aria-label="Signed record">
    <header className="va-receipt__head">
      <Seal hash={receipt.approvalId ?? receipt.evidenceHash} size={56} tone="success" label="Seal of this signature" />
      <div className="va-stack va-stack--tight">
        <span className="va-receipt__eyebrow">Signed</span>
        <h2 className="va-receipt__title">{approved
          ? (receipt.reviewingDrift ? 'Changes approved. A new baseline is now the approved record.' : `Approved${receipt.destination ? ` to ${receipt.destination}` : ''}.`)
          : 'Changes rejected. The approved record is being restored.'}</h2>
        {issueKey && <span className="va-secondary">{issueKey}</span>}
      </div>
    </header>
    <dl className="va-receipt__facts">
      <dt>Decision</dt><dd>{approved ? 'Approved' : 'Rejected'}</dd>
      <dt>Signed by</dt><dd>{receipt.signer ?? 'You'}{receipt.role ? ` · ${receipt.role}` : ''}</dd>
      <dt>Time</dt><dd><time>{formatTimestamp(receipt.at)}</time> <span className="va-subtlest">· {utc} UTC</span></dd>
      <dt>Method</dt><dd>{assuranceLabel(receipt.level)}</dd>
      <dt>Meaning</dt><dd>{receipt.meaning}</dd>
      <dt>Reason</dt><dd>{receipt.note ? `“${receipt.note}”` : <span className="va-muted">None given</span>}</dd>
      {receipt.evidenceHash && <><dt>Evidence</dt><dd><code className="va-hash" title={receipt.evidenceHash}>{shortHash(receipt.evidenceHash)}</code></dd></>}
      {receipt.approvalId && <><dt>Record</dt><dd><code className="va-hash">{receipt.approvalId}</code> <span className="va-subtlest">· added to the audit ledger</span></dd></>}
    </dl>
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
      <dd>{restore ? restoreStateLabel(restore.state) : 'No restoration has run'}</dd>
    </dl>
  );
}
