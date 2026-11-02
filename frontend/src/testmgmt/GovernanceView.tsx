import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/bridge';
import { Badge, Field, Section } from '../ui/primitives';
import { Notice, When } from '../ui/feedback';
import SignBox from './SignBox';
import { Disclosure } from './ui';
import type { Chain, Failure, NextStep, Signature } from './types';

type RecordKind = 'ASSIGNMENT' | 'TARGET' | 'EXCEPTION';
type GoverningRecord = { recordId: string; kind: RecordKind; content: Record<string, unknown>; digest: string; state: string;
  chain: Chain; signatures: Signature[]; nextStep: NextStep; canSign: boolean; canFinish?: boolean; proofConfirmed: boolean; stale?: boolean };
type SelectedAttempt = { obligationId: string; testVersionId: string; context: unknown; run: { runId: string; attemptSequence?: number; state: string; result: string }; qualification: string; unresolvedMetadata?: string[] };
type Evaluation = { evaluationId: string; digest?: string; recorded?: boolean; verdict?: string; findings?: { code: string; [key: string]: unknown }[];
  snapshot?: { verdict: string; evaluatedAt: number; findings: { code: string; [key: string]: unknown }[]; selectedAttempts?: SelectedAttempt[];
    transition?: { observed: boolean; linked: boolean; note?: string }; [key: string]: unknown } };
type GovernanceModel = { issueId: string; issueKey: string; source: { governedReady?: boolean; drifted?: boolean; sourceDigest?: string; baseline?: { version?: number } | null };
  complete: boolean; records: GoverningRecord[]; activeAssignment: GoverningRecord | null; activeTarget: GoverningRecord | null; evaluations: Evaluation[]; observedTransitions?: { observationId: string; createdAt: number; content: { fromStatusId: string; toStatusId: string; transitionId?: string | null } }[] };
type ObligationRow = { id: string; level: string; method: string; testVersionId: string; environment: string; configuration: string; releaseId: string; releaseName: string };
const emptyObligation = (): ObligationRow => ({ id: '', level: '', method: '', testVersionId: '', environment: '', configuration: '', releaseId: '', releaseName: '' });
const titles: Record<RecordKind, string> = { ASSIGNMENT: 'Verification assignment', TARGET: 'Closure target', EXCEPTION: 'Evidence exception' };
const metadata = ['reportedBuild', 'classification', 'provenance'] as const;
const words = (value: string) => value.toLowerCase().replaceAll('_', ' ');

/** Every prepare creates a separate subject. Only its configured TOTP approvals activate it. */
export default function GovernanceView({ issueKey }: { issueKey: string }) {
  const [model, setModel] = useState<GovernanceModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ObligationRow[]>([emptyObligation()]);
  const [assignmentReason, setAssignmentReason] = useState('');
  const [target, setTarget] = useState({ executionIssueKey: '', buildId: '', rationale: '' });
  const [exception, setException] = useState({ runId: '', evidenceDigest: '', rationale: '', missingMetadata: [] as string[] });
  const [latest, setLatest] = useState<Evaluation | null>(null);
  const currentIssue = useRef(issueKey); currentIssue.current = issueKey;
  const load = useCallback(async () => {
    const result = await invoke<GovernanceModel & Failure>('tm:governance:view', { issueKey });
    if (currentIssue.current !== issueKey) return;
    if (result.error) throw new Error(result.error);
    if (!result.source || !Array.isArray(result.records) || !Array.isArray(result.evaluations)) throw new Error('Governed verification returned an incomplete view.');
    setModel(result);
  }, [issueKey]);
  useEffect(() => {
    let active = true; setModel(null); setLatest(null); setError(null); setRows([emptyObligation()]); setAssignmentReason('');
    setTarget({ executionIssueKey: '', buildId: '', rationale: '' }); setException({ runId: '', evidenceDigest: '', rationale: '', missingMetadata: [] });
    load().catch(e => { if (active) setError(e.message); }); return () => { active = false; };
  }, [load]);
  const call = async (method: string, payload: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const result = await invoke<Evaluation & Failure>(`tm:governance:${method}`, { issueKey, ...payload });
      if (currentIssue.current !== issueKey) return;
      if (result.error) throw new Error(result.error);
      if (method === 'evaluate') setLatest(result);
      await load();
    } catch (e) { if (currentIssue.current === issueKey) setError(e instanceof Error ? e.message : 'The governance request did not complete.'); }
    finally { if (currentIssue.current === issueKey) setBusy(false); }
  };
  const ready = model?.complete === true && model.source.governedReady === true && model.source.drifted === false;
  const assignment = model?.activeAssignment;
  const activeTarget = model?.activeTarget;
  const changeRow = (index: number, field: keyof ObligationRow, value: string) => setRows(items => items.map((item, at) => at === index ? { ...item, [field]: value } : item));
  const validRows = rows.every(row => row.id.trim() && row.level.trim() && row.method.trim() && /^[a-f\d]{32}$/.test(row.testVersionId.trim()) && (!row.releaseId || /^\d+$/.test(row.releaseId)));
  const prepareAssignment = () => {
    // Repeated obligation/version rows add mandatory contexts without creating interchangeable choices.
    const obligations = new Map<string, { id: string; level: string; method: string; tests: { testVersionId: string; contexts: { environment: string; configuration: string; release: { id: string; name: string } | null }[] }[] }>();
    for (const row of rows) {
      const id = row.id.trim(); let obligation = obligations.get(id);
      if (!obligation) { obligation = { id, level: row.level.trim(), method: row.method.trim(), tests: [] }; obligations.set(id, obligation); }
      if (obligation.level !== row.level.trim() || obligation.method !== row.method.trim()) { setError('Rows for the same obligation must use the same level and method.'); return; }
      let test = obligation.tests.find(item => item.testVersionId === row.testVersionId.trim());
      if (!test) { test = { testVersionId: row.testVersionId.trim(), contexts: [] }; obligation.tests.push(test); }
      test.contexts.push({ environment: row.environment, configuration: row.configuration, release: row.releaseId ? { id: row.releaseId, name: row.releaseName } : null });
    }
    void call('prepareAssignment', { rationale: assignmentReason, obligations: [...obligations.values()], buildPolicy: { mode: 'EXACT' } });
  };
  const evaluations = [...(latest ? [latest] : []), ...(model?.evaluations ?? []).filter(item => item.evaluationId !== latest?.evaluationId)];
  return <Section title="Governed verification">
    <p>Approve a source assignment, a single execution and build candidate, then evaluate closure against the latest mandatory attempts.</p>
    {error && <Notice danger>{error}</Notice>}
    <button className="va-button" disabled={busy} onClick={() => call('view', {})}>Refresh governed verification</button>
    {!model && !error && <p role="status">Loading governing records…</p>}
    {model && <>
      {!model.complete && <Notice danger>Governing records are incomplete. Unavailable records cannot authorize closure.</Notice>}
      {!ready && <Notice danger>Source baseline is unavailable, stale or has drift. A current approved source baseline is required for governing approvals and closure.</Notice>}
      <p>Source baseline: {model.source.baseline?.version != null ? `v${model.source.baseline.version}` : 'Not recorded'} · source digest: <code style={{ overflowWrap: 'anywhere' }}>{model.source.sourceDigest ?? 'Not recorded'}</code></p>
      <p>Active assignment: {assignment?.recordId ?? 'None'}{assignment?.stale && <Badge tone="danger">Stale assignment</Badge>}<br />Active target: {activeTarget?.recordId ?? 'None'}{activeTarget?.stale && <Badge tone="danger">Stale target</Badge>}</p>
      <Disclosure title="Prepare verification assignment">
        <p>Every obligation, exact signed test version and declared context is mandatory. Repeat an obligation and test version to add more contexts. Draft replacements leave the current assignment active until approval.</p>
        {rows.map((row, index) => <fieldset key={index} disabled={busy}><legend>Mandatory combination {index + 1}</legend>
          <div className="va-form-grid">{([
            ['id', 'Obligation identifier'], ['level', 'Verification level'], ['method', 'Verification method'], ['testVersionId', 'Exact signed test version ID'],
            ['environment', 'Environment'], ['configuration', 'Configuration'], ['releaseId', 'Release ID (optional)'], ['releaseName', 'Release name (optional)']
          ] as const).map(([key, label]) => <Field key={key} label={label}><input className="va-input" aria-label={`${label} ${index + 1}`} value={row[key]} onChange={e => changeRow(index, key, e.target.value)} /></Field>)}</div>
          <button className="va-button" disabled={busy || rows.length === 1} onClick={() => setRows(items => items.filter((_, at) => at !== index))}>Remove combination {index + 1}</button>
        </fieldset>)}
        <button className="va-button" disabled={busy || rows.length >= 100} onClick={() => setRows(items => [...items, emptyObligation()])}>Add mandatory combination</button>
        <Field label="Assignment rationale"><textarea className="va-input" aria-label="Assignment rationale" value={assignmentReason} disabled={busy} onChange={e => setAssignmentReason(e.target.value)} /></Field>
        <p>Build matching policy: exact identity. Preparation freezes the current source baseline and approval chain.</p>
        <button className="va-button va-button--primary" disabled={busy || !ready || !validRows || !assignmentReason.trim()} onClick={prepareAssignment}>Prepare assignment for approval</button>
      </Disclosure>
      <Disclosure title="Prepare closure target">
        <p>This approval separately binds the active assignment to one candidate execution and sender-attested build identity. Use the same build identity fields in CI intake.</p>
        <Field label="Candidate execution key"><input className="va-input" aria-label="Candidate execution key" value={target.executionIssueKey} disabled={busy} onChange={e => setTarget({ ...target, executionIssueKey: e.target.value.toUpperCase() })} /></Field>
        <Field label="Reported build ID (sender-attested)"><input className="va-input" aria-label="Target reported build ID" value={target.buildId} disabled={busy} onChange={e => setTarget({ ...target, buildId: e.target.value })} /></Field>
        <p className="va-hint">Build identity is stored as {`{ "id": "${target.buildId || 'candidate-id'}" }`}. It does not prove compiler, runner or artifact provenance.</p>
        <Field label="Target rationale"><textarea className="va-input" aria-label="Target rationale" value={target.rationale} disabled={busy} onChange={e => setTarget({ ...target, rationale: e.target.value })} /></Field>
        <button className="va-button va-button--primary" disabled={busy || !ready || !assignment || assignment.stale || !target.executionIssueKey.trim() || !target.buildId.trim() || !target.rationale.trim()}
          onClick={() => call('prepareTarget', { assignmentId: assignment?.recordId, executionIssueKey: target.executionIssueKey.trim(), reportedBuild: { id: target.buildId.trim() }, rationale: target.rationale })}>Prepare target for approval</button>
      </Disclosure>
      <Disclosure title="Prepare historical evidence exception">
        <p>Only explicitly absent historical metadata on otherwise valid, signed, passed evidence can be accepted. Failures, recorded build mismatches, drift, proof defects, retests and blocking defects cannot be waived.</p>
        <Field label="Historical run ID"><input className="va-input" aria-label="Historical run ID" value={exception.runId} disabled={busy} onChange={e => setException({ ...exception, runId: e.target.value.trim() })} /></Field>
        <Field label="Exact signed evidence digest"><input className="va-input" aria-label="Exact signed evidence digest" value={exception.evidenceDigest} disabled={busy} onChange={e => setException({ ...exception, evidenceDigest: e.target.value.trim() })} /></Field>
        <fieldset disabled={busy}><legend>Named missing historical metadata</legend>{metadata.map(field => <label key={field} style={{ display: 'block' }}>
          <input type="checkbox" checked={exception.missingMetadata.includes(field)} onChange={e => setException({ ...exception, missingMetadata: e.target.checked ? [...exception.missingMetadata, field] : exception.missingMetadata.filter(item => item !== field) })} /> {field}
        </label>)}</fieldset>
        <Field label="Exception rationale"><textarea className="va-input" aria-label="Exception rationale" value={exception.rationale} disabled={busy} onChange={e => setException({ ...exception, rationale: e.target.value })} /></Field>
        <button className="va-button" disabled={busy || !ready || !assignment || !activeTarget || !exception.runId || !/^[a-f\d]{64}$/.test(exception.evidenceDigest) || !exception.missingMetadata.length || !exception.rationale.trim()}
          onClick={() => call('prepareException', { assignmentId: assignment?.recordId, targetId: activeTarget?.recordId, ...exception })}>Prepare exception for approval</button>
      </Disclosure>
      <h4>Governing approvals</h4>
      {!model.records.length && <p>No governing records yet.</p>}
      {model.records.map(record => <Disclosure key={record.recordId} title={`${titles[record.kind]} · ${record.recordId} · ${words(record.state)}`} open={record.state === 'SIGNING'}>
        <p><Badge tone={record.stale ? 'danger' : record.proofConfirmed ? 'success' : 'warning'}>{record.stale ? 'Stale' : record.proofConfirmed ? 'Approval proof confirmed' : 'Approval pending'}</Badge></p>
        <p>Frozen record SHA-256: <code style={{ overflowWrap: 'anywhere' }}>{record.digest}</code></p>
        <pre aria-label="Frozen governing record" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(record.content, null, 2)}</pre>
        <p>Approval chain: {record.chain.steps.map(step => `${step.label} (${step.role}): ${step.meaning}`).join(' → ')}</p>
        {record.signatures.map(signature => <p key={signature.stepIndex}>{signature.label}: {signature.printedName} · <When ms={signature.signedAt} /> · {signature.meaning}</p>)}
        {record.canSign && record.nextStep && !record.stale && <SignBox key={`${record.recordId}:${record.nextStep.index}:${record.digest}`} step={record.nextStep} digest={record.digest} allowReject={false} busy={busy}
          onSign={({ code }) => call('sign', { recordId: record.recordId, contentHash: record.digest, code })} />}
        {!record.canSign && record.nextStep && <p>Waiting for {record.nextStep.label} ({record.nextStep.role}) on the source requirement.</p>}
        {record.canFinish && !record.stale && <button className="va-button" disabled={busy} onClick={() => call('sign', { recordId: record.recordId, contentHash: record.digest })}>Finish audited activation</button>}
      </Disclosure>)}
      {!!model.observedTransitions?.length && <section aria-label="Observed Jira transitions">
        <h4>Observed Jira transitions</h4><p>These are separate Jira event records. Evaluation linkage: Not established.</p>
        {model.observedTransitions.map(observed => <p key={observed.observationId}>{observed.content.fromStatusId} → {observed.content.toStatusId} · <When ms={observed.createdAt} /> · {observed.observationId}</p>)}
      </section>}
      <h4>Closure evaluations</h4>
      <p>A gate decision is permission as of evaluation time. It does not prove that Jira completed a transition. Later evidence changes do not rewrite a frozen dossier.</p>
      <button className="va-button va-button--primary" disabled={busy} onClick={() => call('evaluate', { targetId: activeTarget?.recordId ?? null })}>Evaluate closure</button>
      {evaluations.map(evaluation => <EvaluationCard key={evaluation.evaluationId} issueKey={issueKey} evaluation={evaluation} />)}
    </>}
  </Section>;
}

function EvaluationCard({ issueKey, evaluation }: { issueKey: string; evaluation: Evaluation }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const snapshot = evaluation.snapshot;
  const verdict = snapshot?.verdict ?? evaluation.verdict ?? 'DENIED';
  const exportable = evaluation.recorded !== false && !!snapshot && !!evaluation.digest;
  const download = async () => {
    setBusy(true); setError(null);
    try {
      const dossier = await invoke<Evaluation & Failure>('tm:governance:export', { issueKey, evaluationId: evaluation.evaluationId });
      if (dossier.error) throw new Error(dossier.error);
      if (dossier.evaluationId !== evaluation.evaluationId || dossier.digest !== evaluation.digest || !dossier.snapshot) throw new Error('The dossier did not match this frozen evaluation.');
      const url = URL.createObjectURL(new Blob([JSON.stringify(dossier, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `closure-dossier-${evaluation.evaluationId}.json`;
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : 'The frozen dossier could not be exported.'); }
    finally { setBusy(false); }
  };
  return <article className="va-card" style={{ padding: 12, marginTop: 12 }} aria-label={`Closure evaluation ${evaluation.evaluationId}`}>
    <p><Badge tone={verdict === 'ALLOWED' && exportable ? 'success' : 'danger'}>{verdict}</Badge> Gate permission · {evaluation.evaluationId}</p>
    {snapshot && <p>Frozen as of <When ms={snapshot.evaluatedAt} /></p>}
    {!exportable && <Notice danger>This evaluation was not durably confirmed. Closure is denied and a frozen dossier is unavailable.</Notice>}
    {(snapshot?.findings ?? evaluation.findings ?? []).map((finding, index) => <p key={index}>{words(finding.code)}{Object.keys(finding).length > 1 ? ` · ${JSON.stringify(finding)}` : ''}</p>)}
    {!!snapshot?.selectedAttempts?.length && <div className="tm-table-scroll" role="region" tabIndex={0} aria-label="Selected frozen attempts"><table className="va-table">
      <thead><tr><th>Mandatory scope</th><th>Latest selected attempt</th><th>Qualification</th></tr></thead>
      <tbody>{snapshot.selectedAttempts.map((attempt, index) => <tr key={index}>
        <td>{attempt.obligationId}<br />Test version <code>{attempt.testVersionId}</code><br />{JSON.stringify(attempt.context)}</td>
        <td>Sequence {attempt.run.attemptSequence ?? 'Not recorded'} · {attempt.run.runId}<br />{attempt.run.state} · {attempt.run.result}</td>
        <td><Badge tone={attempt.qualification === 'UNVERIFIED' ? 'danger' : attempt.qualification === 'VERIFIED_WITH_EXCEPTION' ? 'warning' : 'success'}>{attempt.qualification}</Badge>
          {!!attempt.unresolvedMetadata?.length && <p>Accepted historical gap: {attempt.unresolvedMetadata.join(', ')} — Not recorded.</p>}
          {attempt.unresolvedMetadata?.includes('reportedBuild') && <p>Missing build identity remains unproved.</p>}
        </td>
      </tr>)}</tbody>
    </table></div>}
    <p>Observed Jira transition: {snapshot?.transition?.observed ? 'Recorded' : 'Not observed'} · evaluation linkage: {snapshot?.transition?.linked ? 'Verified correlation' : 'Not established'}</p>
    <p className="va-hint">{snapshot?.transition?.note ?? 'An observed Jira transition is a separate fact. Timestamp proximity does not establish linkage.'}</p>
    {snapshot && <Disclosure title="Frozen evidence and findings"><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(snapshot, null, 2)}</pre></Disclosure>}
    <button className="va-button" disabled={busy || !exportable} onClick={download}>{busy ? 'Exporting…' : 'Download frozen dossier'}</button>
    {error && <Notice danger>{error}</Notice>}
  </article>;
}
