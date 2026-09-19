import { useEffect, useRef, useState } from 'react';
import { view } from '@forge/bridge';
import Button from '@atlaskit/button';
import { invoke } from '../../lib/bridge';
import { Badge, Card } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { PanelRestore } from '../types';
import { PROGRESS, restoreStateLabel } from '../approvalModel';
import { recordHarnessEvent } from '../../lib/harness';


type Restore = { restore_id: string; state: string; field_name?: string; error?: string; last_error?: string; report?: unknown; detail?: any };

type Unmatched = { issueKey?: string | null; fieldName?: string | null; kind?: string; reason?: string };
type Refused = { kind?: string; issueKey?: string | null; error?: { detail?: string } };

const summaryOf = (detail: any) => Array.isArray(detail) ? detail.find((entry: any) => entry && typeof entry === 'object') : null;

/**
 * What stopped this restore being complete, in the reviewer's own terms.
 *
 * A badge reading PARTIAL next to "All tracked fields" told a reviewer that
 * something had not been put back and gave them no way to find out what — on a
 * work item that, on screen, looked entirely correct. The verifier has always
 * known which field on which work item refused to match; this is where that
 * finally reaches the person who has to decide what to do about it.
 */
function Outstanding({ detail }: { detail: any }) {
  const summary = summaryOf(detail);
  const unmatched: Unmatched[] = summary?.unmatched ?? summary?.verification?.unmatched ?? [];
  const refused: Refused[] = summary?.refused ?? [];
  if (!unmatched.length && !refused.length) return null;

  return <div style={{ marginLeft: 12 }}>
    {!!unmatched.length && <>
      <p className="va-muted">Still not matching the approved values:</p>
      <ul style={{ marginTop: 4 }}>
        {unmatched.map((entry, idx) => (
          <li key={`u${idx}`}>
            <strong>{entry.fieldName ?? entry.kind ?? 'This work item'}</strong>
            {entry.issueKey ? ` on ${entry.issueKey}` : ''}
            {entry.reason ? ` — ${entry.reason}` : ''}
          </li>
        ))}
      </ul>
    </>}
    {!!refused.length && <>
      <p className="va-muted">Jira refused these changes:</p>
      <ul style={{ marginTop: 4 }}>
        {refused.map((entry, idx) => (
          <li key={`r${idx}`}>
            {entry.kind ?? 'Change'}{entry.issueKey ? ` on ${entry.issueKey}` : ''}
            {entry.error?.detail ? ` — ${entry.error.detail}` : ''}
          </li>
        ))}
      </ul>
    </>}
  </div>;
}

const tone = (state: string) => state.startsWith('COMPLETE') ? 'success' : state === 'PARTIAL' ? 'warning' : ['FAILED', 'QUEUING_FAILED', 'ERROR'].includes(state) ? 'danger' : 'neutral';

/**
 * Restoration detail, read only once the summary reports a restoration and
 * re-read whenever that summary fact changes. The panel's own refresh
 * triggers drive it, so this section never subscribes to events separately.
 * The centralised bridge emits VA_ISSUE_CHANGED after a durable
 * 'restore:retry' (see lib/bridge.ts); this component never emits.
 */
export default function RestoreStatus({ issueKey, restore, onDone }: { issueKey?: string; restore: PanelRestore | null; onDone?: () => void | Promise<void> }) {
  const [rows, setRows] = useState<Restore[]>([]);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState('');
  const lock = useRef(false);
  const revision = restore ? `${restore.restoreId}:${restore.state}:${restore.succeeded}:${restore.failed}:${restore.skipped}` : '';

  useEffect(() => {
    if (!revision) return;
    let active = true;
    invoke<Result & { restores: Restore[] }>('restore:getState', { issueKey })
      .then(result => { if (active) { setRows(assertResult(result).restores ?? []); setError(''); } })
      .catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [issueKey, revision]);

  async function retry(restoreId: string) {
    if (lock.current) return;
    lock.current = true;
    recordHarnessEvent('RESTORE', 'click:retryRestore', { restoreId, issueKey });
    setRetrying(restoreId); setError('');
    try {
      assertResult(await invoke<Result>('restore:retry', { issueKey, restoreId }));
      recordHarnessEvent('RESTORE', 'retryRestore:dispatched', { restoreId, issueKey });
      const result = assertResult(await invoke<Result & { restores: Restore[] }>('restore:getState', { issueKey }));
      setRows(result.restores ?? []);
      view.refresh().catch(() => {});
      await onDone?.();
    } catch (e) {
      recordHarnessEvent('ERROR', 'retryRestore:failed', { restoreId, issueKey }, e);
      setError(errorMessage(e));
    } finally {
      lock.current = false;
      setRetrying('');
    }
  }


  if (!restore) return null;
  const shown: Restore[] = rows.length ? rows : [{ restore_id: restore.restoreId, state: restore.state }];

  // A restore is only "complete" once every tracked field has been read back and
  // matched, so the state is the headline rather than an afterthought appended
  // to the field name with a middle dot.
  return <Card title="Restoration results" subtitle="A field counts as restored only after Jira has been read back and its value matched.">
    {error && <Notice danger>{error}</Notice>}
    {shown.map(r => {
      const replacements = r.detail?.find?.((d: any) => d.replacements)?.replacements;
      return <div key={r.restore_id} className="va-record-field va-stack">
        <div className="va-row">
          <Badge tone={tone(r.state)}>{restoreStateLabel(r.state)}</Badge>
          <span className="va-grow va-truncate">{r.field_name ?? 'All tracked fields'}</span>
          {['FAILED', 'PARTIAL', 'PENDING', 'QUEUING_FAILED', 'ERROR'].includes(r.state) && (
            <Button isDisabled={!!retrying} onClick={() => void retry(r.restore_id)}>{retrying === r.restore_id ? PROGRESS.restoreRunning : 'Retry restore'}</Button>
          )}
        </div>
        {(r.error || r.last_error) && <p className="va-muted">{r.error || r.last_error}</p>}
        <Outstanding detail={r.detail} />
        {!!replacements?.length && (
          <div style={{ marginLeft: 12 }}>
            <p className="va-muted">Recreated nodes:</p>
            <ul style={{ marginTop: 4 }}>
              {replacements.map((rep: any, idx: number) => (
                <li key={idx}>Replaced logical node {rep.logicalNodeId} with {rep.newIssueKey || rep.newIssueId}</li>
              ))}
            </ul>
          </div>
        )}
        {r.report != null && <details className="va-details"><summary>Per-field result</summary><pre className="va-json">{JSON.stringify(r.report, null, 2)}</pre></details>}
      </div>;
    })}
  </Card>;
}
