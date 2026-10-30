import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { view } from '@forge/bridge';
import Button from '@atlaskit/button';
import { invoke } from '../../lib/bridge';
import { Badge, Card } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import { formatTimestamp } from '../../ui/format';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { PanelRestore } from '../types';
import { PROGRESS, restoreStateLabel } from '../approvalModel';
import { recordHarnessEvent } from '../../lib/harness';


/** One restore as `restore:getState` reports it. */
export type RestoreRow = {
  restore_id: string; state: string; field_name?: string; error?: string | null; last_error?: string | null; report?: unknown; detail?: any;
  actorName?: string | null; startedAt?: number | null; finishedAt?: number | null; baselineVersion?: number | null;
  /** False when the server says this viewer may not retry it (only the reviewer who rejected may). */
  canRetry?: boolean;
  progress?: { totalSteps: number; completedSteps: number; remainingSteps: number };
};

type Unmatched = { issueKey?: string | null; fieldName?: string | null; kind?: string; reason?: string };
type Refused = { kind?: string; issueKey?: string | null; error?: { detail?: string } };

const SUCCEEDED = ['COMPLETE', 'COMPLETE_WITH_REPLACEMENTS'];
const UNSUCCESSFUL = ['PARTIAL', 'FAILED', 'QUEUING_FAILED', 'ERROR'];

/** A restore is finished once it has succeeded or stopped trying. Only then
 *  does it leave the progress card and become a line on the Baseline card. */
export const restoreFinished = (state?: string | null) => !!state && (SUCCEEDED.includes(state) || UNSUCCESSFUL.includes(state));

/**
 * Show a restore only on the baseline version it restored. The review
 * window retains all restores. The server refuses retries against a newer
 * baseline with STALE_BASELINE.
 * If no version was recorded, include the restore only when it finished after
 * this baseline was signed. Omit restores whose baseline cannot be identified.
 */
export function restoreBelongsTo(restore: PanelRestore | null | undefined,
  baseline: { version: number; transitionAt?: number | null; capturedAt?: number | null } | null | undefined): boolean {
  if (!restore || !baseline) return false;
  if (restore.baselineVersion != null) return restore.baselineVersion === baseline.version;
  const signedAt = baseline.transitionAt ?? baseline.capturedAt ?? null;
  const at = restore.finishedAt ?? restore.queuedAt ?? null;
  return signedAt != null && at != null && at >= signedAt;
}

const summaryOf = (detail: any) => Array.isArray(detail) ? detail.find((entry: any) => entry && typeof entry === 'object') : null;
const unmatchedOf = (detail: any): Unmatched[] => summaryOf(detail)?.unmatched ?? summaryOf(detail)?.verification?.unmatched ?? [];
const refusedOf = (detail: any): Refused[] => summaryOf(detail)?.refused ?? [];
const replacementsOf = (detail: any): any[] => detail?.find?.((d: any) => d.replacements)?.replacements ?? [];

/**
 * Show which fields on which work items failed restore verification so the
 * reviewer can identify what still needs attention.
 */
function Outstanding({ detail }: { detail: any }) {
  const unmatched = unmatchedOf(detail);
  const refused = refusedOf(detail);
  if (!unmatched.length && !refused.length) return null;

  return <div>
    {!!unmatched.length && <>
      <p className="va-muted">Still not matching the approved values:</p>
      <ul style={{ marginTop: 4 }}>
        {unmatched.map((entry, idx) => (
          <li key={`u${idx}`}>
            <strong>{entry.fieldName ?? entry.kind ?? 'This work item'}</strong>
            {entry.issueKey ? ` on ${entry.issueKey}` : ''}
            {entry.reason ? `. ${entry.reason}` : ''}
          </li>
        ))}
      </ul>
    </>}
    {!!refused.length && <>
      {/* Jira's refusals and the app's own (a link another item's approval
          still holds, lib/restore/linkConflicts.js); each line says which. */}
      <p className="va-muted">Not restored:</p>
      <ul style={{ marginTop: 4 }}>
        {refused.map((entry, idx) => (
          <li key={`r${idx}`}>
            {entry.kind ?? 'Change'}{entry.issueKey ? ` on ${entry.issueKey}` : ''}
            {entry.error?.detail ? `. ${entry.error.detail}` : ''}
          </li>
        ))}
      </ul>
    </>}
  </div>;
}

const hasDetails = (r: RestoreRow) => Boolean(r.error || r.last_error || unmatchedOf(r.detail).length || refusedOf(r.detail).length
  || replacementsOf(r.detail).length || r.report != null);

/** Everything a finished restore can say about itself, behind a closed Details toggle. */
function RestoreDetails({ restore: r }: { restore: RestoreRow }) {
  const replacements = replacementsOf(r.detail);
  return <details className="va-details">
    <summary>Details</summary>
    <div className="va-stack va-stack--tight" style={{ marginTop: 8 }}>
      {(r.error || r.last_error) && <p className="va-muted" style={{ margin: 0 }}>{r.error || r.last_error}</p>}
      <Outstanding detail={r.detail} />
      {!!replacements.length && <div>
        <p className="va-muted">Recreated nodes:</p>
        <ul style={{ marginTop: 4 }}>
          {replacements.map((rep: any, idx: number) => (
            <li key={idx}>Replaced logical node {rep.logicalNodeId} with {rep.newIssueKey || rep.newIssueId}</li>
          ))}
        </ul>
      </div>}
      {r.report != null && <details className="va-details"><summary>Per-field result</summary><pre className="va-json">{JSON.stringify(r.report, null, 2)}</pre></details>}
    </div>
  </details>;
}

const tone = (state: string) => state.startsWith('COMPLETE') ? 'success' : state === 'PARTIAL' ? 'warning' : ['FAILED', 'QUEUING_FAILED', 'ERROR'].includes(state) ? 'danger' : 'neutral';

/**
 * One restore, as a line on the record: the outcome, which version it put the
 * work item back to, who asked for it and when it finished. The Baseline card
 * shows the latest; the review window's Baseline record lists them all.
 */
export function RestoreLine({ restore: r, action }: { restore: RestoreRow; action?: ReactNode }) {
  const version = r.baselineVersion != null ? `version ${r.baselineVersion}` : 'the baseline';
  const at = r.finishedAt ?? r.startedAt ?? null;
  const meta = [
    SUCCEEDED.includes(r.state) ? `Back to ${version}` : `Restoring ${version}`,
    r.actorName ? `by ${r.actorName}` : '',
    formatTimestamp(at) ?? ''
  ].filter(Boolean).join(' · ');
  return <div className="va-restore-line va-stack va-stack--tight">
    <div className="va-row">
      <Badge tone={tone(r.state)}>{restoreStateLabel(r.state)}</Badge>
      <span className="va-grow va-secondary">{meta}</span>
      {action}
    </div>
    {hasDetails(r) && <RestoreDetails restore={r} />}
  </div>;
}

/**
 * Show a progress card while the latest restore runs. When it finishes,
 * IssuePanel shows its outcome on the Baseline card and offers Retry if
 * some fields were not restored.
 *
 * Read details only after the summary reports a restore, and refresh them
 * when that summary changes. Panel refresh triggers handle subscriptions.
 * lib/bridge.ts emits VA_ISSUE_CHANGED after a durable restore:retry.
 */
export default function RestoreStatus({ issueKey, restore, onDone }: { issueKey?: string; restore: PanelRestore | null; onDone?: () => void | Promise<void> }) {
  const [rows, setRows] = useState<RestoreRow[]>([]);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState('');
  const lock = useRef(false);
  const revision = restore ? `${restore.restoreId}:${restore.state}:${restore.succeeded}:${restore.failed}:${restore.skipped}` : '';

  useEffect(() => {
    if (!revision) return;
    let active = true;
    invoke<Result & { restores: RestoreRow[] }>('restore:getState', { issueKey })
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
      const result = assertResult(await invoke<Result & { restores: RestoreRow[] }>('restore:getState', { issueKey }));
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
  // Newest first, the same order the summary took its restore from.
  const latest: RestoreRow = rows[0] ?? { restore_id: restore.restoreId, state: restore.state,
    finishedAt: restore.finishedAt ?? null, baselineVersion: restore.baselineVersion ?? null };
  const retryButton = (
    <Button isDisabled={!!retrying} onClick={() => void retry(latest.restore_id)}>
      {retrying === latest.restore_id ? PROGRESS.restoreRunning : 'Retry restore'}
    </Button>
  );

  if (restoreFinished(restore.state)) {
    // A retry resumes the rejecter's own signature, so the server refuses
    // anyone else. They still see the outcome, and are told what they can do.
    const othersRestore = latest.canRetry === false;
    return <div className="va-base__restore va-stack va-stack--tight">
      {error && <Notice danger>{error}</Notice>}
      <RestoreLine restore={latest} action={UNSUCCESSFUL.includes(latest.state) && !othersRestore ? retryButton : undefined} />
      {UNSUCCESSFUL.includes(latest.state) && othersRestore && (
        <p className="va-secondary">
          Only {latest.actorName ?? 'the reviewer'}, who rejected these changes, can retry this restore.
          {' '}You can still approve or reject the changes.
        </p>
      )}
    </div>;
  }

  // A restore is only "complete" once every tracked field has been read back and
  // matched, so the state is the headline rather than an afterthought appended
  // to the field name with a middle dot.
  const steps = latest.progress
    ?? (restore.totalSteps ? { totalSteps: restore.totalSteps, completedSteps: restore.completedSteps ?? 0, remainingSteps: 0 } : undefined);
  return <Card title="Restoration results" subtitle="A field counts as restored only after Jira has been read back and its value matched.">
    {error && <Notice danger>{error}</Notice>}
    <div className="va-record-field va-stack">
      <div className="va-row">
        <Badge tone={tone(latest.state)}>{restoreStateLabel(latest.state)}</Badge>
        <span className="va-grow va-truncate">
          {latest.field_name ?? 'All tracked fields'}
          {steps?.totalSteps ? <span className="va-secondary"> · {steps.completedSteps} of {steps.totalSteps} steps</span> : null}
        </span>
        {latest.state === 'PENDING' && retryButton}
      </div>
      {(latest.error || latest.last_error) && <p className="va-muted">{latest.error || latest.last_error}</p>}
    </div>
  </Card>;
}
