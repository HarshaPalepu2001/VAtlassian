import { useCallback, useEffect, useState } from 'react';
import { view } from '@forge/bridge';
import { invoke } from '../lib/bridge';
import { EmptyState, Loading, Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import TestView from './TestView';
import ExecutionView from './ExecutionView';
import PlanningView, { type PlanningViewModel } from './PlanningView';
import CoverageView from './CoverageView';
import SourceDecisions from './SourceDecisions';
import type { ExecutionViewModel, Failure, TestViewModel } from './types';

type Context = { role: 'TEST' | 'EXECUTION' | 'PLAN' | 'SET' | 'PRECONDITION' | 'SOURCE' | 'BUG' | null; enabled: boolean; issueKey?: string };

/** The Test management issue panel: a test's authoring and versions, or an execution's runs. */
export default function TestPanel() {
  const [issueKey, setIssueKey] = useState<string | null>(null);
  const [ctx, setCtx] = useState<Context | null>(null);
  const [model, setModel] = useState<TestViewModel | ExecutionViewModel | PlanningViewModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    view.getContext().then(c => setIssueKey((c?.extension as { issue?: { key?: string } })?.issue?.key ?? null))
      .catch(() => setError('The work item could not be identified. Reload the page.'));
  }, []);

  const load = useCallback(async () => {
    if (!issueKey) return;
    setError(null);
    try {
      const c = await invoke<Context & Failure>('tm:context', { issueKey });
      if (c.error) { setError(c.error); return; }
      setCtx(c);
      setModel(null);
      if (c.role && ['TEST', 'EXECUTION', 'PLAN', 'SET', 'PRECONDITION'].includes(c.role)) {
        const method = c.role === 'TEST' ? 'tm:test:get' : c.role === 'EXECUTION' ? 'tm:exec:get' : 'tm:planning:get';
        const m = await invoke<(TestViewModel | ExecutionViewModel | PlanningViewModel) & Failure>(method, { issueKey });
        if (m.error) setError(m.error); else setModel(m);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Test management could not be loaded.'); }
  }, [issueKey]);
  useEffect(() => { load(); }, [load]);

  if (error) return <Page variant="panel"><Notice danger>{error}</Notice><button className="va-button" onClick={load}>Retry</button></Page>;
  if (!ctx) return <Loading />;
  if (!ctx.enabled) return <Page variant="panel"><EmptyState title="Test management is off">A VAtlassian administrator can enable it for this project.</EmptyState></Page>;
  if (ctx.role === 'BUG') return <Page variant="panel"><Notice>This bug was created automatically from a failed, signed test run. Its run is on the linked test execution.</Notice></Page>;
  if (ctx.role === 'SOURCE' && issueKey) return <Page variant="panel"><div className="tm"><CoverageView issueKey={issueKey} scope="SOURCE" /></div></Page>;
  if (!ctx.role) {
    return <Page variant="panel"><EmptyState title="Not a test-management work item">Tests and test executions show their details here.</EmptyState></Page>;
  }
  if (!model) return <Loading />;
  return (
    <Page variant="panel">
      <div className="tm tm-panel-header"><span>Test management</span><button className="va-button" onClick={load}>Refresh</button></div>
      {model.role === 'TEST' ? <>
        <TestView key={model.issue.key} model={model} onModel={setModel}
          coverage={<><CoverageView key={`coverage:${model.versions.map(v => v.state).join()}`} issueKey={model.issue.key} /><SourceDecisions model={model} /></>} />
      </> : model.role === 'EXECUTION' ? <ExecutionView model={model} onModel={setModel} />
        : <PlanningView key={model.issue.key} model={model} onModel={setModel} />}
    </Page>
  );
}
