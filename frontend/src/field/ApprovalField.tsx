/**
 * THE TRANSITION-SCREEN SIGNING FORM — the one form behind the Electronic
 * signature field.
 *
 * It looks and reads like the signing sheet on the issue panel: what the
 * signature means, who is signing, then the credential — an authenticator
 * code, or a device check that opens its own small window. Both fields
 * registered in manifest.yml mount this same form, so a signer meets one
 * signing step whatever an administrator put on the screen. It is Custom UI
 * because a device check needs `navigator.credentials`, which UI Kit lacks.
 *
 * ONE EXACT ACTION, NEVER A CHOICE. Jira has already chosen the transition:
 * `context.extension.issueTransition.id`. The server resolves the rule for
 * that id, and this screen shows it as read-only facts. A missing id, more
 * than one matching rule, or a rule for any other transition — including a
 * sibling that reaches the same status — fails closed.
 *
 * THE SUBMITTED VALUE CARRIES NO AUTHORITY. It is a receipt. The approval is
 * recorded server-side first, and src/gate.js finds the row by scanning the
 * modified fields for its 32-hex id — a forged field value has no matching
 * PENDING row and the transition is denied. Never submit the raw code as the
 * field value: gate.js's rawCodeSubmitted() treats a 6-digit value as an
 * authenticator code leaking into the work item's change history and refuses
 * the transition outright.
 */
import { useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/bridge';
import { view } from '@forge/bridge';
import Button from '@atlaskit/button';
import { CodeInput, Field, Loading } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { Avatar } from '../ui/brand';
import { approvalMode } from '../lib/assurance';
import type { AssuranceLevel } from '../lib/assurance';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
import { PROGRESS, transitionScopeLabel } from '../panel/approvalModel';
import { biometricStatus, confirmBiometric, enrolBiometric } from '../panel/deviceAuth';

const CODE_LENGTH = 6;

/** Legible copy for the reasons this screen fails closed outright. */
const FAIL_CLOSED_MESSAGES: Record<string, string> = {
  TRANSITION_ID_REQUIRED: 'This screen could not determine which transition is being performed, so nothing can be signed here. Reopen the transition dialog and try again.',
  ISSUE_REQUIRED: 'This screen could not determine which work item is being transitioned.',
  ISSUE_ACCESS_DENIED: 'This work item could not be read, so nothing can be signed here.'
};
const AMBIGUOUS = 'More than one signing rule matched this exact transition. Ask a Jira administrator to remove the conflicting configuration.';
const MISMATCH = 'The approval rule returned for this screen does not match the transition being performed, so nothing can be signed here. Reopen the transition dialog and try again.';

type Action = {
  transitionId: string; toStatusId?: string; toStatusName?: string | null; name?: string | null; label?: string | null;
  meaning?: string | null; requiredRole?: string | null; requiredAssurance?: AssuranceLevel;
  capturesBaseline?: boolean; anyStatus?: boolean; eligible?: boolean;
};
type SigningContext = {
  actions?: Action[]; transitions?: Action[]; blocker?: string | null; requiredRole?: string | null;
  issue?: { key?: string; summary?: string; statusName?: string }; actorName?: string;
  drift?: { evidenceHash?: string; count?: number; blocked?: boolean; heldBy?: string | null }; error?: string;
  heldBy?: string | null;
};
type Challenge = Result & { challengeId: string; meaning: string; requiredAssurance: AssuranceLevel };
type Submitted = Result & { approvalId: string; printedName?: string; meaning?: string };

/** The one action this screen may sign for `transitionId`, or why none. */
function exactAction(state: SigningContext, transitionId: string): { action: Action | null; blocker: string } {
  if (state.blocker === 'ANCESTOR_DRIFT') {
    const above = state.heldBy ?? state.drift?.heldBy;
    return { action: null, blocker: above
      ? `Transition blocked: ${above}, above this work item, has unreviewed changes since its approved baseline. Approve or reject them on ${above} from the VAtlassian issue panel or My approvals, then reopen this transition.`
      : 'Transition blocked: a work item above this one could not be checked for unreviewed changes. Reopen this transition in a moment.' };
  }
  if (state.blocker === 'UNDECIDED_DRIFT' || state.drift?.blocked === true) {
    return { action: null, blocker: 'Transition blocked: this work item has unreviewed changes since its approved baseline. Review and approve or reject those changes from the VAtlassian issue panel or My approvals, then reopen this transition.' };
  }
  const list = state.actions ?? (state.transitions ?? []).filter(t => t.eligible !== false);
  if (list.length > 1) return { action: null, blocker: AMBIGUOUS };
  if (list.length === 1) {
    return String(list[0].transitionId) === transitionId ? { action: list[0], blocker: '' } : { action: null, blocker: MISMATCH };
  }
  const requiredRole = state.requiredRole ?? (state.transitions ?? []).find(t => t.requiredRole)?.requiredRole;
  const notEligible = state.blocker === 'NOT_ELIGIBLE_FOR_RULE' || (!state.blocker && (state.transitions ?? []).some(t => t.eligible === false));
  if (state.blocker === 'GATE_NOT_ENFORCED') return { action: null, blocker: 'The approval rule exists, but the VAtlassian validator is not attached to this transition in Jira. Ask a Jira administrator to re-attach it.' };
  if (state.blocker === 'WRONG_FIELD_FOR_RULE') return { action: null, blocker: 'This signing form cannot carry out the method this transition requires. Ask an administrator to put the "Electronic signature" field on this transition screen.' };
  if (notEligible) {
    return { action: null, blocker: requiredRole ? `This transition is signed by ${requiredRole}. You do not hold the approver role on this work item.` : 'You do not hold the approver role this transition requires.' };
  }
  return { action: null, blocker: 'No configured approval rule applies to this transition. Ask a Jira administrator to check the controlled transition.' };
}

export default function ApprovalField({ context }: { context?: { extension?: { issue?: { key?: string; id?: string }; issueTransition?: { id?: string | number } } } }) {
  // A custom field in the `issue-transition` experience does not reliably
  // carry extension.issue, so the issue is not required here: readableIssue()
  // in usecases/panelAccess.js falls back to the Forge context server-side.
  const contextKey = context?.extension?.issue?.key;
  const contextId = context?.extension?.issue?.id;
  const rawTransitionId = context?.extension?.issueTransition?.id;
  const transitionId = rawTransitionId == null ? '' : String(rawTransitionId);
  const [resolvedKey, setResolvedKey] = useState<string | undefined>(contextKey);
  const [loaded, setLoaded] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [issue, setIssue] = useState<{ key?: string; summary?: string; statusName?: string } | null>(null);
  const [signerName, setSignerName] = useState<string | null>(null);
  const [evidenceHash, setEvidenceHash] = useState<string | undefined>();
  const [blocker, setBlocker] = useState('');
  const [code, setCode] = useState('');
  const [device, setDevice] = useState<{ enrolled: boolean; usableHere: boolean } | null>(null);
  const [deviceNonce, setDeviceNonce] = useState(0);
  const [progress, setProgress] = useState('');
  const [signed, setSigned] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const lock = useRef(false);

  const level = action?.requiredAssurance;
  const mode = approvalMode(level);
  const busy = progress !== '';

  useEffect(() => {
    let active = true;
    // Whatever this screen showed before is withdrawn, receipt included: a
    // token minted for one action must never travel with another.
    view.submit('');
    setAction(null); setBlocker(''); setCode(''); setSigned(''); setMessage(''); setFailed(false);
    if (!transitionId) {
      setBlocker(FAIL_CLOSED_MESSAGES.TRANSITION_ID_REQUIRED);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    invoke<SigningContext>('signing:context', { issueKey: contextKey, issueId: contextId, transitionId, surface: 'signature-field' })
      .then(state => {
        if (!active) return;
        if (!state?.issue) {
          setBlocker(FAIL_CLOSED_MESSAGES[state?.error ?? ''] ?? state?.error ?? 'Could not load the approval requirement for this transition.');
          setLoaded(true);
          return;
        }
        setIssue(state.issue);
        // The key the server resolved wins: every later call is made with it.
        setResolvedKey(state.issue.key ?? contextKey);
        setSignerName(state.actorName ?? null);
        setEvidenceHash(state.drift?.evidenceHash);
        const resolved = exactAction(state, transitionId);
        setAction(resolved.action);
        setBlocker(resolved.blocker);
        setLoaded(true);
      })
      .catch(e => { if (active) { setFailed(true); setMessage(errorMessage(e)); setLoaded(true); } });
    return () => { active = false; };
  }, [contextKey, contextId, transitionId]);

  // Only asked when the edge actually needs a device, so an authenticator-code
  // transition never waits on a WebAuthn round trip to paint.
  useEffect(() => {
    if (mode !== 'biometric') { setDevice(null); return; }
    let active = true;
    biometricStatus()
      .then(r => { if (active) setDevice(r?.ok ? { enrolled: Boolean(r.enrolled), usableHere: r.usableHere === true } : null); })
      .catch(() => { if (active) setDevice(null); });
    return () => { active = false; };
  }, [mode, deviceNonce]);

  async function record(withCode: string) {
    if (!action || !resolvedKey || lock.current) return;
    lock.current = true;
    setProgress(PROGRESS.preparing); setMessage(''); setFailed(false);
    try {
      const challenge = assertResult(await invoke<Challenge>('approval:challenge', {
        issueKey: resolvedKey, transitionId: action.transitionId, toStatusId: action.toStatusId, intent: 'WORKFLOW',
        decision: 'APPROVE', confirmed: true, expectedEvidenceHash: evidenceHash
      }));
      let webauthn;
      if (approvalMode(challenge.requiredAssurance) === 'biometric') {
        setProgress(PROGRESS.biometric);
        const check = await confirmBiometric({ approvalChallengeId: challenge.challengeId })
          .catch(e => ({ ok: false as const, error: errorMessage(e) }));
        if (!check.ok) { setFailed(true); setMessage(check.error ?? 'The device check did not complete. Nothing has been recorded.'); return; }
        webauthn = check.assertion;
      }
      setProgress(action.capturesBaseline ? PROGRESS.publishing : 'Recording signature');
      const result = assertResult(await invoke<Submitted>('approval:submit', {
        issueKey: resolvedKey, challengeId: challenge.challengeId, confirmed: true, preauthorize: true,
        ...(approvalMode(challenge.requiredAssurance) === 'totp' ? { code: withCode } : {}),
        ...(webauthn ? { webauthn } : {})
      }));
      setSigned(result.approvalId);
      setMessage(`Signed as ${result.printedName ?? signerName ?? 'you'} — ${result.meaning ?? challenge.meaning}`);
      // Submitted as soon as it exists as well as on the dialog's own submit:
      // the blur that carries the value is the same click that presses the
      // transition button, and an async round trip inside it races Jira.
      view.submit(result.approvalId);
    } catch (e) {
      setFailed(true); setMessage(errorMessage(e));
    } finally {
      lock.current = false;
      setCode(''); setProgress('');
    }
  }

  async function setupDevice() {
    if (lock.current) return;
    lock.current = true;
    setProgress('Setting up biometric approval'); setFailed(false); setMessage('');
    try {
      const result = await enrolBiometric();
      if (result.ok === false) { setFailed(true); setMessage(result.error ?? 'The device setup did not complete.'); }
      else { setMessage('This device is registered. You can now confirm the transition with a device check.'); setDeviceNonce(n => n + 1); }
    } catch (e) { setFailed(true); setMessage(errorMessage(e)); } finally { lock.current = false; setProgress(''); }
  }

  function onCode(next: string) {
    setCode(next);
    // A new code withdraws the previous attempt's refusal.
    if (failed) { setFailed(false); setMessage(''); }
  }

  if (!loaded) return <Loading label="Loading this work item…" />;

  const deviceReady = mode !== 'biometric' || device === null || device.usableHere;
  const canSign = Boolean(action) && !busy && deviceReady && (mode !== 'totp' || code.length === CODE_LENGTH);
  return (
    <section className="va-sign va-sign--field" aria-label="Electronic signature">
      <div role="status" aria-live="polite" className="va-secondary">{progress}</div>
      {message && <Notice danger={failed}>{message}</Notice>}
      {blocker && <Notice>{blocker}</Notice>}

      {/* The exact action Jira is performing. There is no selector on this
          surface, even when the issue has other eligible transitions. */}
      {action && !signed && <>
        <p className="va-sign__meaning">{action.meaning ?? 'Approved'}</p>
        <p className="va-secondary">{[issue?.key, transitionScopeLabel(action, issue?.statusName)].filter(Boolean).join(' · ')}</p>
        <div className="va-sign__signer">
          <Avatar name={signerName} size={32} />
          <div className="va-stack va-stack--tight">
            <strong>{signerName ?? 'You'}</strong>
            <span className="va-subtlest">{action.requiredRole ?? 'Approver'}</span>
          </div>
        </div>
        {mode === 'biometric' && device && !device.usableHere && (
          <Notice>
            {device.enrolled
              ? 'Your registered device cannot be used at this address. Register this browser to sign here.'
              : 'This transition is signed with Face ID, Touch ID or Windows Hello. Register this device first.'}
            {' '}<Button isDisabled={busy} onClick={() => void setupDevice()}>{busy ? progress : 'Register this device'}</Button>
          </Notice>
        )}
        {mode === 'totp' && (
          <Field label="Authenticator code">
            <CodeInput value={code} onChange={onCode} disabled={busy} onSubmit={() => { if (canSign) void record(code); }} />
          </Field>
        )}
        <p className="va-sign__fine">
          {mode === 'biometric' ? 'A small window opens for Face ID, Touch ID or Windows Hello. ' : ''}
          Signing records your name, the time and this meaning, and is the equivalent of your handwritten signature.
        </p>
        <div className="va-sign__actions">
          <Button appearance="primary" isDisabled={!canSign} onClick={() => void record(code)}>{busy ? progress : 'Sign'}</Button>
        </div>
      </>}

      {signed && <p className="va-secondary">Signed. Select the transition button below to finish.</p>}
    </section>
  );
}
