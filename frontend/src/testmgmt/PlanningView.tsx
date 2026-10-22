import { useRef, useState } from 'react';
import { invoke } from '../lib/bridge';
import { Badge, Card, Section } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import SignBox from './SignBox';
import type { Chain, NextStep, Signature } from './types';

export type PlanningMember = { testIssueId: string; testIssueKey?: string; summary?: string; versionId: string | null; required: boolean; versionNo?: number; digest?: string; latestSigned?: { versionId: string; versionNo: number } | null };
export type PlanningCondition = { issueId: string; issueKey?: string; summary?: string; revisionId: string | null; revisionNo?: number; digest?: string; text?: string; latestSigned?: { revisionId: string; revisionNo: number } | null };
export type PlanningDraft = { objective: string; text: string; members: PlanningMember[]; preconditions: PlanningCondition[];
  environment: string; configurations: { id: string; name: string }[]; releaseId: string | null; revision: number };
export type PlanningRevision = { revisionId: string; revisionNo: number; state: string; digest: string; publishedAt?: number;
  content: Omit<PlanningDraft, 'revision' | 'releaseId'> & { release: { id: string; name: string } | null };
  chain?: Chain; signatures: Signature[]; nextStep: NextStep; canSign: boolean; canRecover?: boolean;
  memberLabels?: Record<string, { key: string; summary: string }>; preconditionLabels?: Record<string, { key: string; summary: string }> };
export type PlanningViewModel = { role: 'PLAN' | 'SET' | 'PRECONDITION'; issue: { id: string; key: string; summary: string };
  canEdit: boolean; parent: { id: string; key: string } | null; releases: { id: string; name: string }[];
  draft: PlanningDraft; revisions: PlanningRevision[] };
export type PlanRunSelection = { plan: { issueId: string; revisionId: string; revisionNo: number; digest: string }; digest: string;
  runs: { testIssueId: string; testKey?: string; testVersionNo?: number; testVersionId: string; configuration: string; environment: string; release: { id: string; name: string } | null }[] };
type Failure = { error?: string; reason?: string };

/** Jira-backed collection revisions and the exact inputs prepared from signed plans. */
export default function PlanningView({ model, onModel, onSelectRuns }: {
  model: PlanningViewModel; onModel: (model: PlanningViewModel) => void; onSelectRuns?: (selection: PlanRunSelection) => void;
}) {
  const [draft, setDraft] = useState(model.draft);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<PlanRunSelection | null>(null);
  const [executionKey, setExecutionKey] = useState('');
  const [started, setStarted] = useState<string | null>(null);
  const startAttempt = useRef<{ scope: string; requestId: string; offset: number } | null>(null);
  const [startComplete, setStartComplete] = useState(false);
  const edit = (patch: Partial<PlanningDraft>) => { setDraft({ ...draft, ...patch }); setDirty(true); setSelection(null); };
  const call = async (key: string, payload: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const result = await invoke<PlanningViewModel & Failure>(key, payload);
      if (result.error) { setError(result.error); return; }
      onModel(result); setDraft(result.draft); setDirty(false); setSelection(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'The request could not be completed.'); }
    finally { setBusy(false); }
  };
  const select = async (r: PlanningRevision) => {
    setBusy(true); setError(null); setSelection(null);
    try {
      const result = await invoke<PlanRunSelection & Failure>('tm:plan:selectRuns', { revisionId: r.revisionId, contentHash: r.digest });
      if (result.error) { setError(result.error); return; }
      setSelection(result); onSelectRuns?.(result);
    } catch (e) { setError(e instanceof Error ? e.message : 'The run inputs could not be prepared.'); }
    finally { setBusy(false); }
  };
  const member = (index: number, patch: Partial<PlanningMember>) => edit({ members: draft.members.map((m, i) => i === index ? { ...m, ...patch } : m) });
  const lookup = async (index: number, kind: 'TEST' | 'PRECONDITION') => {
    const key = kind === 'TEST' ? draft.members[index].testIssueKey : draft.preconditions[index].issueKey;
    setBusy(true); setError(null);
    try {
      const result = await invoke<{ issueId: string; key: string; summary: string; latestSigned: { versionId: string; versionNo: number; revisionId: string; revisionNo: number } | null } & Failure>('tm:planning:lookup', { collectionKey: model.issue.key, issueKey: key, kind });
      if (result.error) { setError(result.error); return; }
      if (kind === 'TEST') member(index, { testIssueId: result.issueId, testIssueKey: result.key, summary: result.summary, latestSigned: result.latestSigned });
      else edit({ preconditions: draft.preconditions.map((p, i) => i === index ? { ...p, issueId: result.issueId, issueKey: result.key, summary: result.summary, latestSigned: result.latestSigned } : p) });
    } catch (e) { setError(e instanceof Error ? e.message : 'The Jira work item could not be found.'); }
    finally { setBusy(false); }
  };
  const start = async (r: PlanningRevision) => {
    const key = executionKey.trim(); const scope = `${r.revisionId}:${key}`;
    if (!startAttempt.current || startAttempt.current.scope !== scope) startAttempt.current = { scope, requestId: crypto.randomUUID(), offset: 0 };
    setBusy(true); setError(null); setStarted(null);
    try {
      const result = await invoke<{ issue?: { key: string }; execution?: { key: string }; complete?: boolean; nextOffset?: number } & Failure>('tm:plan:startExecution', {
        revisionId: r.revisionId, contentHash: r.digest, executionKey: key, requestId: startAttempt.current.requestId, offset: startAttempt.current.offset });
      if (result.error) { setError(result.error); return; }
      setStarted(result.issue?.key ?? result.execution?.key ?? key);
      setStartComplete(result.complete !== false);
      startAttempt.current.offset = result.nextOffset ?? startAttempt.current.offset;
    } catch (e) { setError(e instanceof Error ? e.message : 'The execution could not be started. Retry to check the same request.'); }
    finally { setBusy(false); }
  };
  const move = (index: number, by: number) => { const members = [...draft.members]; const [m] = members.splice(index, 1); members.splice(index + by, 0, m); edit({ members }); };
  const disabled = busy || !model.canEdit;
  return <>
    {error && <Notice danger>{error}</Notice>}
    <Section title={`${model.role === 'PLAN' ? 'Plan' : model.role === 'SET' ? 'Set' : 'Precondition'} draft`}>
      {!model.canEdit && <Notice>You can read this collection but cannot edit it.</Notice>}
      <label className="va-field"><span className="va-label">Objective</span><textarea className="va-input" aria-label="Planning objective" value={draft.objective} disabled={disabled} maxLength={4000} onChange={e => edit({ objective: e.target.value })} /></label>
      <label className="va-field"><span className="va-label">{model.role === 'PRECONDITION' ? 'Precondition text' : 'Notes'}</span><textarea className="va-input" aria-label="Planning text" value={draft.text} disabled={disabled} maxLength={4000} onChange={e => edit({ text: e.target.value })} /></label>
      {model.role !== 'PRECONDITION' && <>
        <h4>Ordered test membership</h4><p className="va-subtlest">Enter Jira test keys, such as VAT-11. Publishing pins each selected signed version.</p>
        <table className="va-table"><thead><tr><th>#</th><th>Test</th><th>Signed version</th><th>Required</th><th /></tr></thead><tbody>
          {draft.members.map((m, index) => <tr key={index}>
            <td>{index + 1}</td><td><input className="va-input" aria-label={`Member ${index + 1} Jira key`} placeholder="VAT-11" value={m.testIssueKey ?? ''} disabled={disabled} onChange={e => member(index, { testIssueKey: e.target.value, testIssueId: '', summary: '', latestSigned: null, versionId: null })} />
              <button className="va-button" disabled={disabled || !m.testIssueKey?.trim()} onClick={() => lookup(index, 'TEST')}>Find test</button>
              {m.summary && <p>{m.testIssueKey} · {m.summary}</p>}
              {m.latestSigned && <p>Latest signed v{m.latestSigned.versionNo}</p>}</td>
            <td><select className="va-input" aria-label={`Member ${index + 1} signed version`} value={m.versionId ?? ''} disabled={disabled} onChange={e => member(index, { versionId: e.target.value || null })}>
              <option value="">Latest signed at publish</option>
              {m.versionId && m.versionId !== m.latestSigned?.versionId && <option value={m.versionId}>Pinned v{m.versionNo ?? '?'}</option>}
              {m.latestSigned && <option value={m.latestSigned.versionId}>Signed v{m.latestSigned.versionNo}</option>}
            </select></td>
            <td><input type="checkbox" aria-label={`Member ${index + 1} required`} checked={m.required} disabled={disabled} onChange={e => member(index, { required: e.target.checked })} /></td>
            <td><button className="va-button" disabled={disabled || index === 0} aria-label={`Move member ${index + 1} up`} onClick={() => move(index, -1)}>↑</button>
              <button className="va-button" disabled={disabled || index === draft.members.length - 1} aria-label={`Move member ${index + 1} down`} onClick={() => move(index, 1)}>↓</button>
              <button className="va-button" disabled={disabled} aria-label={`Remove member ${index + 1}`} onClick={() => edit({ members: draft.members.filter((_, i) => i !== index) })}>Remove</button></td>
          </tr>)}
        </tbody></table>
        {model.canEdit && <button className="va-button" disabled={busy || draft.members.length >= 200} onClick={() => edit({ members: [...draft.members, { testIssueId: '', testIssueKey: '', versionId: null, required: true }] })}>Add test</button>}
        <h4>Reusable preconditions</h4>
        {draft.preconditions.map((p, index) => <div key={index} className="va-row">
          <label className="va-field"><span className="va-label">Precondition Jira key</span><input className="va-input" placeholder="VAT-23" aria-label={`Precondition ${index + 1} Jira key`} disabled={disabled} value={p.issueKey ?? ''} onChange={e => edit({ preconditions: draft.preconditions.map((v, i) => i === index ? { ...v, issueKey: e.target.value, issueId: '', summary: '', revisionId: null, latestSigned: null } : v) })} /></label>
          <button className="va-button" disabled={disabled || !p.issueKey?.trim()} onClick={() => lookup(index, 'PRECONDITION')}>Find precondition</button>
          {p.summary && <p>{p.issueKey} · {p.summary}</p>}
          <label className="va-field"><span className="va-label">Signed revision</span><select className="va-input" disabled={disabled} value={p.revisionId ?? ''} onChange={e => edit({ preconditions: draft.preconditions.map((v, i) => i === index ? { ...v, revisionId: e.target.value || null } : v) })}>
            <option value="">Latest signed at publish</option>
            {p.revisionId && p.revisionId !== p.latestSigned?.revisionId && <option value={p.revisionId}>Pinned revision {p.revisionNo ?? '?'}</option>}
            {p.latestSigned && <option value={p.latestSigned.revisionId}>Signed revision {p.latestSigned.revisionNo}</option>}
          </select></label>
          <button className="va-button" disabled={disabled} onClick={() => edit({ preconditions: draft.preconditions.filter((_, i) => i !== index) })}>Remove precondition</button>
        </div>)}
        {model.canEdit && <button className="va-button" disabled={busy || draft.preconditions.length >= 50} onClick={() => edit({ preconditions: [...draft.preconditions, { issueId: '', issueKey: '', revisionId: null }] })}>Add precondition</button>}
      </>}
      {model.role === 'PLAN' && <>
        <h4>Release and execution context</h4>
        <label className="va-field"><span className="va-label">Jira release</span><select className="va-input" aria-label="Plan release" value={draft.releaseId ?? ''} disabled={disabled} onChange={e => edit({ releaseId: e.target.value || null })}>
          <option value="">Select release</option>{model.releases.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label className="va-field"><span className="va-label">Environment</span><input className="va-input" aria-label="Plan environment" disabled={disabled} value={draft.environment} maxLength={255} onChange={e => edit({ environment: e.target.value })} /></label>
        {draft.configurations.map((cfg, index) => <div className="va-row" key={index}>
          <label className="va-field"><span className="va-label">Configuration name</span><input className="va-input" disabled={disabled} value={cfg.name} maxLength={200} onChange={e => edit({ configurations: draft.configurations.map((c, i) => i === index ? { ...c, name: e.target.value } : c) })} /></label>
          <button className="va-button" disabled={disabled} onClick={() => edit({ configurations: draft.configurations.filter((_, i) => i !== index) })}>Remove configuration</button>
        </div>)}
        {model.canEdit && <button className="va-button" disabled={busy || draft.configurations.length >= 20} onClick={() => { let n = draft.configurations.length + 1; while (draft.configurations.some(c => c.id === `cfg${n}`)) n++; edit({ configurations: [...draft.configurations, { id: `cfg${n}`, name: '' }] }); }}>Add configuration</button>}
      </>}
      {model.canEdit && <div className="va-row" style={{ gap: 8, marginTop: 12 }}>
        <button className="va-button" disabled={busy || !dirty} onClick={() => call('tm:planning:saveDraft', { issueKey: model.issue.key, expectedRevision: draft.revision, draft })}>Save draft</button>
        <button className="va-button va-button--primary" disabled={busy || dirty || !draft.revision || !model.parent} onClick={() => call('tm:planning:publish', { issueKey: model.issue.key, expectedRevision: draft.revision })}>Publish revision</button>
      </div>}
      <p className="va-subtlest">Publishing freezes ordered members, signed test versions and preconditions. Plans freeze the release, environment and configurations. Sign the revision before preparing official runs.</p>
    </Section>
    <Section title="Immutable revisions">
      {!model.revisions.length && <p>No revisions yet.</p>}
      {model.revisions.map(r => <Card key={r.revisionId} title={`Revision ${r.revisionNo}`}>
        <p><Badge>{r.state}</Badge></p>
        {r.content.text && <p style={{ whiteSpace: 'pre-wrap' }}>{r.content.text}</p>}
        <ol>{r.content.members.map(m => <li key={m.testIssueId}>{r.memberLabels?.[m.testIssueId]?.key ?? `Test ${m.testIssueId}`} · {r.memberLabels?.[m.testIssueId]?.summary} · Signed v{m.versionNo} · {m.required ? 'Required' : 'Optional'}</li>)}</ol>
        {r.content.preconditions.map(p => <p key={p.issueId}>{r.preconditionLabels?.[p.issueId]?.key ?? 'Precondition'}, revision {p.revisionNo}: {p.text}</p>)}
        {model.role === 'PLAN' && <p>Release {r.content.release?.name ?? 'None'} · {r.content.environment} · {r.content.configurations.map(c => c.name).join(', ')}</p>}
        {r.signatures.map(sig => <p key={sig.stepIndex}>{sig.label}: {sig.printedName} · {sig.decision}{sig.reason ? ` · ${sig.reason}` : ''}</p>)}
        {r.state === 'PUBLISHING' && <Notice>Publication is awaiting audit confirmation. Retry publishing this saved draft to recover it.</Notice>}
        {r.state === 'PUBLISHED' && r.canSign && r.nextStep && <SignBox step={r.nextStep} digest={r.digest} allowReject busy={busy}
          onSign={args => call('tm:planning:sign', { revisionId: r.revisionId, contentHash: r.digest, ...args })} />}
        {r.state === 'PUBLISHED' && r.nextStep && !r.canSign && <Notice>Waiting for {r.nextStep.label} ({r.nextStep.role}).</Notice>}
        {r.canRecover && <button className="va-button" disabled={busy} onClick={() => call('tm:planning:sign', { revisionId: r.revisionId, contentHash: r.digest })}>Finish confirmed sign-off</button>}
        {model.role === 'PLAN' && r.state === 'SIGNED' && <>
          <button className="va-button" disabled={busy} onClick={() => select(r)}>Review run inputs</button>
          <label className="va-field"><span className="va-label">Execution Jira key</span><input className="va-input" aria-label={`Execution Jira key for revision ${r.revisionNo}`} placeholder="VAT-31" value={executionKey} disabled={busy} onChange={e => { setExecutionKey(e.target.value); setStarted(null); }} /></label>
          <button className="va-button va-button--primary" disabled={busy || !executionKey.trim()} onClick={() => start(r)}>{started && !startComplete ? 'Continue adding runs' : 'Start execution'}</button>
        </>}
        <details><summary>Audit identifiers</summary><p>Revision <code>{r.revisionId}</code></p><p>Content <code>{r.digest}</code></p></details>
      </Card>)}
    </Section>
    {started && <Notice>{startComplete ? `Execution ${started} is ready. Open its Test management panel to record results.` : `Execution ${started} has more runs to add. Continue this request to finish the signed plan selection.`}</Notice>}
    {selection && <Section title="Frozen run inputs">
      <p>{selection.runs.length} run inputs prepared from the signed revision. Choose these inputs when starting an execution.</p>
      <table className="va-table"><thead><tr><th>Test</th><th>Signed version</th><th>Configuration</th><th>Environment</th><th>Release</th></tr></thead><tbody>
        {selection.runs.map((run, i) => <tr key={i}><td>{run.testKey ?? run.testIssueId}</td><td>v{run.testVersionNo ?? '?'}</td><td>{run.configuration}</td><td>{run.environment}</td><td>{run.release?.name}</td></tr>)}
      </tbody></table><p>Selection digest <code>{selection.digest}</code></p>
    </Section>}
  </>;
}
