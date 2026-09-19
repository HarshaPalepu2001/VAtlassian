import { invoke } from '../lib/bridge';
import type { Result } from '../lib/result';
import { recordHarnessEvent } from '../lib/harness';

type CeremonyAction = 'enrol' | 'confirm';
type WebAuthnStart = Result & { challengeId: string; options: PublicKeyCredentialRequestOptions | PublicKeyCredentialCreationOptions };
type WebAuthnAssertion = { origin: string; challengeId: string; response: unknown };

const POPUP_FEATURES = 'width=460,height=560,menubar=no,toolbar=no,location=no,status=no';

function popupName() {
  return `vatlassian-webauthn-${Date.now().toString(36)}`;
}

function errorWithName(name: string, message?: string) {
  const error = new Error(message || name);
  error.name = name;
  return error;
}

function openCeremonyWindow() {
  const url = new URL('webauthn.html', window.location.href);
  url.searchParams.set('mode', 'webauthn-popup');
  recordHarnessEvent('WEBAUTHN', 'ceremony:openWindow', { url: url.toString() });
  return window.open(url.toString(), popupName(), POPUP_FEATURES);
}

function runInPopup(popup: Window | null, action: CeremonyAction, optionsJSON: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!popup || popup.closed) {
      recordHarnessEvent('WEBAUTHN', 'ceremony:popupBlocked', { action });
      reject(errorWithName('PopupBlockedError', 'The device confirmation window could not be opened.'));
      return;
    }

    let settled = false;
    const finish = (fn: (value: unknown) => void, value: unknown, close = false) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      for (const [target, type] of returnSignals) target.removeEventListener(type, onReturn);
      clearTimeout(deadline);
      if (close) {
        try { popup.close(); } catch { /* already gone */ }
      }
      fn(value);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== popup) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'webauthn-ready') {
        recordHarnessEvent('WEBAUTHN', 'ceremony:handshakeReady', { action });
        popup.postMessage({ type: 'webauthn-options', action, optionsJSON }, window.location.origin);
        return;
      }
      if (data.type === 'webauthn-result') {
        recordHarnessEvent('WEBAUTHN', 'ceremony:result', { action, success: data.success, errorName: data.errorName, errorMessage: data.errorMessage });
        if (data.success) finish(resolve, data.response);
        else finish(reject, errorWithName(data.errorName || 'NotAllowedError', data.errorMessage));
      }
    };

    window.addEventListener('message', onMessage);


    // The device window can be closed without answering. Rather than poll
    // `popup.closed`, check it whenever the reviewer comes back to this frame:
    // focus returning, the tab becoming visible, or a click inside the iframe
    // (focus may land on the top-level Jira page instead). Each return also
    // schedules one follow-up check, because `closed` can lag the focus change.
    const returnSignals: Array<[Window | Document, string]> = [[window, 'focus'], [document, 'visibilitychange'], [document, 'pointerdown']];
    function checkClosed() {
      if (!settled && popup?.closed) finish(reject, errorWithName('NotAllowedError', 'The device confirmation window was closed.'));
    }
    function onReturn() {
      checkClosed();
      if (!settled) setTimeout(checkClosed, 500);
    }
    for (const [target, type] of returnSignals) target.addEventListener(type, onReturn);

    const deadline = setTimeout(() => {
      finish(reject, errorWithName('TimeoutError', 'The device confirmation timed out.'), true);
    }, 100_000);
  });
}

function failureFor(error: unknown, during: CeremonyAction): Result {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'PopupBlockedError':
      return { ok: false, reason: 'POPUP_BLOCKED', error: 'The device confirmation window was blocked. Allow pop-ups for this Jira site and try again.' };
    case 'TimeoutError':
      return { ok: false, reason: 'WEBAUTHN_CHALLENGE_EXPIRED', error: 'The device confirmation timed out. Nothing has been recorded.' };
    case 'InvalidStateError':
      return { ok: false, reason: 'ALREADY_ENROLLED', error: 'This device already has a biometric registration for this app.' };
    case 'NotSupportedError':
    case 'SecurityError':
      return { ok: false, reason: 'WEBAUTHN_UNAVAILABLE', error: 'This browser or device cannot perform biometric approval.' };
    default:
      return during === 'confirm'
        ? { ok: false, reason: 'WEBAUTHN_CREDENTIAL_UNREACHABLE', error: 'The device check did not complete. Either it was cancelled, or this browser has no registration for your account.' }
        : { ok: false, reason: 'CANCELLED', error: 'The device setup was cancelled. Nothing has been recorded.' };
  }
}

function defaultDeviceLabel() {
  const ua = navigator.userAgent || '';
  const browser = ua.includes('Edg/') ? 'Edge' : ua.includes('Chrome/') ? 'Chrome' : ua.includes('Safari/') ? 'Safari' : 'Browser';
  const platform = navigator.platform || 'this device';
  return `${browser} on ${platform}`;
}

export async function biometricStatus() {
  return invoke<Result & { enrolled?: boolean; usableHere?: boolean | null; enrolledElsewhere?: boolean; devices?: unknown[] }>('webauthn:status', {
    origin: window.location.origin,
    userAgent: navigator.userAgent ?? null
  });
}

export async function enrolBiometric() {
  recordHarnessEvent('WEBAUTHN', 'enrol:start');
  const origin = window.location.origin;
  const popup = openCeremonyWindow();
  let start: WebAuthnStart;
  try {
    start = await invoke<WebAuthnStart>('webauthn:enrolStart', {
      origin,
      kind: 'device',
      deviceLabel: defaultDeviceLabel()
    });
  } catch (error) {
    try { popup?.close(); } catch { /* ignore */ }
    recordHarnessEvent('ERROR', 'enrol:start:failed', {}, error);
    throw error;
  }
  if (start.ok === false) {
    try { popup?.close(); } catch { /* ignore */ }
    recordHarnessEvent('ERROR', 'enrol:start:rejected', { reason: start.reason, error: start.error });
    return start;
  }
  try {
    const response = await runInPopup(popup, 'enrol', start.options);
    const finish = await invoke<Result & { enrolled?: boolean }>('webauthn:enrolFinish', {
      origin,
      challengeId: start.challengeId,
      response,
      deviceLabel: defaultDeviceLabel(),
      kind: 'device'
    });
    recordHarnessEvent('WEBAUTHN', 'enrol:finished', { enrolled: finish.enrolled, ok: finish.ok });
    return finish;
  } catch (error) {
    const failure = failureFor(error, 'enrol');
    recordHarnessEvent('ERROR', 'enrol:failed', { reason: failure.reason, error: failure.error }, error);
    return failure;
  }
}

export async function confirmBiometric({ approvalChallengeId }: { approvalChallengeId: string }): Promise<Result & { assertion?: WebAuthnAssertion }> {
  recordHarnessEvent('WEBAUTHN', 'confirm:start', { approvalChallengeId });
  const origin = window.location.origin;
  const popup = openCeremonyWindow();
  let start: WebAuthnStart;
  try {
    start = await invoke<WebAuthnStart>('webauthn:assertStart', { origin, approvalChallengeId });
  } catch (error) {
    try { popup?.close(); } catch { /* ignore */ }
    recordHarnessEvent('ERROR', 'confirm:assertStart:failed', { approvalChallengeId }, error);
    throw error;
  }
  if (start.ok === false) {
    try { popup?.close(); } catch { /* ignore */ }
    recordHarnessEvent('ERROR', 'confirm:assertStart:rejected', { approvalChallengeId, reason: start.reason, error: start.error });
    return start;
  }
  try {
    const response = await runInPopup(popup, 'confirm', start.options);
    recordHarnessEvent('WEBAUTHN', 'confirm:popupAssertionSuccess', { approvalChallengeId, challengeId: start.challengeId });
    return { ok: true, assertion: { origin, challengeId: start.challengeId, response } };
  } catch (error) {
    const failure = failureFor(error, 'confirm');
    recordHarnessEvent('ERROR', 'confirm:failed', { approvalChallengeId, reason: failure.reason, error: failure.error }, error);
    return failure;
  }
}

