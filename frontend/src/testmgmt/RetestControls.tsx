import { useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/bridge';
import { IssueLink, Section } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import type { ExecutionViewModel } from './types';

type RunChoice = { runId: string; state: string; result: string; test: { key?: string | null; hidden?: boolean }; version: { versionNo?: number | null } };
type Model = { issue: { key: string; done: boolean }; canEdit: boolean; runs: RunChoice[] };
type Attempt = { requestId: string; runIds: string[]; useLatestVersion: boolean };
type Result = { requestId: string; state: string; complete: boolean; execution: { id: string; key: string } | null;
  createdRuns: number; totalRuns: number; problem?: string | null; error?: string };
const terminal = new Set(['SIGNED', 'REJECTED', 'NOT_EXECUTED']);
const defaultSelected = (model: Model) => model.runs.filter(run => !run.test.hidden
  && (run.state === 'REJECTED' || run.state === 'NOT_EXECUTED' || (run.state === 'SIGNED' && run.result === 'FAILED'))).map(run => run.runId);
const storageKey = (issueKey: string) => `va-tm-retest:${issueKey}`;
function savedAttempt(issueKey: string): Attempt | null {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(storageKey(issueKey)) ?? 'null');
    return /^[0-9a-f]{32}$/.test(parsed?.requestId ?? '') && Array.isArray(parsed?.runIds) && typeof parsed?.useLatestVersion === 'boolean' ? parsed : null;
  } catch { return null; }
}
function remember(issueKey: string, value: Attempt | null) {
  try { if (value) window.sessionStorage.setItem(storageKey(issueKey), JSON.stringify(value)); else window.sessionStorage.removeItem(storageKey(issueKey)); }
  catch { /* The in-memory attempt still keeps retries stable when browser storage is unavailable. */ }
}

/** A stable request survives retry/remount; changing selection starts an explicit new attempt. */
export default function RetestControls({ model }: { model: Model; onModel?: (model: ExecutionViewModel) => void }) {
  const initial = savedAttempt(model.issue.key);
  const [attempt, setAttempt] = useState<Attempt | null>(initial);
  const [selected, setSelected] = useState<string[]>(initial?.runIds ?? defaultSelected(model));
  const [useLatestVersion, setUseLatestVersion] = useState(initial?.useLatestVersion ?? false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currentIssue = useRef(model.issue.key);
  useEffect(() => {
    currentIssue.current = model.issue.key;
    const saved = savedAttempt(model.issue.key);
    setAttempt(saved); setSelected(saved?.runIds ?? defaultSelected(model)); setUseLatestVersion(saved?.useLatestVersion ?? false);
    setResult(null); setError(null); setBusy(false);
  }, [model.issue.key]);

  const submit = async () => {
    const key = model.issue.key;
    const request = attempt ?? { requestId: crypto.randomUUID().replaceAll('-', ''), runIds: selected, useLatestVersion };
    setAttempt(request); remember(key, request); setBusy(true); setError(null);
    try {
      const response = await invoke<Result>('tm:exec:retest', { issueKey: key, ...request });
      if (currentIssue.current !== key) return;
      if (response.error) setError(response.error); else setResult(response);
    } catch (error) {
      if (currentIssue.current === key) setError(`${error instanceof Error ? error.message : 'The request did not finish.'} Retry this same request to check its recorded outcome.`);
    } finally { if (currentIssue.current === key) setBusy(false); }
  };
  const reset = () => {
    remember(model.issue.key, null); setAttempt(null); setResult(null); setError(null);
    setSelected(defaultSelected(model)); setUseLatestVersion(false);
  };

  if (!model.issue.done) return null;
  return <Section title="Selective rerun">
    <p>Create a new execution under this execution's parent. The selected runs retain their environment, configuration and release; the original signed records remain available.</p>
    {!model.canEdit && <Notice>You need permission to edit this execution and create work items to start a rerun.</Notice>}
    {error && <Notice danger>{error}</Notice>}
    <fieldset disabled={busy || !!attempt || !model.canEdit} style={{ border: 0, padding: 0 }}>
      {model.runs.filter(run => terminal.has(run.state)).map(run => <label className="va-field" key={run.runId}>
        <span><input type="checkbox" data-run-id={run.runId} checked={selected.includes(run.runId)} disabled={run.test.hidden}
          onChange={event => setSelected(event.target.checked ? [...selected, run.runId] : selected.filter(id => id !== run.runId))} />{' '}
          {run.test.hidden ? 'Unavailable test' : `${run.test.key ?? 'Test'} v${run.version.versionNo ?? '?'}`} · {run.state.toLowerCase().replaceAll('_', ' ')} · {run.result.toLowerCase().replaceAll('_', ' ')}</span>
      </label>)}
      <label className="va-field"><span><input type="checkbox" aria-label="Use latest signed versions" checked={useLatestVersion}
        onChange={event => setUseLatestVersion(event.target.checked)} /> Use each test's latest signed version</span></label>
      <p className="va-subtlest">By default, the new runs use the exact versions from the source execution. Failed, rejected and not executed runs are selected first.</p>
    </fieldset>
    {result?.execution && <p>New execution: <IssueLink issueKey={result.execution.key} /> · {result.createdRuns} of {result.totalRuns} runs created.</p>}
    {result?.state === 'NEEDS_REPAIR' ? <>
      <Notice danger>The new execution's creation or identity could not be proved. Ask a VAtlassian administrator to investigate request {result.requestId}. Another execution will not be created automatically.</Notice>
      {/^JIRA_REFUSED_(400|401|403|404|405|422|429)$/.test(result.problem ?? '') && <button className="va-button" disabled={busy} onClick={reset}>Start another selection</button>}
    </>
      : result?.complete ? <>
        <Notice>The selective rerun is ready in the new execution.</Notice>
        <button className="va-button" disabled={busy} onClick={reset}>Start another selection</button>
      </> : <>
        {result?.state === 'CREATING' && <Notice>The create request may still be in flight. Checking this request will reconcile its outcome before any runs are added.</Notice>}
        {result?.state === 'ADDING_RUNS' && <Notice>The new execution exists. Continue this request to finish adding the selected runs.</Notice>}
        <button className="va-button va-button--primary" disabled={busy || !model.canEdit || !selected.length || selected.length > 100} onClick={submit}>
          {busy ? 'Working…' : error || (attempt && !result) ? 'Retry rerun request' : result?.state === 'ADDING_RUNS' ? 'Continue rerun' : result?.state === 'CREATING' ? 'Check rerun request' : 'Create rerun'}
        </button>
      </>}
    {selected.length > 100 && <Notice danger>Choose at most 100 runs per new execution.</Notice>}
  </Section>;
}
