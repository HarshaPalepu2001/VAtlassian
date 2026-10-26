import { useEffect, useState } from 'react';
import { invoke } from '../lib/bridge';
import { Badge, Card, Section } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import SignBox from './SignBox';
import { Disclosure } from './ui';
import { words, stateTone } from './labels';
import type { NextStep, TestViewModel } from './types';

type Decision = { decisionId: string; state: string; digest: string; canSign: boolean; canFinish: boolean; proofConfirmed: boolean;
  nextStep: NextStep; content: { kind: string; decision: string; rationale: string; source: { issueKey: string };
    oldBaseline: { id: string; version: number; hash: string }; newBaseline: { id: string; version: number; hash: string };
    testVersionId: string; testDigest: string; run: { runId: string; frozenDigest: string } | null };
  signatures: { step_index: number; label: string; printedName: string; contentHash: string }[] };
type Result = Decision & { error?: string };

/** Definition review and reuse of historical results remain separately signed decisions. */
export default function SourceDecisions({ model }: { model: TestViewModel }) {
  const [records, setRecords] = useState<Decision[]>([]);
  const [complete, setComplete] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [kind, setKind] = useState('SUSPECT_REVIEW');
  const [decision, setDecision] = useState('FITS');
  const [runId, setRunId] = useState('');
  const [rationale, setRationale] = useState('');
  const signed = model.versions.find(v => v.state === 'SIGNED');
  const sources = signed?.content.verifies ?? [];
  const load = async () => {
    try {
      const result = await invoke<{ records: Decision[]; complete: boolean; error?: string }>('tm:sources:decisions', { issueKey: model.issue.key });
      if (result.error) setError(result.error); else { setRecords(result.records); setComplete(result.complete); }
    } catch { setError('Source decisions could not be read. Refresh to try again.'); }
  };
  useEffect(() => { load(); }, [model.issue.key, signed?.versionId]);
  const call = async (key: string, payload: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const result = await invoke<Result>(key, payload);
      if (result.error) setError(result.error); else await load();
    } catch { setError('This request did not finish. Refresh the decisions before trying again.'); }
    finally { setBusy(false); }
  };
  if (!sources.length && !records.length && !error) return null;
  return <Section title="Source change decisions">
    <p className="va-hint">Review a changed source against this test, or approve reuse of an existing signed run.</p>
    {error && <Notice danger>{error}</Notice>}
    {!complete && <Notice danger>Decision history is incomplete. Coverage remains unconfirmed.</Notice>}
    <button className="va-button" disabled={busy} onClick={load}>Refresh decisions</button>
    {model.canEdit && !!sources.length && <Disclosure title="Review a source change"><fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
      <label className="va-field"><span className="va-label">Source</span><select className="va-input" aria-label="Source to review" value={sourceId} onChange={e => setSourceId(e.target.value)}>
        <option value="">Choose a signed source reference</option>{sources.map(source => <option key={source.issueId} value={source.issueId}>{source.issueKey}</option>)}
      </select></label>
      <label className="va-field"><span className="va-label">Decision type</span><select className="va-input" value={kind} onChange={e => setKind(e.target.value)}>
        <option value="SUSPECT_REVIEW">Review the test definition</option><option value="APPLICABILITY">Reuse an existing signed run</option>
      </select></label>
      {kind === 'SUSPECT_REVIEW' ? <label className="va-field"><span className="va-label">Review outcome</span><select className="va-input" value={decision} onChange={e => setDecision(e.target.value)}>
        <option value="FITS">The test still fits</option><option value="MUST_CHANGE">The test must change</option>
      </select></label> : <label className="va-field"><span className="va-label">Signed run</span><select className="va-input" aria-label="Run for applicability" value={runId} onChange={e => setRunId(e.target.value)}>
        <option value="">Choose a signed run</option>{model.runs.filter(r => r.state === 'SIGNED' && ['PASSED', 'PARTLY_PASSED', 'NOT_APPLICABLE'].includes(r.result)).map((run, index) => <option key={run.runId} value={run.runId}>Run {index + 1} · {run.result.toLowerCase().replaceAll('_', ' ')} · {new Date(run.createdAt).toLocaleString()}</option>)}
      </select></label>}
      <label className="va-field"><span className="va-label">Rationale</span><textarea className="va-input" aria-label="Source decision rationale" maxLength={4000} value={rationale} onChange={e => setRationale(e.target.value)} /></label>
      <button className="va-button" disabled={!sourceId || !rationale.trim() || kind === 'APPLICABILITY' && !runId} onClick={() => call('tm:sources:prepareDecision', {
        issueKey: model.issue.key, sourceIssueId: sourceId, kind, decision: kind === 'APPLICABILITY' ? 'APPLIES' : decision, rationale, runId: kind === 'APPLICABILITY' ? runId : null
      })}>Prepare decision for signing</button>
    </fieldset></Disclosure>}
    {records.map(record => <Card key={record.decisionId} title={`${record.content.source.issueKey} · ${record.content.kind === 'APPLICABILITY' ? 'Run applicability' : 'Definition review'}`}>
      <p><Badge tone={stateTone(record.state)}>{words(record.state)}</Badge> · {record.content.decision.toLowerCase().replaceAll('_', ' ')}</p>
      <p style={{ whiteSpace: 'pre-wrap' }}>{record.content.rationale}</p>
      <Disclosure title="Decision audit identifiers">
      <p>Original baseline v{record.content.oldBaseline.version}: <code>{record.content.oldBaseline.id}</code></p>
      <p>Reviewed baseline v{record.content.newBaseline.version}: <code>{record.content.newBaseline.id}</code></p>
      <p>Signed test content: <code>{record.content.testDigest}</code></p>
      {record.content.run && <p>Frozen run: <code>{record.content.run.runId}</code> · <code>{record.content.run.frozenDigest}</code></p>}
      </Disclosure>
      {record.signatures.map(sig => <p key={sig.step_index}>{sig.label}: {sig.printedName}</p>)}
      {record.canFinish && <button className="va-button" disabled={busy} onClick={() => call('tm:sources:finishDecision', { decisionId: record.decisionId })}>Finish source decision</button>}
      {record.canSign && record.nextStep && <SignBox key={`${record.decisionId}:${record.nextStep.index}`} step={record.nextStep} digest={record.digest} allowReject={false} busy={busy}
        onSign={({ code }) => call('tm:sources:signDecision', { decisionId: record.decisionId, contentHash: record.digest, code })} />}
    </Card>)}
  </Section>;
}
