import { useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import { QRCodeSVG } from 'qrcode.react';

import { Card, CodeInput, Loading, Page, Stack } from '../ui/primitives';
import { useConfigurationUpdates } from '../lib/configurationUpdates';

/**
 * Authenticator enrolment in personal settings, manifest module va-totp-settings.
 * The QR code contains the TOTP secret. Show it only to its owner during active
 * enrolment and never persist it in the page.
 */
export default function TotpEnrollment() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [isEnrolled, setIsEnrolled] = useState<boolean | null>(null);
  const [isLocked, setIsLocked] = useState(false);
  const [recovery, setRecovery] = useState<Recovery>({ resetGrant: null, administrators: null, onlyAdministrator: false });
  const [qrUri, setQrUri] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const statusSequence = useRef(0);

  const checkStatus = async () => {
    const seq = ++statusSequence.current;
    try {
      const response = await invoke('totp:checkStatus') as
        { success: boolean; isEnrolled: boolean; state?: string; error?: string } & Partial<Recovery>;
      if (seq !== statusSequence.current) return;
      if (response.success) {
        setIsEnrolled(response.isEnrolled);
        setIsLocked(response.state === 'LOCKED');
        setRecovery({
          resetGrant: response.resetGrant ?? null,
          administrators: response.administrators ?? null,
          onlyAdministrator: response.onlyAdministrator === true
        });
      } else {
        setIsEnrolled(null); setQrUri(null);
        setMessage({ type: 'error', text: response.error || 'Could not check your authenticator.' });
      }
    } catch (err: any) {
      if (seq !== statusSequence.current) return;
      setIsEnrolled(null); setQrUri(null);
      setMessage({ type: 'error', text: err.message });
    } finally {
      if (seq === statusSequence.current) setLoading(false);
    }
  };

  useEffect(() => { void checkStatus(); return () => { ++statusSequence.current; }; }, []);
  useConfigurationUpdates(() => { if (!busy && !qrUri) return checkStatus(); });

  const startEnrolment = async () => {
    if (busy) return;
    ++statusSequence.current;
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
      const response = await invoke('totp:confirm', { code }) as { success: boolean; error?: string; reason?: string };
      if (response.success) {
        setMessage({ type: 'success', text: 'Your authenticator is set up. You can now sign records.' });
        setQrUri(null);
        setCode('');
        await checkStatus();
      } else {
        setMessage({ type: 'error', text: response.error || 'That code was not accepted. Try the next one your app shows.' });
        setCode('');
        if (response.reason === 'CREDENTIAL_LOCKED' || response.reason === 'ENROLMENT_EXPIRED') {
          setQrUri(null);
          await checkStatus();
        }
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setMessage(null);
    try { await checkStatus(); } finally { setBusy(false); }
  };

  if (isEnrolled === null) {
    if (loading) return <Loading label="Checking your authenticator…" />;
    return <Page title="Authenticator status unavailable"><SectionMessage appearance="error"><p>{message?.text ?? 'Could not check your authenticator.'}</p></SectionMessage><Button isDisabled={busy} onClick={refresh}>Retry</Button></Page>;
  }

  return (
    <Page
      eyebrow="Approval & baseline"
      title="Your authenticator app"
      lead={
        <>
          Signing a record takes two things: being signed in to Jira, and a six-digit code from
          an authenticator app that only you hold. This page sets up the second one. The codes
          are checked inside Jira. Nothing about your credential leaves Atlassian.
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
        <Stack>
          <SectionMessage appearance="error" title="Your authenticator is locked">
            <p>
              Too many incorrect codes were entered, so it can no longer sign. This is not
              something you can retry your way out of, by design: an administrator has to
              authorize setting it up again.
            </p>
          </SectionMessage>
          <ReplaceCard
            recovery={recovery}
            busy={busy}
            label="Set up my authenticator again"
            onStart={startEnrolment}
            onRefresh={refresh}
          />
        </Stack>
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
              already given are unaffected. They record a past act and are never
              re-verified against a credential.
            </p>
            <ReplaceCard
              recovery={recovery}
              busy={busy}
              label="Set up a new authenticator"
              onStart={startEnrolment}
              onRefresh={refresh}
            />
          </Card>
        </Stack>
      ) : (
        <Card
          title="You cannot sign yet"
          subtitle="No authenticator app is linked to your account."
        >
          <p className="va-hint" style={{ marginBottom: '14px' }}>
            Until you set one up, work items requiring your signature will keep waiting. The
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

type Recovery = {
  resetGrant: { expiresAt: number } | null;
  /** Other active VAtlassian administrators, or null when the roster could not be read. */
  administrators: string[] | null;
  onlyAdministrator: boolean;
};

const RECOVERY_PAGE = 'Jira settings → Apps → VAtlassian → Credentials & recovery';

/**
 * Replacing a working or locked authenticator requires an administrator's
 * reset grant. A person cannot authorize their own replacement. Offer the
 * button only while a grant is waiting. Otherwise name who can issue one
 * and where.
 */
function ReplaceCard({ recovery, busy, label, onStart, onRefresh }: {
  recovery: Recovery; busy: boolean; label: string;
  onStart: () => void; onRefresh: () => void;
}) {
  if (recovery.resetGrant) {
    return (
      <Stack>
        <SectionMessage appearance="success" title="An administrator has authorized a replacement">
          <p>
            You can set up a new authenticator until{' '}
            {new Date(recovery.resetGrant.expiresAt).toLocaleString()}. The authorization works once.
          </p>
        </SectionMessage>
        <div className="va-row">
          <Button appearance="primary" onClick={onStart} isDisabled={busy}>
            {busy ? 'Starting…' : label}
          </Button>
        </div>
      </Stack>
    );
  }
  const others = recovery.administrators;
  return (
    <Stack>
      <SectionMessage appearance="information" title="An administrator needs to authorize this first">
        {recovery.onlyAdministrator ? (
          <p>
            You are the only VAtlassian administrator, and nobody can authorize their own reset.
            Add a second administrator under <strong>Jira settings → Apps → VAtlassian →
            Administrators</strong>, then ask them to issue your reset under{' '}
            <strong>Credentials &amp; recovery</strong>.
          </p>
        ) : (
          <p>
            Ask{' '}
            {others && others.length
              ? <strong>{others.join(', ')}</strong>
              : others ? 'a Jira administrator to appoint a VAtlassian administrator, then ask them' : 'a VAtlassian administrator'}
            {' '}to issue you a reset under <strong>{RECOVERY_PAGE}</strong>. The reset lasts
            24 hours; come back here once it is issued.
          </p>
        )}
      </SectionMessage>
      <div className="va-row">
        <Button onClick={onRefresh} isDisabled={busy}>{busy ? 'Checking…' : 'Check again'}</Button>
      </div>
    </Stack>
  );
}
