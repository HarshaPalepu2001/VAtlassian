import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/bridge';
import { Badge, Field, Section, Select } from '../ui/primitives';
import { Notice, When } from '../ui/feedback';
import { Disclosure } from './ui';
import type { Failure, Run } from './types';

type Token = { tokenId: string; label: string; expiresAt: number; revokedAt?: number | null; createdBy?: string };
type Grant = { grantId: string; tokenId: string; runIds: string[]; executionIssueId: string; expiresAt: number; revokedAt?: number | null };
type Receipt = { receiptId: string; status: string; payloadDigest: string; receivedAt: number; reportedBuild?: unknown; progress?: unknown; auditConfirmed?: boolean; lastError?: string | null };
type IntakeModel = { tokens: Token[]; grants: Grant[]; receipts: Receipt[]; complete?: boolean; canManage?: boolean; limits?: unknown };

/** Project tokens and execution-scoped grants never substitute for human review. */
export default function IntakeControls({ issueKey, runs, canEdit }: { issueKey: string; runs: Run[]; canEdit: boolean }) {
  const [model, setModel] = useState<IntakeModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [hours, setHours] = useState('24');
  const [tokenId, setTokenId] = useState('');
  const [runIds, setRunIds] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [detail, setDetail] = useState<Receipt | null>(null);
  const currentIssue = useRef(issueKey); currentIssue.current = issueKey;
  const load = useCallback(async () => {
    const result = await invoke<IntakeModel & Failure>('tm:intake:view', { issueKey });
    if (currentIssue.current !== issueKey) return;
    if (result.error) throw new Error(result.error);
    if (!Array.isArray(result.tokens) || !Array.isArray(result.grants) || !Array.isArray(result.receipts)) throw new Error('CI intake returned an incomplete view. Refresh to retry.');
    setModel(result);
  }, [issueKey]);
  useEffect(() => {
    let active = true; setModel(null); setSecret(null); setDetail(null); setRunIds([]); setTokenId(''); setError(null);
    load().catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [load]);
  const call = async (key: string, payload: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const result = await invoke<Record<string, unknown> & Failure>(key, { issueKey, ...payload });
      if (currentIssue.current !== issueKey) return;
      if (result.error) throw new Error(result.error);
      if (key === 'tm:intake:createToken' && typeof result.token === 'string') setSecret(result.token);
      if (key === 'tm:intake:receipt') setDetail(result as unknown as Receipt);
      await load();
    } catch (e) { if (currentIssue.current === issueKey) setError(e instanceof Error ? e.message : 'CI intake request did not complete.'); }
    finally { if (currentIssue.current === issueKey) setBusy(false); }
  };
  const expiresAt = () => Date.now() + Number(hours) * 3_600_000;
  const validExpiry = Number.isFinite(Number(hours)) && Number(hours) > 0 && Number(hours) <= 720;
  const manage = canEdit && model?.canManage !== false;
  const activeTokens = (model?.tokens ?? []).filter(token => !token.revokedAt && token.expiresAt > Date.now());
  return <Section title="CI intake">
    <p>Prepare exact runs here, then grant CI access to those runs for this candidate execution. CI build identity is sender-attested. A human reviews and signs the machine's results.</p>
    {error && <Notice danger>{error}</Notice>}
    <button className="va-button" disabled={busy} onClick={() => call('tm:intake:view', {})}>Refresh intake</button>
    {!model && !error && <p role="status">Loading authenticated intake records…</p>}
    {model?.complete === false && <Notice danger>The intake view is incomplete. Do not treat missing receipts or grants as ready.</Notice>}
    {manage && <>
      <Disclosure title="Create project CI token">
        <Field label="CI token label"><input className="va-input" aria-label="CI token label" value={label} disabled={busy} onChange={e => setLabel(e.target.value)} /></Field>
        <Field label="Expires in hours (maximum 720)"><input className="va-input" aria-label="Intake expiry hours" type="number" min="1" max="720" value={hours} disabled={busy} onChange={e => setHours(e.target.value)} /></Field>
        <button className="va-button" disabled={busy || !label.trim() || !validExpiry} onClick={() => call('tm:intake:createToken', { label: label.trim(), expiresAt: expiresAt() })}>Create token</button>
      </Disclosure>
      {secret && <div role="group" aria-label="New CI token"><Notice>Save this token in your CI secret store now. It is shown once and is not retained by this view after dismissal.</Notice>
        <Field label="New CI token"><input className="va-input" aria-label="New CI token" readOnly value={secret} autoComplete="off" spellCheck={false} /></Field>
        <button className="va-button" onClick={() => setSecret(null)}>Dismiss token</button></div>}
      <Disclosure title="Grant this execution to CI">
        <Field label="Project CI token"><Select ariaLabel="Project CI token" value={tokenId} onChange={setTokenId} disabled={busy} placeholder="Choose an active token" options={activeTokens.map(token => ({ value: token.tokenId, label: token.label }))} /></Field>
        <fieldset disabled={busy}><legend>Exact prepared runs</legend>{runs.map(run => <label key={run.runId} style={{ display: 'block' }}>
          <input type="checkbox" disabled={run.state !== 'IN_PROGRESS' || run.evidenceSchema !== 2 || !!run.intakeReceiptId || !!run.test.hidden} checked={runIds.includes(run.runId)} onChange={e => setRunIds(ids => e.target.checked ? [...ids, run.runId] : ids.filter(id => id !== run.runId))} />{' '}
          {run.test.key ?? 'Test'} v{run.version.versionNo ?? '?'} · attempt {run.attemptSequence ?? 'Not recorded'} · {run.runId} · {run.state}
        </label>)}{!runs.length && <p>Add prepared runs before creating a grant.</p>}</fieldset>
        <p>Grant expires in {hours} hours or when its token expires, whichever comes first. Change the expiry above before granting. Only readable, unfinished schema-2 runs without a receipt can be selected.</p>
        <button className="va-button" disabled={busy || !tokenId || !runIds.length || !validExpiry} onClick={() => call('tm:intake:grant', { tokenId, runIds, expiresAt: Math.min(expiresAt(), activeTokens.find(token => token.tokenId === tokenId)?.expiresAt ?? 0) })}>Grant selected runs</button>
      </Disclosure>
    </>}
    {!!model?.tokens.length && <Disclosure title="Project CI tokens">{model.tokens.map(token => <div key={token.tokenId}>
      <p><strong>{token.label}</strong> · {token.revokedAt ? 'Revoked' : token.expiresAt <= Date.now() ? 'Expired' : 'Active'} · expires <When ms={token.expiresAt} /></p>
      {manage && !token.revokedAt && <button className="va-button" disabled={busy} onClick={() => call('tm:intake:revokeToken', { tokenId: token.tokenId })}>Revoke token {token.label}</button>}
    </div>)}</Disclosure>}
    {!!model?.grants.length && <Disclosure title="Execution grants">{model.grants.map(grant => <div key={grant.grantId}>
      <p>Grant {grant.grantId} · token {grant.tokenId} · {grant.revokedAt ? 'Revoked' : grant.expiresAt <= Date.now() ? 'Expired' : 'Active'} · expires <When ms={grant.expiresAt} /></p>
      <p>Allowed runs: {grant.runIds.join(', ')}</p>
      <Disclosure title="CI submission template"><p>Send bounded JSON to the deployed CI intake endpoint using your project token as a Bearer credential. Replace the idempotency key, build identity and step outcomes with the actual CI results. Keep run, iteration and step IDs unchanged. This view does not submit results.</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{submissionTemplate(grant, runs)}</pre>
      </Disclosure>
      {manage && !grant.revokedAt && <button className="va-button" disabled={busy} onClick={() => call('tm:intake:revokeGrant', { grantId: grant.grantId })}>Revoke grant {grant.grantId}</button>}
    </div>)}</Disclosure>}
    <h4>Authenticated CI receipts</h4>
    <p className="va-hint">All affected runs remain blocked until the entire receipt is APPLIED and audit-confirmed. Expired or revoked authorization stops further processing.</p>
    {model && !model.receipts.length && <p>No receipts recorded.</p>}
    {model?.receipts.map(receipt => <div key={receipt.receiptId} className="va-card" style={{ padding: 12 }}>
      <p><strong>{receipt.receiptId}</strong> <Badge tone={receipt.status === 'APPLIED' && receipt.auditConfirmed === true ? 'success' : 'warning'}>{receipt.status}</Badge> · received <When ms={receipt.receivedAt} /></p>
      {receipt.auditConfirmed !== true && <Notice>Audit confirmation pending. Review and sign-off remain blocked.</Notice>}
      {receipt.status !== 'APPLIED' && <Notice>Receipt not APPLIED. Review and sign-off are blocked for every affected run.</Notice>}
      <p>Payload SHA-256: <code style={{ overflowWrap: 'anywhere' }}>{receipt.payloadDigest}</code></p>
      <p>Reported build (sender-attested): {receipt.reportedBuild ? JSON.stringify(receipt.reportedBuild) : 'Not recorded'}</p>
      {receipt.progress != null && <p>Application progress: {JSON.stringify(receipt.progress)}</p>}
      {receipt.lastError && <Notice danger>{receipt.lastError}</Notice>}
      <button className="va-button" disabled={busy} onClick={() => call('tm:intake:receipt', { receiptId: receipt.receiptId })}>Inspect receipt {receipt.receiptId}</button>
      {manage && (receipt.status !== 'APPLIED' || receipt.auditConfirmed !== true) && <button className="va-button" disabled={busy} onClick={() => call('tm:intake:retry', { receiptId: receipt.receiptId })}>Retry receipt {receipt.receiptId}</button>}
    </div>)}
    {detail && <Disclosure title={`Receipt details ${detail.receiptId}`} open><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(detail, null, 2)}</pre></Disclosure>}
  </Section>;
}

function submissionTemplate(grant: Grant, runs: Run[]): string {
  const selected = grant.runIds.map(id => runs.find(run => run.runId === id));
  if (selected.some(run => !run || run.test.hidden)) return 'The prepared runs must be readable to show their exact mapping. Refresh the execution after access is restored.';
  const ready = selected as Run[];
  return JSON.stringify({ idempotencyKey: 'REPLACE_WITH_UNIQUE_CI_KEY', executionIssueId: grant.executionIssueId, grantId: grant.grantId,
    reportedBuild: ready.find(run => run.reportedBuild)?.reportedBuild ?? { id: 'REPLACE_WITH_TARGET_BUILD_ID' },
    results: ready.map(run => ({ runId: run.runId, expectedRevision: run.revision, steps: run.steps.map(step => ({
      stepId: step.id, iterationId: run.iterations?.find(iteration => iteration.stepIds?.includes(step.id))?.id ?? 'ITERATION_NOT_RECORDED',
      status: 'REPLACE_WITH_CI_RESULT', actual: '', comment: '', log: ''
    })) })) }, null, 2);
}
