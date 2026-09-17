import { view } from '@forge/bridge';
import { useEffect, useRef, useState } from 'react';
import Button from '@atlaskit/button';
import { invoke } from '../../lib/bridge';
import { Affirmation, Badge, Card, CodeInput, Field, Select } from '../../ui/primitives';
import { AssuranceChip, Notice } from '../../ui/feedback';
import { plural } from '../../ui/format';
import { approvalMode } from '../../lib/assurance';
import type { AssuranceLevel } from '../../lib/assurance';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { PanelEvidence, PanelSummary } from '../types';
import {
  PROGRESS, approvalPayload, approvalReady, captureFact, driftFact, movingTo, recordingProgress, resolveSelectedAction,
  restoreStateLabel, transitionApproveLabel, transitionDestination, transitionOptionLabel, transitionScopeLabel
} from '../approvalModel';
import { biometricStatus, confirmBiometric, enrolBiometric } from '../deviceAuth';

type Decision = 'APPROVE' | 'REJECT';
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
const DD = { margin: 0 };

/**
 * `evidence`/`evidenceLoading`/`evidenceError` are the authoritative current
 * record read owned by IssuePanel — see usePanelEvidence.ts. Selection is
 * controlled by the parent when `onSelectTransition` is given; it does not
 * create a competing evidence read.
 */
export default function ApprovalControls({ summary, issueKey, onDone, disabled = false, evidence, evidenceLoading, evidenceError, selectedTransitionId, onSelectTransition }: {
  summary: PanelSummary;
  issueKey?: string;
  onDone: () => Promise<void>;
  disabled?: boolean;
  evidence?: PanelEvidence | null;
  evidenceLoading?: boolean;
  evidenceError?: string;
  selectedTransitionId?: string;
  onSelectTransition?: (transitionId: string) => void;
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
    if (session.generation < 0 || lock.current === session.generation) return null;
    const gen = session.generation;
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
      patch(gen, { challenge: { id: result.challengeId, nonce: result.nonce, decision, expiresAt: result.expiresAt, meaning: result.meaning, requiredAssurance: result.requiredAssurance } });
    } catch (e) {
      patch(gen, { failed: true, message: errorMessage(e) });
    } finally {
      end(gen);
    }
  }

  async function submit() {
    const challenge = session.challenge;
    if (!challenge) return;
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
        if (!check.ok) { patch(gen, { failed: true, message: check.error ?? 'The device check did not complete. Nothing has been recorded.' }); return; }
        webauthn = check.assertion;
        patch(gen, { progress: recording });
      }
      const result = assertResult(await invoke<Result & { approvalId: string; transitioned?: boolean; state?: string; transitionError?: string }>('signature:submit', {
        challengeId: challenge.id, note, confirmed, issueKey: targetKey, ...(mode === 'totp' ? { code } : {}), ...(webauthn ? { webauthn } : {})
      }));
      // The signature is spent either way; it is never offered again.
      if (lock.current === gen) lock.current = null;
      patch(gen, { challenge: null, confirmed: false, note: '', code: '', phase: null, phaseDecision: null, progress: '' });
      if (result.transitioned === false && result.transitionError) {
        setOutcome(result.state === 'PENDING'
          ? { failed: true, message: `${result.transitionError} The approval is recorded; retry the transition when Jira allows it.` }
          : { failed: true, message: `${result.transitionError} A fresh signature may be required.` });
      } else {
        setOutcome({ failed: false, message: challenge.decision === 'APPROVE' ? 'Approval recorded.' : 'Rejection recorded. Check the restoration result below.' });
        view.refresh().catch(() => {});
      }
      await onDone();
    } catch (e) {
      patch(gen, { failed: true, message: errorMessage(e), code: '' });
    } finally {
      end(gen);
    }
  }

  async function setupDevice() {
    const gen = begin('device', 'Setting up biometric approval');
    if (gen === null) return;
    try {
      const result = await enrolBiometric();
      if (result.ok === false) patch(gen, { failed: true, message: result.error ?? 'The device setup did not complete. Nothing has been recorded.' });
      else { patch(gen, { message: 'This device is registered. You can now approve with a biometric check.' }); setDeviceNonce(n => n + 1); }
    } catch (e) {
      patch(gen, { failed: true, message: errorMessage(e) });
    } finally {
      end(gen);
    }
  }

  async function retryTransition() {
    if (!pending?.transitionId) return;
    const gen = begin('retry', movingTo(transitions.find(t => t.transitionId === pending.transitionId)));
    if (gen === null) return;
    try {
      const result = assertResult(await invoke<Result & { transitioned?: boolean; transitionError?: string }>('approval:retryTransition', { issueKey: targetKey, approvalId: pending.approvalId, transitionId: pending.transitionId }));
      if (lock.current === gen) lock.current = null;
      patch(gen, { phase: null, phaseDecision: null, progress: '' });
      if (result.transitioned) { setOutcome({ failed: false, message: 'Transition completed.' }); view.refresh().catch(() => {}); }
      else setOutcome({ failed: true, message: result.transitionError ?? result.message ?? 'Transition is still pending.' });
      await onDone();
    } catch (e) {
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

  // THE SIGNING MOMENT GETS ITS OWN TREATMENT. Once a challenge is open the
  // reviewer is no longer browsing, they are signing.
  if (session.challenge && canSign && mode !== 'unavailable') {
    const decline = session.challenge.decision === 'REJECT';
    return <section className={decline ? 'va-attest va-attest--decline' : 'va-attest'}>
      <div className="va-attest__banner">
        <p className="va-attest__eyebrow">{decline ? 'Rejecting these changes' : 'Approving this work item'}</p>
        <p className="va-attest__meaning">{session.challenge.meaning}</p>
      </div>
      <div className="va-attest__body">
        {selector}
        {liveRegion}
        {session.message && <div style={{ marginBottom: 16 }}><Notice danger={session.failed}>{session.message}</Notice></div>}
        {mode === 'totp' && summary.credentialEnrolled === false && <div style={{ marginBottom: 16 }}><Notice>Enrol your authenticator in Jira personal settings, under VAtlassian authenticator, before signing.</Notice></div>}
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
            </div>
          ) : (
            <div className="va-stack" style={{ marginLeft: 12 }}>
              <span>{reviewingDrift || transition?.capturesBaseline ? 'A recursive baseline will be captured from the approved issue tree.' : 'This transition records the approval without replacing the active baseline.'}</span>
              {transition?.blocksOnDrift && !!summary.baseline && (
                <span className="va-warning-text">This transition is blocked if there are unapproved changes.</span>
              )}
            </div>
          )}
        </div>
        <Affirmation checked={session.confirmed} onChange={confirmed => patch(session.generation, { confirmed })} disabled={busy || disabled}>I have reviewed this work item and the changes shown. My decision will be recorded against my name.</Affirmation>
        {session.confirmed && mode === 'totp' && <div style={{ marginBottom: 16 }}><Field label="Authenticator code"><CodeInput value={session.code} onChange={code => patch(session.generation, { code })} disabled={busy || disabled} onSubmit={() => { if (ready) void submit(); }} /></Field></div>}
        {session.confirmed && mode === 'biometric' && <p className="va-secondary" style={{ marginBottom: 16 }}>Signing opens a separate device window for Face ID, Touch ID, or Windows Hello. Nothing is recorded until that check passes.</p>}
        <div className="va-row">
          <Button appearance={decline ? 'danger' : 'primary'} isDisabled={!ready} onClick={() => void submit()}>{session.phase === 'submit' ? session.progress : decline ? 'Sign and restore' : 'Sign and approve'}</Button>
          <Button appearance="subtle" isDisabled={busy || disabled} onClick={() => patch(session.generation, { challenge: null, message: '', failed: false })}>Cancel</Button>
        </div>
      </div>
    </section>;
  }

  const explanation = noActionExplanation(summary, reviewingDrift);
  const decisionLabel = (decision: Decision, label: string) => session.phase === 'challenge' && session.phaseDecision === decision ? session.progress : label;

  return <Card title="Approval" subtitle={canAct ? 'Your decision is recorded against your name and cannot be edited afterwards.' : undefined}><div className="va-stack">
    {/* Every viewer — eligible or not — sees the exact rule this work item is
        controlled by. Nothing here is hidden behind a disclosure. */}
    <ControlFacts
      summary={summary}
      fromStatusName={fromStatusName}
      authoritativeReady={!summary.baseline || Boolean(evidence) || Boolean(evidenceError)}
    />
    {liveRegion}
    {outcome && <Notice danger={outcome.failed}>{outcome.message}</Notice>}
    {session.message && <Notice danger={session.failed}>{session.message}</Notice>}
    {pending?.state === 'PENDING' && pending.transitionId && (
      <Notice>Approval already recorded. <Button isDisabled={busy || disabled} onClick={() => void retryTransition()}>{session.phase === 'retry' ? session.progress : 'Retry transition'}</Button></Notice>
    )}

    {reviewingDrift ? (
      <p className="va-secondary">Review the tracked changes since baseline. Approving captures a new baseline; rejecting restores the latest baseline.</p>
    ) : transition ? (
      <p className="va-secondary">Sign the configured transition to {transitionDestination(transition)}.</p>
    ) : null}

    {!canAct ? (explanation && <Notice>{explanation}</Notice>) : <>
      {selector}
      {!reviewingDrift && !transition && <p className="va-muted">Choose which transition to approve.</p>}
      {mode === 'unavailable' ? <Notice>This approval provider is not configured. Ask an administrator to configure a supported assurance level.</Notice> : <>
        {mode === 'biometric' && device && !device.usableHere && <Notice>
          {device.enrolled ? 'Your registered device cannot be used at this address. Register this browser before approving.' : 'This transition is signed with a biometric check. Register this device before approving.'}
          {' '}<Button isDisabled={busy || disabled} onClick={() => void setupDevice()}>{session.phase === 'device' ? session.progress : 'Set up biometric approval'}</Button>
        </Notice>}
        <Field label="Decision note" hint="Optional. Stored with the signature.">
          <textarea className="va-input" value={session.note} maxLength={4000} disabled={busy || disabled} onChange={e => patch(session.generation, { note: e.target.value })} rows={3} />
        </Field>
        <div className="va-row">
          {canApproveDecision && (
            <Button appearance="primary" isDisabled={busy || disabled || !deviceReady || driftEvidenceBlocked} onClick={() => void requestChallenge('APPROVE')}>
              {decisionLabel('APPROVE', reviewingDrift ? 'Approve changes' : transitionApproveLabel(transition!))}
            </Button>
          )}
          {canRejectDecision && (
            <Button appearance="danger" isDisabled={busy || disabled || !deviceReady || driftEvidenceBlocked} onClick={() => void requestChallenge('REJECT')}>{decisionLabel('REJECT', 'Reject and restore')}</Button>
          )}
          <span className="va-spacer" />
          <AssuranceChip level={level} />
        </div>
      </>}
    </>}
  </div></Card>;
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

/** The control summary every viewer receives from `panel:getSummary`. */
function ControlFacts({ summary, fromStatusName, authoritativeReady = true }: { summary: PanelSummary; fromStatusName?: string; authoritativeReady?: boolean }) {
  const { baseline, drift, approval, restore } = summary;
  const transitions = summary.transitions ?? [];
  return (
    <dl className="va-stack va-stack--tight" style={DD}>
      <div className="va-row">
        <dt className="va-secondary">Control state</dt>
        <dd className="va-grow" style={DD}>{summary.state} <Badge tone={summary.controlled ? 'brand' : 'neutral'}>{summary.controlled ? 'Controlled' : 'Not controlled'}</Badge></dd>
      </div>
      <div className="va-row">
        <dt className="va-secondary">Current status</dt>
        <dd style={DD}>{fromStatusName ?? 'Not reported'}</dd>
      </div>
      <div className="va-stack va-stack--tight">
        <dt className="va-secondary">Controlled transitions</dt>
        <dd style={DD}>
          {transitions.length ? (
            <ul className="va-stack va-stack--tight" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {transitions.map(t => (
                <li key={t.transitionId} className="va-row">
                  <strong className="va-grow">{transitionScopeLabel(t, fromStatusName)}</strong>
                  <span className="va-secondary">{t.requiredRole ?? 'Any approver role'}</span>
                  <AssuranceChip level={t.requiredAssurance} />
                  <span className="va-secondary">{captureFact(t)}</span>
                  <span className="va-secondary">{driftFact(t)}</span>
                </li>
              ))}
            </ul>
          ) : 'None offered from this status'}
        </dd>
      </div>
      <div className="va-row">
        <dt className="va-secondary">Changes since approval</dt>
        <dd className="va-grow" style={DD}>
          {!baseline ? 'Not tracked until a baseline is captured'
            : !authoritativeReady ? 'Checking the current record…'
            : drift.count ? <>{plural(drift.count, 'change')} to decide{approval.requiredRole ? ` by ${approval.requiredRole}` : ''} {approval.requiredAssurance && <AssuranceChip level={approval.requiredAssurance} />}</>
              : 'None since the latest baseline'}
        </dd>
      </div>
      <div className="va-row">
        <dt className="va-secondary">Restoration</dt>
        <dd style={DD}>{restore ? restoreStateLabel(restore.state) : 'No restoration has run'}</dd>
      </div>
    </dl>
  );
}
