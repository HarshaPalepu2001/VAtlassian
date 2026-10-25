import { useState } from 'react';
import { Affirmation, CodeInput } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import type { NextStep } from './types';

/**
 * One sign-off step. The signer sees the step, the statement they attest to
 * and the digest they sign; the affirmation box comes before the code
 * (21 CFR 11.50: the meaning of the signature is part of it).
 */
export default function SignBox({ step, digest, allowReject, busy, error, onSign }: {
  step: NonNullable<NextStep>; digest: string; allowReject: boolean; busy: boolean;
  /** A refusal of this signature, shown here because the signer is looking here. */
  error?: string | null;
  onSign: (args: { code: string; decision: 'SIGN' | 'REJECT'; reason?: string }) => void;
}) {
  const [affirmed, setAffirmed] = useState(false);
  const [code, setCode] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const ready = code.length === 6 && !busy && (rejecting ? reason.trim().length > 0 : affirmed);
  return (
    <div className="va-card va-card--sunken" style={{ padding: 12 }} role="group" aria-label={`${step.label} sign-off`}>
      <p><strong>{step.label}</strong> · role {step.role}</p>
      {!rejecting && <Affirmation checked={affirmed} onChange={setAffirmed} disabled={busy}>{step.meaning}</Affirmation>}
      {rejecting && (
        <label className="va-field"><span className="va-label">Reason for rejecting</span>
          <textarea className="va-input" rows={2} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} />
        </label>
      )}
      <p className="va-subtlest" style={{ fontSize: 11 }}>Signs content <code>{digest.slice(0, 16)}…</code></p>
      <div className="va-row" style={{ gap: 8, alignItems: 'center' }}>
        <CodeInput value={code} onChange={setCode} disabled={busy}
          onSubmit={() => ready && onSign({ code, decision: rejecting ? 'REJECT' : 'SIGN', reason })} />
        <button className="va-button va-button--primary" disabled={!ready}
          onClick={() => onSign({ code, decision: rejecting ? 'REJECT' : 'SIGN', reason })}>
          {rejecting ? 'Reject' : 'Sign'}
        </button>
        {allowReject && (
          <button className="va-button" disabled={busy} onClick={() => { setRejecting(!rejecting); setCode(''); }}>
            {rejecting ? 'Back to signing' : 'Reject instead'}
          </button>
        )}
      </div>
      {!affirmed && !rejecting && code.length === 6 && <Notice>Tick the statement above to sign.</Notice>}
      {error && <Notice danger>{error}</Notice>}
    </div>
  );
}
