import { useEffect, useState } from 'react';
import { invoke } from '../lib/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import { QRCodeSVG } from 'qrcode.react';

import { Card, CodeInput, Loading, Page, Stack } from '../ui/primitives';

/**
 * Authenticator enrolment (manifest module va-totp-settings).
 *
 * A credential belongs in personal settings, not on an issue panel. The QR
 * code encodes the TOTP secret, so it is the one thing on any of these
 * screens that genuinely must not be shown to anyone but its owner — it is
 * rendered only during an active enrolment and never persisted in the page.
 */
export default function TotpEnrollment() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [isEnrolled, setIsEnrolled] = useState<boolean | null>(null);
  const [isLocked, setIsLocked] = useState(false);
  const [qrUri, setQrUri] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const checkStatus = async () => {
    try {
      const response = await invoke('totp:checkStatus') as
        { success: boolean; isEnrolled: boolean; state?: string; error?: string };
      if (response.success) {
        setIsEnrolled(response.isEnrolled);
        setIsLocked(response.state === 'LOCKED');
      } else {
        setMessage({ type: 'error', text: response.error || 'Could not check your authenticator.' });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { checkStatus(); }, []);

  const startEnrolment = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await invoke('totp:enrol') as { success: boolean; uri?: string; error?: string };
      if (response.success && response.uri) {
        setQrUri(response.uri);
        setCode('');
      } else {
        setMessage({ type: 'error', text: response.error || 'Could not start enrolment.' });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (code.length !== 6) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await invoke('totp:confirm', { code }) as { success: boolean; error?: string };
      if (response.success) {
        setMessage({ type: 'success', text: 'Your authenticator is set up. You can now sign records.' });
        setQrUri(null);
        setCode('');
        await checkStatus();
      } else {
        setMessage({ type: 'error', text: response.error || 'That code was not accepted. Try the next one your app shows.' });
        setCode('');
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (loading && isEnrolled === null) return <Loading label="Checking your authenticator…" />;

  return (
    <Page
      eyebrow="Approval & baseline"
      title="Your authenticator app"
      lead={
        <>
          Signing a record takes two things: being signed in to Jira, and a six-digit code from
          an authenticator app that only you hold. This page sets up the second one. The codes
          are checked inside Jira — nothing about your credential leaves Atlassian.
        </>
      }
    >
      {message && (
        <div style={{ marginBottom: '20px' }}>
          <SectionMessage appearance={message.type}>
            <p>{message.text}</p>
          </SectionMessage>
        </div>
      )}

      {qrUri ? (
        <Card
          title="Scan this with your authenticator app"
          subtitle="Microsoft Authenticator, Google Authenticator, 1Password or any other TOTP app will work."
        >
          <Stack>
            <ol className="va-steps">
              <li>Open your authenticator app.</li>
              <li>Choose <strong>Add account</strong>, then <strong>Other account</strong>.</li>
              <li>Scan the code below.</li>
              <li>Type the six digits it shows, to prove the setup worked.</li>
            </ol>

            <div className="va-qr">
              <QRCodeSVG value={qrUri} size={190} />
            </div>

            <div className="va-field">
              <span className="va-label">Code from your app</span>
              <CodeInput value={code} onChange={setCode} onSubmit={confirm} disabled={busy} />
              <span className="va-hint">
                Codes change every 30 seconds. If one is rejected, wait for the next.
              </span>
            </div>

            <div className="va-row">
              <Button appearance="primary" isDisabled={busy || code.length !== 6} onClick={confirm}>
                {busy ? 'Checking…' : 'Confirm setup'}
              </Button>
              <Button appearance="subtle" isDisabled={busy} onClick={() => { setQrUri(null); setCode(''); }}>
                Cancel
              </Button>
            </div>
          </Stack>
        </Card>
      ) : isLocked ? (
        <SectionMessage appearance="error" title="Setup is locked">
          <p>
            Too many incorrect codes were entered while confirming this authenticator. Setup is
            locked until an administrator resets it — this is not something you can retry your
            way out of, by design.
          </p>
          <p style={{ marginTop: '12px' }}>
            Ask an VAtlassian administrator to reset it under{' '}
            <strong>Apps → VAtlassian → Lockouts</strong>.
          </p>
        </SectionMessage>
      ) : isEnrolled ? (
        <Stack>
          <SectionMessage appearance="success" title="Your authenticator is active">
            <p>You can sign electronic records. No further setup is needed.</p>
          </SectionMessage>
          <Card
            title="Replace your authenticator"
            subtitle="Do this if you have changed phone, or if you no longer have the app you enrolled with."
          >
            <p className="va-hint" style={{ marginBottom: '14px' }}>
              Setting up a new authenticator replaces the current one. Signatures you have
              already given are unaffected — they are a record of a past act and are never
              re-verified against a credential.
            </p>
            <Button onClick={startEnrolment} isDisabled={busy}>
              {busy ? 'Starting…' : 'Set up a new authenticator'}
            </Button>
          </Card>
        </Stack>
      ) : (
        <Card
          title="You cannot sign yet"
          subtitle="No authenticator app is linked to your account."
        >
          <p className="va-hint" style={{ marginBottom: '14px' }}>
            Until you set one up, work items requiring your signature will keep waiting — the
            signing screens will show you what needs signing but will not accept a signature.
          </p>
          <Button appearance="primary" onClick={startEnrolment} isDisabled={busy}>
            {busy ? 'Starting…' : 'Set up my authenticator'}
          </Button>
        </Card>
      )}
    </Page>
  );
}
