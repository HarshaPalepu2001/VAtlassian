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

type Restore = { restore_id: string; state: string; field_name?: string; error?: string; report?: unknown; detail?: any };

const tone = (state: string) => state.startsWith('COMPLETE') ? 'success' : state === 'PARTIAL' ? 'warning' : state === 'FAILED' ? 'danger' : 'neutral';

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
    setRetrying(restoreId); setError('');
    try {
      assertResult(await invoke<Result>('restore:retry', { issueKey, restoreId }));
      const result = assertResult(await invoke<Result & { restores: Restore[] }>('restore:getState', { issueKey }));
      setRows(result.restores ?? []);
      view.refresh().catch(() => {});
      await onDone?.();
    } catch (e) {
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
          {['FAILED', 'PARTIAL', 'PENDING'].includes(r.state) && (
            <Button isDisabled={!!retrying} onClick={() => void retry(r.restore_id)}>{retrying === r.restore_id ? PROGRESS.restoreRunning : 'Retry restore'}</Button>
          )}
        </div>
        {r.error && <p className="va-muted">{r.error}</p>}
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
