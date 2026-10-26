import { useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/bridge';
import { Badge, CodeInput, EmptyState, Facts, Section, Select } from '../ui/primitives';
import { Notice, When } from '../ui/feedback';
import SignBox from './SignBox';
import EvidenceDownload from './EvidenceDownload';
import RetestControls from './RetestControls';
import { Disclosure, Tabs } from './ui';
import ExecutionSummary from './ExecutionSummary';
import { PROBLEMS, resultTone, stateTone, words } from './labels';
import type { ExecutionViewModel, Failure, Run, RunStep } from './types';

const STATUSES = ['PASSED', 'FAILED', 'BLOCKED', 'NOT_APPLICABLE'] as const;
type RunForm = { testKey: string; environment: string; configuration: string; releaseId: string };
type AddRunRequest = { requestId: string; form: RunForm };
const emptyRunForm: RunForm = { testKey: '', environment: '', configuration: '', releaseId: '' };
// These addRun checks precede its first write. A persistence/audit failure may already have a durable run.
const addRunRefusals = new Set(['NOT_A_TEST', 'NO_SIGNED_VERSION', 'VERSION_PROOF_INVALID', 'NO_EDIT_PERMISSION',
  'NO_PARENT', 'EXECUTION_DONE', 'INVALID_INPUT', 'NO_ELIGIBLE_SIGNER', 'STARTER_NOT_ELIGIBLE',
  'NOT_ENOUGH_DISTINCT_SIGNERS', 'PLAN_SCOPE_TOO_LARGE']);
function savedAddRun(executionId: string): AddRunRequest | null {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(`va-tm-add-run:${executionId}`) ?? 'null');
    return /^[0-9a-f]{32}$/.test(saved?.requestId ?? '') && ['testKey', 'environment', 'configuration', 'releaseId']
      .every(key => typeof saved?.form?.[key] === 'string') ? saved : null;
  } catch { return null; }
}
function rememberAddRun(executionId: string, request: AddRunRequest | null) {
  try {
    if (request) window.sessionStorage.setItem(`va-tm-add-run:${executionId}`, JSON.stringify(request));
    else window.sessionStorage.removeItem(`va-tm-add-run:${executionId}`);
  } catch { /* The mounted view still retains the request when browser storage is unavailable. */ }
}

/** `at` names the control a request came from, so its refusal shows beside it. */
type Call = (key: string, payload: Record<string, unknown>, at?: string) => Promise<boolean>;
type ErrorAt = (at: string) => string | null;

export default function ExecutionView({ model, onModel }: { model: ExecutionViewModel; onModel: (m: ExecutionViewModel) => void }) {
  const [tab, setTab] = useState('runs');
  const [busy, setBusy] = useState(false);
  // A located error shows at its control; one without a place shows at the top.
  const [error, setError] = useState<{ message: string; at: string | null } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [addRequest, setAddRequest] = useState<AddRunRequest | null>(() => savedAddRun(model.issue.id));
  const [form, setForm] = useState<RunForm>(() => savedAddRun(model.issue.id)?.form ?? emptyRunForm);
  const currentExecution = useRef(model.issue.id);
  const lastCallOutcome = useRef<'ok' | 'refused' | 'uncertain'>('uncertain');
  currentExecution.current = model.issue.id;
  useEffect(() => {
    const saved = savedAddRun(model.issue.id); setAddRequest(saved); setForm(saved?.form ?? emptyRunForm);
    setOpen(null); setError(null); setBusy(false);
  }, [model.issue.id]);

  const call: Call = async (key, payload, at) => {
    const place = at ?? null;
    const executionId = model.issue.id;
    lastCallOutcome.current = 'uncertain';
    setBusy(true);
    try {
      const result = await invoke<ExecutionViewModel & Failure>(key, payload);
      if (currentExecution.current !== executionId) return false;
      if (result?.error) { lastCallOutcome.current = addRunRefusals.has(result.reason ?? '') ? 'refused' : 'uncertain'; setError({ message: result.error, at: place }); return false; }
      lastCallOutcome.current = 'ok'; setError(null); onModel(result); return true;
    } catch (e) { if (currentExecution.current === executionId) setError({ message: e instanceof Error ? e.message : 'The request did not complete.', at: place }); return false; }
    finally { if (currentExecution.current === executionId) setBusy(false); }
  };
  const errorAt: ErrorAt = at => (error?.at === at ? error.message : null);
  const addRun = async () => {
    const executionId = model.issue.id;
    const request = addRequest ?? { requestId: crypto.randomUUID().replaceAll('-', ''), form: { ...form } };
    setAddRequest(request); rememberAddRun(executionId, request);
    const ok = await call('tm:exec:addRun', { issueKey: model.issue.key, ...request.form, releaseId: request.form.releaseId || null, requestId: request.requestId });
    if (currentExecution.current !== executionId) return;
    if (ok) {
      rememberAddRun(executionId, null); setAddRequest(null); setForm({ ...request.form, testKey: '' });
    } else if (lastCallOutcome.current === 'refused') {
      rememberAddRun(executionId, null); setAddRequest(null);
    }
  };

  return (
    <div className="tm">
      {error?.at === null && <Notice danger>{error.message}</Notice>}
      <Facts items={[
        { label: 'Parent', value: model.parent ? model.parent.key : <Badge tone="danger">No parent — set the Epic before running</Badge> },
        { label: 'Status', value: model.issue.status },
        { label: 'Sign-off chain', value: model.runChain.steps.map(s => `${s.label} (${s.role})`).join(' → ') }
      ]} />
      {model.issue.done && <Notice>This execution is done. Its runs are read-only.</Notice>}

      <Tabs label="Execution details" value={tab} onChange={setTab} tabs={[
        { id: 'runs', label: 'Runs', count: model.runs.length, content: <>
      {model.canEdit && !model.issue.done && (
        <Disclosure title={addRequest ? 'Retry pending run' : 'Add a run'} open={!!addRequest || model.runs.length === 0}>
          <div className="va-form-grid">
            <label className="va-field"><span className="va-label">Test key</span>
              <input className="va-input" placeholder="e.g. VAT-11" value={form.testKey} disabled={busy || !!addRequest}
                onChange={e => setForm({ ...form, testKey: e.target.value.toUpperCase() })} /></label>
            <label className="va-field"><span className="va-label">Environment</span>
              <input className="va-input" placeholder="e.g. HIL bench 3" value={form.environment} disabled={busy || !!addRequest}
                onChange={e => setForm({ ...form, environment: e.target.value })} /></label>
            <label className="va-field"><span className="va-label">Configuration</span>
              <input className="va-input" placeholder="e.g. ECU rev B" value={form.configuration} disabled={busy || !!addRequest}
                onChange={e => setForm({ ...form, configuration: e.target.value })} /></label>
            <label className="va-field"><span className="va-label">Release</span>
              <Select value={form.releaseId} onChange={v => setForm({ ...form, releaseId: v })} disabled={busy || !!addRequest}
                placeholder="No release" options={model.releases.map(r => ({ value: r.id, label: r.name }))} /></label>
          </div>
          {addRequest && <Notice>This add request is waiting for a confirmed outcome. Retrying uses the same submitted test and execution context.</Notice>}
          <button className="va-button va-button--primary" disabled={busy || !form.testKey.trim()} onClick={addRun}>{addRequest ? 'Retry Add run' : 'Add run'}</button>
          <p className="va-subtlest" style={{ fontSize: 12 }}>Uses the latest signed test version and current sign-off chain.</p>
        </Disclosure>
      )}

      <Section title="Runs">
        {model.runs.length === 0 && <EmptyState title="No runs yet">Add a run of a signed test.</EmptyState>}
        {model.runs.map(run => (
          <RunCard key={run.runId} run={run} model={model} busy={busy} expanded={open === run.runId}
            onToggle={() => setOpen(open === run.runId ? null : run.runId)} call={call} errorAt={errorAt} />
        ))}
      </Section>
      </> },
        ...(model.issue.done ? [{ id: 'rerun', label: 'Rerun', content: <RetestControls model={model} /> }] : []),
        { id: 'summary', label: 'Summary', content: <ExecutionSummary issueKey={model.issue.key} /> }
      ]} />
    </div>
  );
}

function RunCard({ run, model, busy, expanded, onToggle, call, errorAt }: {
  run: Run; model: ExecutionViewModel; busy: boolean; expanded: boolean; onToggle: () => void;
  call: Call; errorAt: ErrorAt;
}) {
  const editable = run.state === 'IN_PROGRESS' && model.canEdit && !model.issue.done && !run.test.hidden;
  // Signed off, but the outcome or the bug was not written: retryBug finishes it.
  const finishLabel = run.state === 'CREATING' ? 'Finish run setup' : run.state === 'CLOSING' ? 'Finish closure'
    : run.state === 'SIGNING' ? 'Finish sign-off' : run.bug?.state === 'INTENT' ? 'Check bug again' : 'Finish bug setup';
  const title = `${run.test.key ?? 'Test'} v${run.version.versionNo ?? '?'}${run.test.summary ? ` · ${run.test.summary}` : ''}`;
  return (
    <article className="tm-run">
      <h3 className="tm-run__title">{title}</h3>
      <p className="tm-run__meta">{[run.environment, run.configuration, run.release?.name].filter(Boolean).join(' · ') || 'No environment stated'} · started <When ms={run.createdAt} /></p>
      <p className="tm-run__status">
        <Badge tone={stateTone(run.state)}>{words(run.state)}</Badge>{' '}
        <Badge tone={resultTone(run.result)}>{words(run.result)}</Badge>{' '}
        {run.bug && <Badge tone={run.bug.state === 'CREATED' ? 'neutral' : 'danger'}>{words(run.bug.state)}{run.bug.issueKey ? ` ${run.bug.issueKey}` : ''}</Badge>}
        {run.retestOf && <span className="va-subtlest"> · retest of {run.retestOf.slice(0, 8)}</span>}
      </p>
      {run.signatures.map(s => (
        <p key={s.stepIndex} style={{ fontSize: 12 }}>
          {s.decision === 'REJECT' ? '✕' : '✓'} {s.label}: <strong>{s.printedName}</strong>, <When ms={s.signedAt} />{s.reason ? ` — ${s.reason}` : ''}
        </p>
      ))}
      {run.notExecuted && <p style={{ fontSize: 12 }}>Closed as not executed by <strong>{run.notExecuted.printedName}</strong>: {run.notExecuted.reason}</p>}
      {run.bug?.state === 'NEEDS_REPAIR' && <Notice danger>The automatic bug is not fully confirmed ({run.bug.lastError}). A VAtlassian administrator must investigate and repair it under Test management.</Notice>}
      {run.bug?.state === 'INTENT' && run.bug.lastError === 'CREATE_ANSWER_LOST' && (
        <Notice>Jira did not confirm the create request. VAtlassian looks for its result after about five minutes and never automatically creates another bug when that outcome is uncertain. Check again, then ask an administrator to investigate if repair is needed.</Notice>
      )}
      {run.canFinish && <button className="va-button" disabled={busy} onClick={() => call('tm:run:retryBug', { runId: run.runId }, `finish:${run.runId}`)}>{finishLabel}</button>}
      {errorAt(`finish:${run.runId}`) && <Notice danger>{errorAt(`finish:${run.runId}`)}</Notice>}
      {run.test.hidden ? <Notice>You cannot open this test in Jira, so its steps and results are not shown here.</Notice> : (
        <button className="va-button" aria-expanded={expanded} onClick={onToggle}>{expanded ? 'Hide steps' : editable ? 'Open runner' : 'Show steps'}</button>
      )}
      {expanded && !run.test.hidden && <Runner run={run} model={model} busy={busy} editable={editable} call={call} errorAt={errorAt} />}
    </article>
  );
}

function Runner({ run, model, busy, editable, call, errorAt }: {
  run: Run; model: ExecutionViewModel; busy: boolean; editable: boolean;
  call: Call; errorAt: ErrorAt;
}) {
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const canSignNow = run.canSign && run.nextStep && (run.state === 'SIGNING' || !run.signabilityProblem);
  const frozen = run as { planningSnapshot?: { required?: boolean; plan?: { issueId: string; revisionNo?: number; digest?: string };
    preconditions?: { issueId: string; revisionNo?: number; digest?: string; text: string }[] } | null;
    iterations?: { id: string; values: Record<string, string>; stepIds?: string[] }[] };
  return (
    <div className="tm-runner">
      {run.preconditions && <Notice>Preconditions: {run.preconditions}</Notice>}
      {(frozen.planningSnapshot?.plan || frozen.planningSnapshot?.preconditions?.length || frozen.iterations?.length) ? <Disclosure title="Run inputs">
      {frozen.planningSnapshot?.plan && <p>Frozen plan {frozen.planningSnapshot.plan.issueId}
        {frozen.planningSnapshot.plan.revisionNo != null ? ` · revision ${frozen.planningSnapshot.plan.revisionNo}` : ''}
        {' · '}{frozen.planningSnapshot.required === false ? 'Optional test' : 'Required test'}
        {frozen.planningSnapshot.plan.digest && <> · <code style={{ overflowWrap: 'anywhere' }}>{frozen.planningSnapshot.plan.digest}</code></>}</p>}
      {!!frozen.planningSnapshot?.preconditions?.length && <div aria-label="Frozen reusable preconditions">
        <h4>Frozen reusable preconditions</h4>
        {frozen.planningSnapshot.preconditions.map(condition => <div key={condition.issueId}>
          <p>Precondition {condition.issueId}{condition.revisionNo != null ? ` · revision ${condition.revisionNo}` : ''}</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{condition.text}</p>
          {condition.digest && <p><code style={{ overflowWrap: 'anywhere' }}>{condition.digest}</code></p>}
        </div>)}
      </div>}
      {!!frozen.iterations?.length && <div aria-label="Frozen run iterations">
        <h4>Frozen iterations</h4>
        {frozen.iterations.map(iteration => <div key={iteration.id}><p><strong>{iteration.id}</strong></p>
          {Object.keys(iteration.values).length ? <div className="tm-table-scroll" tabIndex={0}><table className="va-table"><thead><tr><th>Parameter</th><th>Value</th></tr></thead>
            <tbody>{Object.entries(iteration.values).map(([name, value]) => <tr key={name}><td>{name}</td><td style={{ whiteSpace: 'pre-wrap' }}>{value}</td></tr>)}</tbody></table></div>
            : <p>No parameters.</p>}
          {!!iteration.stepIds?.length && <p className="va-subtlest" style={{ fontSize: 11 }}>Steps: {iteration.stepIds.join(', ')}</p>}
        </div>)}
      </div>}
      </Disclosure> : null}
      {run.steps.map(step => <StepRow key={step.id} run={run} step={step} model={model} busy={busy} editable={editable} call={call} errorAt={errorAt} />)}

      {run.state === 'IN_PROGRESS' && run.signabilityProblem && <Notice>{PROBLEMS[run.signabilityProblem] ?? run.signabilityProblem}</Notice>}
      {run.resultPending && <Notice>A result change is waiting for its audit record. Refresh in a moment.</Notice>}
      {run.nextStep && !run.canSign && (run.state === 'SIGNING' || !run.signabilityProblem) && (
        <Notice>Waiting for: {run.nextStep.label} ({run.nextStep.role}).</Notice>
      )}
      {canSignNow && run.nextStep && (
        <SignBox step={run.nextStep} digest={run.contentHash} allowReject={run.state === 'SIGNING'} busy={busy} error={errorAt(`sign:${run.runId}`)}
          onSign={({ code: c, decision, reason: r }) => call('tm:run:sign', { runId: run.runId, code: c, contentHash: run.contentHash, decision, reason: r }, `sign:${run.runId}`)} />
      )}
      {editable && run.canSign && run.result === 'FAILED' && (
        <p className="va-subtlest" style={{ fontSize: 12 }}>A step failed, so this run is signed off as Failed and gets its bug. It cannot be closed as not executed.</p>
      )}
      {editable && run.canSign && run.result !== 'FAILED' && (
        <div style={{ marginTop: 8 }}>
          {!closing ? <button className="va-button" disabled={busy} onClick={() => setClosing(true)}>Close as not executed…</button> : (
            <div className="va-card va-card--sunken" style={{ padding: 12 }}>
              <label className="va-field"><span className="va-label">Why was this run not executed?</span>
                <textarea className="va-input" rows={2} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} /></label>
              <div className="va-row" style={{ gap: 8 }}>
                <CodeInput value={code} onChange={setCode} disabled={busy} />
                <button className="va-button va-button--primary" disabled={busy || !reason.trim() || code.length !== 6}
                  onClick={() => call('tm:run:notExecuted', { runId: run.runId, code, reason }, `close:${run.runId}`)}>Close run</button>
                <button className="va-button" disabled={busy} onClick={() => setClosing(false)}>Cancel</button>
              </div>
              {errorAt(`close:${run.runId}`) && <Notice danger>{errorAt(`close:${run.runId}`)}</Notice>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepRow({ run, step, model, busy, editable, call, errorAt }: {
  run: Run; step: RunStep; model: ExecutionViewModel; busy: boolean; editable: boolean;
  call: Call; errorAt: ErrorAt;
}) {
  const [actual, setActual] = useState(step.actual);
  const [comment, setComment] = useState(step.comment);
  const [attachmentId, setAttachmentId] = useState('');
  const [reason, setReason] = useState('');
  // A recorded result is changed only with a reason; the earlier one stays in the history.
  const recorded = step.recordedBy != null;
  const changes = (status: string) => status !== step.status || actual !== step.actual || comment !== step.comment;
  const needsReason = (status: string) => recorded && changes(status) && !reason.trim();
  const done = (ok: boolean) => { if (ok) setReason(''); return ok; };
  const here = `step:${run.runId}:${step.id}`;
  const record = async (status: string) => done(await call('tm:run:recordStep', { runId: run.runId, expectedRevision: run.revision,
    stepId: step.id, status, actual, comment, ...(recorded ? { reason } : {}) }, here));
  return (
    <div className="tm-run-step" role="group" aria-label={`Step ${step.position}`}>
      <details open={step.position === 1}>
      <summary className="tm-step-summary"><span><strong>Step {step.position}.</strong> {step.action}</span><Badge tone={resultTone(step.status)}>{words(step.status)}</Badge></summary>
      <div className="tm-step-body">
      {step.data && <p style={{ fontSize: 12 }}>Data: {step.data}</p>}
      <p style={{ fontSize: 12 }}>Expected: {step.expected}</p>
      {editable ? (
        <>
          <div className="va-form-grid">
            <label className="va-field"><span className="va-label">Actual result</span>
              <textarea className="va-input" rows={2} value={actual} onChange={e => setActual(e.target.value)} disabled={busy} /></label>
            <label className="va-field"><span className="va-label">Comment (required for Not applicable)</span>
              <textarea className="va-input" rows={2} value={comment} onChange={e => setComment(e.target.value)} disabled={busy} /></label>
          </div>
          {(recorded || step.evidence.length > 0) && (
            <label className="va-field"><span className="va-label">Reason for change (needed to change a recorded result or remove evidence)</span>
              <textarea className="va-input" rows={1} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} /></label>
          )}
          <div className="tm-actions tm-status-actions">
            {STATUSES.map(s => (
              <button key={s} className={`va-button${step.status === s ? ' va-button--primary' : ''}`} disabled={busy || needsReason(s)} onClick={() => record(s)}>{words(s)}</button>
            ))}
          </div>
          {errorAt(here) && <Notice danger>{errorAt(here)}</Notice>}
        </>
      ) : (
        <>
          {step.actual && <p style={{ fontSize: 12 }}>Actual: {step.actual}</p>}
          {step.comment && <p style={{ fontSize: 12 }}>Comment: {step.comment}</p>}
        </>
      )}
      {step.evidence.map(e => (
        <p key={e.attachmentId} style={{ fontSize: 12 }}>
          {e.filename} · SHA-256 <code>{e.sha256.slice(0, 12)}…</code>
          <EvidenceDownload issueKey={model.issue.key} runId={run.runId} stepId={step.id} evidence={e} disabled={busy} />
          {editable && <button className="va-button" disabled={busy || !reason.trim()} title={reason.trim() ? undefined : 'Give a reason for change first'}
            onClick={async () => done(await call('tm:run:removeEvidence', { runId: run.runId, expectedRevision: run.revision, stepId: step.id, attachmentId: e.attachmentId, reason }, here))}>Remove</button>}
        </p>
      ))}
      {!!step.history?.length && (
        <Disclosure title={`Change history (${step.history.length})`}>
        <div aria-label={`Changes to step ${step.position}`}>
          <p className="va-subtlest">Earlier entries are retained in the audit record.</p>
          {step.history.map((h, i) => (
            <p key={i} style={{ fontSize: 12 }}>
              {h.kind === 'EVIDENCE_REMOVED'
                ? <>Evidence removed (SHA-256 <code>{h.evidence?.sha256?.slice(0, 12)}…</code>)</>
                : <>Was {words(h.status ?? '')}{h.actual ? ` · Actual: ${h.actual}` : ''}{h.comment ? ` · Comment: ${h.comment}` : ''}</>}
              {' · changed '}<When ms={h.changedAt} />{` — ${h.reason}`}
            </p>
          ))}
        </div></Disclosure>
      )}
      {editable && model.attachments.length > 0 && (
        <div className="va-row" style={{ gap: 6 }}>
          <Select ariaLabel={`Step ${step.position} evidence attachment`} value={attachmentId} onChange={setAttachmentId} disabled={busy} placeholder="Add evidence from this execution's attachments"
            options={model.attachments.map(a => ({ value: a.id, label: a.filename }))} />
          <button className="va-button" disabled={busy || !attachmentId}
            onClick={async () => { if (await call('tm:run:attachEvidence', { runId: run.runId, expectedRevision: run.revision, stepId: step.id, attachmentId }, here)) setAttachmentId(''); }}>Add evidence</button>
        </div>
      )}
      {editable && model.attachments.length === 0 && <p className="va-hint">To add evidence, attach the file to this execution first.</p>}
      </div></details>
    </div>
  );
}
