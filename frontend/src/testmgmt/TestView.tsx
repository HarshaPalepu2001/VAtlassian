import { useState, type ReactNode } from 'react';
import { Disclosure, Tabs } from './ui';
import { invoke } from '../lib/bridge';
import { Badge, Card, EmptyState, Facts, Section } from '../ui/primitives';
import { Notice, When } from '../ui/feedback';
import SignBox from './SignBox';
import DatasetEditor, { type Dataset } from './DatasetEditor';
import { SourceSelection, type SourceReference } from './CoverageView';
import { stateTone, resultTone, words } from './labels';
import type { Draft, Failure, Step, TestViewModel } from './types';

let nextLocalId = 1;
const newStep = (): Step => ({ id: `n${Date.now().toString(36)}${nextLocalId++}`, action: '', data: '', expected: '' });
type AuthoringDraft = Draft & { dataset?: Dataset | null };
type FrozenContent = { objective: string; preconditions: string; steps: Step[]; dataset?: Dataset | null;
  verifies?: Partial<SourceReference>[]; parentIssueId?: string | null };

export default function TestView({ model, onModel, coverage }: { model: TestViewModel; onModel: (m: TestViewModel) => void; coverage?: ReactNode }) {
  const [draft, setDraft] = useState<AuthoringDraft>(model.draft);
  const [tab, setTab] = useState('definition');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  // `at` names the control whose request failed; null shows the error at the top.
  const [error, setError] = useState<{ message: string; at: string | null } | null>(null);

  const apply = (result: TestViewModel & Failure, at: string | null) => {
    if (result?.error) { setError({ message: result.error, at }); return false; }
    setError(null); onModel(result); setDraft(result.draft); setDirty(false); return true;
  };
  const call = async (key: string, payload: Record<string, unknown>, at: string | null = null) => {
    setBusy(true);
    try { return apply(await invoke<TestViewModel & Failure>(key, payload), at); }
    catch (e) { setError({ message: e instanceof Error ? e.message : 'The request did not complete.', at }); return false; }
    finally { setBusy(false); }
  };
  const edit = (patch: Partial<AuthoringDraft>) => { setDraft({ ...draft, ...patch }); setDirty(true); };
  const editStep = (index: number, patch: Partial<Step>) => edit({ steps: draft.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) });
  const move = (index: number, by: number) => {
    const steps = [...draft.steps]; const [s] = steps.splice(index, 1); steps.splice(index + by, 0, s); edit({ steps });
  };
  const save = () => call('tm:test:saveDraft', { issueKey: model.issue.key, expectedRevision: draft.revision,
    draft: { objective: draft.objective, preconditions: draft.preconditions, steps: draft.steps, verifies: draft.verifies, dataset: draft.dataset ?? null } });
  const publish = async () => { if (await call('tm:test:publish', { issueKey: model.issue.key, expectedRevision: draft.revision })) setTab('versions'); };

  const signed = model.versions.find(v => v.state === 'SIGNED');
  return (
    <div className="tm">
      {error?.at === null && <Notice danger>{error.message}</Notice>}
      <Facts items={[
        { label: 'Parent', value: model.parent ? `${model.parent.key}${model.parent.summary ? ` · ${model.parent.summary}` : ''}`
          : <Badge tone="danger">No parent. Set the Epic before publishing</Badge> },
        { label: 'Runnable version', value: signed ? `v${signed.versionNo} (signed)` : <Badge tone="warning">None signed yet</Badge> }
      ]} />

      <Tabs label="Test details" value={tab} onChange={setTab} tabs={[
        { id: 'definition', label: 'Definition', content: <Section title="Draft">
        {!model.canEdit && <Notice>You can read this test but not edit it.</Notice>}
        <label className="va-field"><span className="va-label">Objective</span>
          <textarea className="va-input" rows={2} value={draft.objective} disabled={!model.canEdit || busy}
            onChange={e => edit({ objective: e.target.value })} /></label>
        <label className="va-field"><span className="va-label">Preconditions</span>
          <textarea className="va-input" rows={2} value={draft.preconditions} disabled={!model.canEdit || busy}
            onChange={e => edit({ preconditions: e.target.value })} /></label>
        <h3 className="tm-subheading">Test steps</h3>
        <div className="tm-table-scroll" tabIndex={0} role="region" aria-label="Editable test steps"><table className="va-table tm-step-table">
          <thead><tr><th>#</th><th>Action</th><th>Data</th><th>Expected result</th><th><span className="va-visually-hidden">Step actions</span></th></tr></thead>
          <tbody>
            {draft.steps.map((step, i) => (
              <tr key={step.id}>
                <td>{i + 1}</td>
                {(['action', 'data', 'expected'] as const).map(f => (
                  <td key={f}><textarea className="va-input" aria-label={`Step ${i + 1} ${f === 'expected' ? 'expected result' : f}`} rows={2} value={step[f]} disabled={!model.canEdit || busy}
                    onChange={e => editStep(i, { [f]: e.target.value })} /></td>
                ))}
                <td className="tm-step-actions">
                  <button className="va-button" disabled={!model.canEdit || busy || i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                  <button className="va-button" disabled={!model.canEdit || busy || i === draft.steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                  <button className="va-button" disabled={!model.canEdit || busy} onClick={() => edit({ steps: draft.steps.filter((_, j) => j !== i) })} aria-label="Remove step">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {model.canEdit && <button className="va-button tm-add-step" disabled={busy} onClick={() => edit({ steps: [...draft.steps, newStep()] })}>Add step</button>}
        <Disclosure title={`Dataset${draft.dataset?.parameters.length ? ` (${draft.dataset.parameters.length} parameters)` : ' (optional)'}`} >
        <DatasetEditor value={draft.dataset} onChange={dataset => edit({ dataset })} disabled={busy || !model.canEdit} />
        </Disclosure>
        <Disclosure title={`Source references (${draft.verifies.length})`}>
        <SourceSelection issueKey={model.issue.key} references={draft.verifies as SourceReference[]}
          onChange={verifies => edit({ verifies })} disabled={busy || !model.canEdit} />
        <p className="va-secondary">Signing synchronizes Jira Verifies links. Protected links may need a new source approval.</p>
        </Disclosure>
        {model.canEdit && (
          <div className="tm-actions">
            <button className="va-button" disabled={busy || !dirty} onClick={save}>Save draft</button>
            <button className="va-button va-button--primary" disabled={busy || dirty || !draft.revision || !model.parent} onClick={publish}
              title={dirty ? 'Save the draft first' : undefined}>Publish new version</button>
          </div>
        )}
        <p className="va-subtlest" style={{ fontSize: 12 }}>
          Publish a saved draft, then sign the version before running it.
        </p>
      </Section> },
        { id: 'versions', label: 'Versions', count: model.versions.length, content: <Section title="Versions">
        {model.versions.length === 0 && <EmptyState title="No versions yet">Publish the draft to create version 1.</EmptyState>}
        {model.versions.map(v => (
          <Card key={v.versionId} title={`Version ${v.versionNo}`} subtitle={<>Published <When ms={v.publishedAt} /> · <code>{v.digest.slice(0, 16)}…</code></>}>
            <p><Badge tone={stateTone(v.state)}>{words(v.state)}</Badge> · {v.content.steps.length} steps</p>
            {v.versionId === signed?.versionId && v.sourceLinks && (v.sourceLinks.state === 'COMMITTED'
              ? <p>Jira source links synchronized.</p>
              : <Notice danger={v.sourceLinks.state === 'BLOCKED'}>{sourceLinkNotice(v.sourceLinks.problem)}</Notice>)}
            <Disclosure title="Version definition" open={v.state === 'PUBLISHED'}><FrozenDefinition content={v.content} versionNo={v.versionNo} /></Disclosure>
            {v.signatures.map(s => (
              <p key={s.stepIndex} style={{ fontSize: 12 }}>
                {s.decision === 'REJECT' ? '✕' : '✓'} {s.label}: <strong>{s.printedName}</strong>, <When ms={s.signedAt} />{s.reason ? `. ${s.reason}` : ''}
              </p>
            ))}
            {v.state === 'PUBLISHED' && v.nextStep && !v.canSign && <Notice>Waiting for: {v.nextStep.label} ({v.nextStep.role}).{v.signBlocked === 'AUTHOR_CANNOT_SIGN' ? ' You wrote or published this version, so someone else must sign it.' : ''}</Notice>}
            {(v as typeof v & { canFinishVersion?: boolean }).canFinishVersion && (
              <button className="va-button" disabled={busy} onClick={() => call('tm:test:finishVersion', { versionId: v.versionId }, `finish:${v.versionId}`)}>Finish version</button>
            )}
            {error?.at === `finish:${v.versionId}` && <Notice danger>{error.message}</Notice>}
            {v.state === 'PUBLISHED' && v.nextStep && v.canSign && (
              <SignBox step={v.nextStep} digest={v.digest} allowReject busy={busy}
                error={error?.at === `sign:${v.versionId}` ? error.message : null}
                onSign={({ code, decision, reason }) => call('tm:test:signVersion', { versionId: v.versionId, code, contentHash: v.digest, decision, reason }, `sign:${v.versionId}`)} />
            )}
          </Card>
        ))}
      </Section> },
        { id: 'runs', label: 'Runs', count: model.runs.length, content: <Section title="Runs of this test">
        {model.runs.length === 0 ? <p className="va-subtlest">Not run yet.</p> : (
          <div className="tm-table-scroll" tabIndex={0}><table className="va-table"><thead><tr><th>Run</th><th>State</th><th>Result</th><th>Started</th></tr></thead>
            <tbody>{model.runs.map(r => (
              <tr key={r.runId}><td><code>{r.runId.slice(0, 8)}</code></td><td>{words(r.state)}</td>
                <td><Badge tone={resultTone(r.result)}>{words(r.result)}</Badge></td><td><When ms={r.createdAt} /></td></tr>
            ))}</tbody></table></div>
        )}
      </Section> },
        ...(coverage ? [{ id: 'coverage', label: 'Coverage', content: coverage }] : [])
      ]} />
    </div>
  );
}

function sourceLinkNotice(problem?: string | null) {
  return ({ SOURCE_LINK_POLICY_BLOCKED: 'An approved Jira baseline protects these links. Review and approve the native link rules before using Finish version.',
    SOURCE_LINK_DRIFT: 'Jira Verifies links differ from the signed scope. Review the manual changes before synchronizing a new version.',
    SOURCE_LINK_TYPE_REQUIRED: 'An administrator must configure the Verifies link type. Publish a new version with that mapping.',
    SOURCE_LINK_CONFIGURATION_CHANGED: 'The Verifies mapping differs from signed history. An administrator must restore the original mapping.' } as Record<string, string>)[problem ?? '']
    ?? 'The Test approval is recorded. Jira source links are still pending. Refresh or use Finish version; governed coverage remains Unknown until they are confirmed.';
}

function FrozenDefinition({ content, versionNo }: { content: FrozenContent; versionNo: number }) {
  const dataset = content.dataset;
  return <div aria-label={`Frozen definition of version ${versionNo}`}>
    {content.parentIssueId && <p>Parent at publication: {content.parentIssueId}</p>}
    <p><strong>Objective</strong></p><p style={{ whiteSpace: 'pre-wrap' }}>{content.objective || 'None recorded.'}</p>
    <p><strong>Preconditions</strong></p><p style={{ whiteSpace: 'pre-wrap' }}>{content.preconditions || 'None recorded.'}</p>
    <div className="tm-table-scroll" tabIndex={0}><table className="va-table" aria-label={`Steps of version ${versionNo}`}>
      <thead><tr><th>#</th><th>Action</th><th>Data</th><th>Expected result</th></tr></thead>
      <tbody>{content.steps.map((step, index) => <tr key={step.id}>
        <td>{index + 1}</td><td style={{ whiteSpace: 'pre-wrap' }}>{step.action}</td>
        <td style={{ whiteSpace: 'pre-wrap' }}>{step.data}</td><td style={{ whiteSpace: 'pre-wrap' }}>{step.expected}</td>
      </tr>)}</tbody>
    </table></div>
    {!dataset ? <p className="va-hint">No dataset. This version executes once.</p> : <>
      <h4>Frozen dataset</h4>
      <p>{dataset.mode === 'COMBINATORIAL' ? 'All parameter value combinations' : 'Explicit dataset rows'}</p>
      <div className="tm-table-scroll" tabIndex={0}><table className="va-table"><thead><tr><th>Parameter</th><th>Type</th><th>Values</th></tr></thead>
        <tbody>{dataset.parameters.map(parameter => <tr key={parameter.name}><td>{parameter.name}</td><td>{parameter.type}</td>
          <td style={{ whiteSpace: 'pre-wrap' }}>{parameter.type === 'LIST' ? parameter.values?.join('\n') : parameter.value ?? 'Values recorded per row'}</td></tr>)}</tbody></table></div>
      {!!dataset.rows?.length && <div className="tm-table-scroll" tabIndex={0}><table className="va-table"><thead><tr><th>Iteration</th>{dataset.parameters.map(p => <th key={p.name}>{p.name}</th>)}</tr></thead>
        <tbody>{dataset.rows.map(row => <tr key={row.id}><td>{row.id}</td>{dataset.parameters.map(p => <td key={p.name} style={{ whiteSpace: 'pre-wrap' }}>{row.values[p.name]}</td>)}</tr>)}</tbody></table></div>}
    </>}
    <h4>Frozen source references</h4>
    {!content.verifies?.length ? <p>No source references in this version.</p> : content.verifies.map((source, index) => <div key={source.issueId ?? index}>
      <p><strong>{source.issueKey || (source.issueId ? `Source ${source.issueId}` : 'Source unavailable')}</strong>{source.baseline ? ` · baseline v${source.baseline.version}` : ' · no approved baseline'}</p>
      <Disclosure title="Source audit identifiers">
      {source.sourceDigest && <p>Source digest: <code style={{ overflowWrap: 'anywhere' }}>{source.sourceDigest}</code></p>}
      {source.baseline && <p>Baseline {source.baseline.id}: <code style={{ overflowWrap: 'anywhere' }}>{source.baseline.hash}</code></p>}
      </Disclosure>
    </div>)}
  </div>;
}
