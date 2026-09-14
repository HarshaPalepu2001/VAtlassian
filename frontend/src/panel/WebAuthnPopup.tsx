import { useEffect, useState } from 'react';
import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration
} from '@simplewebauthn/browser';
import { Loading, Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';

export default function WebAuthnPopup() {
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<'waiting' | 'prompting'>('waiting');
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const opener = window.opener;
    if (!opener) {
      setError('This window was opened directly. Start the approval from the work item instead.');
      return;
    }
    if (window.location.origin === 'null' || !window.isSecureContext) {
      setError('This confirmation window cannot run a device check from its current address.');
      return;
    }

    let done = false;
    let announceTimer: ReturnType<typeof setTimeout> | undefined;
    let slowTimer: ReturnType<typeof setTimeout> | undefined;

    const stopTimers = () => {
      if (announceTimer) clearTimeout(announceTimer);
      if (slowTimer) clearTimeout(slowTimer);
      announceTimer = undefined;
      slowTimer = undefined;
    };
    const report = (payload: Record<string, unknown>) => {
      if (done) return;
      done = true;
      stopTimers();
      window.removeEventListener('message', onMessage);
      try { opener.postMessage({ type: 'webauthn-result', ...payload }, window.location.origin); }
      catch { /* opener is gone */ }
    };
    const onMessage = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== opener) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data.type !== 'webauthn-options' || done) return;
      stopTimers();
      setSlow(false);
      setPhase('prompting');
      try {
        if (!browserSupportsWebAuthn()) {
          throw Object.assign(new Error('This browser does not support device authentication.'), { name: 'NotSupportedError' });
        }
        if (!(await platformAuthenticatorIsAvailable())) {
          throw Object.assign(new Error('No Face ID, Touch ID, Windows Hello, or device PIN is set up on this machine.'), { name: 'NotSupportedError' });
        }
        const response = data.action === 'enrol'
          ? await startRegistration({ optionsJSON: data.optionsJSON })
          : await startAuthentication({ optionsJSON: data.optionsJSON });
        report({ success: true, response });
        window.close();
      } catch (error) {
        const name = error instanceof Error ? error.name : 'NotAllowedError';
        const message = error instanceof Error ? error.message : 'The device check did not complete.';
        setError(message);
        report({ success: false, errorName: name, errorMessage: message });
        setTimeout(() => window.close(), 4000);
      }
    };

    window.addEventListener('message', onMessage);
    let delay = 50;
    const announce = () => {
      if (done) return;
      try { opener.postMessage({ type: 'webauthn-ready' }, window.location.origin); }
      catch { /* opener is gone */ }
      delay = Math.min(delay * 2, 1000);
      announceTimer = setTimeout(announce, delay);
    };
    announce();
    slowTimer = setTimeout(() => { if (!done) setSlow(true); }, 12_000);

    return () => {
      stopTimers();
      window.removeEventListener('message', onMessage);
    };
  }, []);

  if (error) {
    return (
      <Page title="Device check">
        <Notice danger>{error}</Notice>
        <p className="va-secondary" style={{ marginTop: 12 }}>Nothing has been recorded. This window will close on its own.</p>
      </Page>
    );
  }

  return (
    <Page title="Device check">
      <div className="va-stack" style={{ marginTop: 20 }}>
        <Loading label={phase === 'prompting' ? 'Confirm with Face ID, Touch ID, or Windows Hello' : 'Getting this check ready'} />
        <p className="va-secondary">{phase === 'prompting' ? 'Keep this window open until the check completes.' : 'Keep this window open. The prompt appears in a moment.'}</p>
        {slow && phase === 'waiting' && <Notice>The app is taking longer than usual to prepare this check. Nothing has been recorded yet.</Notice>}
      </div>
    </Page>
  );
}
