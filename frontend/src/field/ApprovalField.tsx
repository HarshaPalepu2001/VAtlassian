/**
 * THE TRANSITION-SCREEN SIGNING FORM, AS CUSTOM UI.
 *
 * WHY THIS EXISTS ALONGSIDE src/ui-kit/edit.jsx. That field is UI Kit, which
 * renders declaratively on Atlassian's side: it has no DOM, no `window` and no
 * `navigator`, so `navigator.credentials.get()` cannot be called from it at
 * all. A biometric edge on that surface can only ever show a code box, which
 * the server then refuses as INSUFFICIENT_ASSURANCE. Custom UI runs in an
 * iframe, and the ceremony popup escapes it — see the permissions note in
 * manifest.yml.
 *
 * The two fields are separate on purpose. The authenticator-code path through
 * the UI Kit field is in use and is not disturbed by anything here; an
 * administrator puts whichever field on the transition screen matches the
 * assurance that edge requires. This one reads the requirement and serves
 * every level, so it is the safe default for a screen shared by several rules.
 *
 * THE SUBMITTED VALUE CARRIES NO AUTHORITY. It is a receipt. The approval is
 * recorded server-side first, and src/gate.js finds the row by scanning the
 * modified fields for its 32-hex id — a forged field value has no matching
 * PENDING row and the transition is denied. Never submit the raw code as the
 * field value: gate.js's rawCodeSubmitted() treats a 6-digit value as an
 * authenticator code leaking into the work item's change history and refuses
 * the transition outright.
 */
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '../lib/bridge';
import { view } from '@forge/bridge';
import Button from '@atlaskit/button';
import { Affirmation, CodeInput, Field, Loading, Select } from '../ui/primitives';
import { AssuranceChip, Notice } from '../ui/feedback';
import { approvalMode } from '../lib/assurance';
import type { AssuranceLevel } from '../lib/assurance';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
import { biometricStatus, confirmBiometric, enrolBiometric } from '../panel/deviceAuth';

const CODE_LENGTH = 6;

type Option = { transitionId: string; toStatusId?: string; name?: string; meaning?: string; requiredRole?: string; requiredAssurance?: AssuranceLevel; eligible?: boolean };
type Challenge = Result & { challengeId: string; meaning: string; requiredAssurance: AssuranceLevel };
type Submitted = Result & { approvalId: string; printedName?: string; meaning?: string };

export default function ApprovalField({ context }: { context?: { extension?: { issue?: { key?: string; id?: string }; issueTransition?: { id?: string } } } }) {
  // A custom field in the `issue-transition` experience does not reliably
  // carry extension.issue, so neither value is treated as required here. Both
  // are sent, and readableIssue() in usecases/panelAccess.js falls back to the
  // Forge context server-side. Refusing on the client before asking is how
  // this surface previously died with "could not tell which work item".
  const contextKey = context?.extension?.issue?.key;
  const contextId = context?.extension?.issue?.id;
  // Jira's issue-transition field context carries the exact transition the
  // signer is acting on. This is the disambiguator: an administrator places
  // whichever field matches the rule's required assurance on that screen, so
  // the field already knows which transition it is for and must not offer a
  // dropdown to select another one.
  const transitionId = context?.extension?.issueTransition?.id;
  const [resolvedKey, setResolvedKey] = useState<string | undefined>(contextKey);
  const [options, setOptions] = useState<Option[] | null>(null);
  const [selected, setSelected] = useState('');
  const [issue, setIssue] = useState<{ key?: string; summary?: string; statusName?: string } | null>(null);
  const [signerName, setSignerName] = useState<string | null>(null);
  const [evidenceHash, setEvidenceHash] = useState<string | undefined>();
  const [blocker, setBlocker] = useState('');
  const [affirmed, setAffirmed] = useState(false);
  const [code, setCode] = useState('');
  const [device, setDevice] = useState<{ enrolled: boolean; usableHere: boolean } | null>(null);
  const [deviceNonce, setDeviceNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [signed, setSigned] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  const transition = options?.find(o => o.transitionId === selected) ?? options?.[0];
  const level = transition?.requiredAssurance;
  const mode = approvalMode(level);

  useEffect(() => {
    let active = true;
    invoke<{
      actions?: Option[];
      transitions?: Option[];
      blocker?: string | null;
      requiredRole?: string | null;
      issue?: { key?: string; summary?: string; statusName?: string };
      actorName?: string;
      drift?: { evidenceHash?: string };
      error?: string;
    }>('signing:context', { issueKey: contextKey, issueId: contextId, transitionId, surface: 'device-field' })
      .catch(() => invoke<{
        actions?: Option[];
        transitions?: Option[];
        blocker?: string | null;
        requiredRole?: string | null;
        issue?: { key?: string; summary?: string; statusName?: string };
        actorName?: string;
        drift?: { evidenceHash?: string };
        error?: string;
      }>('panel:getState', { issueKey: contextKey, issueId: contextId }))
      .then(state => {
        if (!active) return;
        if (!state?.issue) { setOptions([]); setBlocker(state?.error ?? 'Could not load the approval requirement for this transition.'); return; }
        setIssue(state.issue);
        // The key the server resolved wins: every later call is made with it,
        // so a missing extension.issue on this surface costs nothing.
        setResolvedKey(state.issue.key ?? contextKey);
        setSignerName(state.actorName ?? null);
        setEvidenceHash(state.drift?.evidenceHash);
        const list = state.actions ?? (state.transitions ?? []).filter(t => t.eligible !== false);
        setOptions(list);
        if (list.length === 1) setSelected(list[0].transitionId);
        let blockerMsg = '';
        if (list.length === 0) {
          const reqRole = state.requiredRole ?? (state.transitions ?? []).find(t => t.requiredRole)?.requiredRole;
          const isNotEligible = state.blocker === 'NOT_ELIGIBLE_FOR_RULE' || (!state.blocker && (state.transitions ?? []).some(t => t.eligible === false));
          if (state.blocker === 'GATE_NOT_ENFORCED') {
            blockerMsg = 'The approval rule exists, but the VAtlassian validator is not attached to this transition in Jira. Ask a Jira administrator to re-attach it.';
          } else if (state.blocker === 'WRONG_FIELD_FOR_RULE') {
            blockerMsg = 'This transition is signed with an authenticator code. Ask an administrator to put the "Electronic Signature" field on this transition screen.';
          } else if (isNotEligible) {
            blockerMsg = reqRole
              ? `This transition is signed by ${reqRole}. You do not hold the approver role on this work item.`
              : 'You do not hold the approver role this transition requires.';
          } else {
            blockerMsg = 'No configured approval rule applies to this transition. Ask a Jira administrator to check the controlled transition.';
          }
        }
        setBlocker(blockerMsg);
      })
      .catch(e => { if (active) { setFailed(true); setMessage(errorMessage(e)); } });
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

  // Changing what is being signed withdraws the affirmation and the receipt:
  // an affirmation is a declaration of one statement, and a token minted under
  // the old one must not travel with the new selection.
  useEffect(() => {
    setAffirmed(false); setCode(''); setSigned(''); setMessage(''); setFailed(false);
    view.submit('');
  }, [selected]);

  const record = useCallback(async (withCode: string) => {
    if (!transition || !resolvedKey) return;
    setBusy(true); setMessage(''); setFailed(false);
    try {
      const challenge = assertResult(await invoke<Challenge>('approval:challenge', {
        issueKey: resolvedKey, transitionId: transition.transitionId, toStatusId: transition.toStatusId,
        decision: 'APPROVE', confirmed: true, expectedEvidenceHash: evidenceHash
      }));
      let webauthn;
      if (approvalMode(challenge.requiredAssurance) === 'biometric') {
        const check = await confirmBiometric({ approvalChallengeId: challenge.challengeId })
          .catch(e => ({ ok: false as const, error: errorMessage(e) }));
        if (!check.ok) { setFailed(true); setMessage(check.error ?? 'The device check did not complete. Nothing has been recorded.'); return; }
        webauthn = check.assertion;
      }
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
      setCode(''); setBusy(false);
    }
  }, [transition, resolvedKey, evidenceHash, signerName]);

  async function setupDevice() {
    setBusy(true); setFailed(false); setMessage('');
    try {
      const result = await enrolBiometric();
      if (result.ok === false) { setFailed(true); setMessage(result.error ?? 'The device setup did not complete.'); }
      else { setMessage('This device is registered. You can now confirm the transition with a device check.'); setDeviceNonce(n => n + 1); }
    } catch (e) { setFailed(true); setMessage(errorMessage(e)); } finally { setBusy(false); }
  }

  function onCode(next: string) {
    setCode(next);
    if (next.length === CODE_LENGTH && affirmed && !busy && !signed) void record(next);
  }

  if (options === null) return <Loading label="Loading this work item…" />;

  const deviceReady = mode !== 'biometric' || device === null || device.usableHere;
  return (
    <div className="va-stack">
      <p className="va-secondary">
        {issue?.key ? `${issue.key} — ${issue.summary ?? '(no summary)'}` : 'Approval'}
      </p>
      {message && <Notice danger={failed}>{message}</Notice>}
      {blocker && <Notice>{blocker}</Notice>}

      {options.length > 1 && (
        <Field label="What are you approving?">
          <Select value={selected} placeholder="Choose what you are signing for"
            onChange={setSelected}
            options={options.map(o => ({ value: o.transitionId, label: `${o.meaning ?? 'Approve'} (${o.requiredRole ?? 'approver'} → ${o.name ?? o.toStatusId})` }))} />
        </Field>
      )}

      {transition && !signed && (
        <>
          <div className="va-row">
            <AssuranceChip level={level} />
            <span className="va-secondary">{transition.meaning}</span>
          </div>

          {mode === 'biometric' && device && !device.usableHere && (
            <Notice>
              {device.enrolled
                ? 'Your registered device cannot be used at this address. Register this browser to approve here.'
                : 'This transition is confirmed with a device check. Register this device before approving.'}
              {' '}<Button isDisabled={busy} onClick={setupDevice}>{busy ? 'Setting up…' : 'Set up biometric approval'}</Button>
            </Notice>
          )}

          <Affirmation checked={affirmed} onChange={setAffirmed} disabled={busy || !deviceReady}>
            {`I, ${signerName ?? 'the signer'}, have reviewed ${issue?.key ?? 'this work item'} and I declare: ${transition.meaning ?? 'Approved'}. I am signing as ${transition.requiredRole ?? 'approver'} and I understand this electronic signature is the legally binding equivalent of my handwritten signature.`}
          </Affirmation>

          {affirmed && mode === 'totp' && (
            <Field label="Authenticator code" hint="Checked here and never stored on this work item.">
              <CodeInput value={code} onChange={onCode} disabled={busy} onSubmit={() => { if (code.length === CODE_LENGTH) void record(code); }} />
            </Field>
          )}

          {affirmed && mode === 'biometric' && (
            <div className="va-row">
              <Button appearance="primary" isDisabled={busy || !deviceReady} onClick={() => void record('')}>
                {busy ? 'Confirming…' : 'Confirm with your device'}
              </Button>
              <span className="va-secondary">Opens a separate window for Face ID, Touch ID, or Windows Hello.</span>
            </div>
          )}
        </>
      )}

      {signed && <p className="va-secondary">Select the transition button below to complete it.</p>}
    </div>
  );
}
