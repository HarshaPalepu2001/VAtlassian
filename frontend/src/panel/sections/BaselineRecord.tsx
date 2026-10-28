import { useEffect, useRef, useState } from 'react';
import Button from '@atlaskit/button';
import { Person } from '../../ui/primitives';
import { When } from '../../ui/feedback';
import { formatDate, formatTimestamp, plural } from '../../ui/format';
import { invoke } from '../../lib/bridge';
import { assuranceLabel } from '../../lib/assurance';
import type { AssuranceLevel } from '../../lib/assurance';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import DiffView from '../../review/DiffView';
import type { DiffField, ReviewGroup } from '../../review/types';
import type { BaselineField, BaselineRecordData, PanelBaseline, PanelLatestApproval } from '../types';
import { RestoreLine } from './RestoreStatus';
import type { RestoreRow } from './RestoreStatus';

/** The latest decision on this work item, in one line — including one that
 *  never created a baseline (spec 5.2). Never silently omitted. */
export function LatestApproval({ approval }: { approval: PanelLatestApproval | null }) {
  if (!approval) return <p className="va-subtlest">No decision has been recorded for this work item yet.</p>;
  const outcome = approval.decision === 'REJECT' ? 'Rejected' : approval.decision === 'MIXED' ? 'Decided field by field' : 'Approved';
  return (
    <div className="va-row va-history__latest">
      <span className="va-secondary">Latest decision</span>
      <Person name={approval.actorName} meta={<>{outcome} <When ms={approval.decidedAt} /></>} noun="reviewer" />
      {approval.state === 'PENDING' && <span className="va-lozenge va-lozenge--moved">Transition pending</span>}
      {approval.decision === 'MIXED' && approval.state !== 'PENDING' && <span className="va-subtlest">Field decisions</span>}
    </div>
  );
}

type Version = { version: number; approvedName?: string | null; approvedAt?: number | null; assuranceLevel?: AssuranceLevel | null; current?: boolean };

/**
 * THE HISTORY: every signed version of this work item, newest first, the way
 * an ALM tool lists them. Any version can be compared with the one before it
 * in a click, or any two ticked and compared. Restores sit under the versions
 * they put back; the tracked fields, with what each signature recorded, are
 * folded away until asked for.
 */
export default function BaselineRecord({ issueKey, baseline, latestApproval, record, restores, evidenceLoading, evidenceError, onRetryEvidence }: {
  issueKey?: string;
  baseline: PanelBaseline | null;
  latestApproval: PanelLatestApproval | null;
  record: BaselineRecordData | null;
  /** Every restore of this work item, newest first — the permanent log of what was put back. */
  restores?: RestoreRow[] | null;
  evidenceLoading?: boolean;
  evidenceError?: string;
  onOpen?: () => void;
  onRetryEvidence?: () => void;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [pair, setPair] = useState<{ from: number; to: number } | null>(null);

  if (!baseline) {
    return (
      <div className="va-history">
        <p className="va-secondary">No baseline yet. One is recorded the first time this work item is approved.</p>
        <LatestApproval approval={latestApproval} />
      </div>
    );
  }

  const versions: Version[] = [
    { version: baseline.version, approvedName: baseline.approvedName, approvedAt: baseline.transitionAt ?? baseline.capturedAt, assuranceLevel: baseline.assuranceLevel, current: true },
    ...(record?.history ?? []).filter(v => v.version !== baseline.version).sort((a, b) => b.version - a.version)
  ];
  const toggle = (version: number) => setPicked(now => now.includes(version) ? now.filter(v => v !== version) : [...now, version].slice(-2));
  const [low, high] = [...picked].sort((a, b) => a - b);
  const notRetained = record ? record.fieldCount - record.retainedCount : 0;

  return (
    <div className="va-history">
      {baseline.capturedBy && (
        <p className="va-secondary">Baselined with {baseline.capturedBy.issueKey ?? 'its parent'} version {baseline.capturedBy.version}.</p>
      )}
      {baseline.policyIncomplete && (
        <p className="va-warning-text">This baseline predates recorded role and method policy, so its changes can't be decided until an administrator resolves the incident.</p>
      )}

      <table className="va-history__table" aria-label="Signed versions">
        <thead>
          <tr><th aria-label="Select to compare" /><th>Version</th><th>Signed by</th><th>Date</th><th>Method</th><th /></tr>
        </thead>
        <tbody>
          {versions.map(v => (
            <tr key={v.version} className={picked.includes(v.version) ? 'is-picked' : undefined}>
              <td><input type="checkbox" aria-label={`Select version ${v.version} to compare`} checked={picked.includes(v.version)} onChange={() => toggle(v.version)} /></td>
              <td><strong>{v.version}</strong>{v.current && <span className="va-lozenge va-lozenge--default">Current</span>}</td>
              <td>{v.approvedName ?? 'Unrecorded'}</td>
              <td title={formatTimestamp(v.approvedAt) ?? undefined}>{formatDate(v.approvedAt) ?? '—'}</td>
              <td className="va-secondary">{v.assuranceLevel ? assuranceLabel(v.assuranceLevel) : '—'}</td>
              <td className="va-history__act">
                {v.version > 1 && <button type="button" className="va-link-button" onClick={() => setPair({ from: v.version - 1, to: v.version })}>Compare with {v.version - 1}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {picked.length === 2 && (
        <div className="va-row">
          <span className="va-secondary va-grow">Versions {low} and {high} selected</span>
          <Button appearance="primary" onClick={() => setPair({ from: low, to: high })}>Compare {low} → {high}</Button>
        </div>
      )}
      {baseline.version < 2 && <p className="va-subtlest">Comparing becomes available once a second version is signed.</p>}
      {issueKey && pair && (
        <VersionComparison key={`${issueKey}:${pair.from}:${pair.to}`} issueKey={issueKey} from={pair.from} to={pair.to}
          latestVersion={baseline.version} onClose={() => setPair(null)} />
      )}

      <LatestApproval approval={latestApproval} />

      {!!restores?.length && (
        <div className="va-stack va-stack--tight" aria-label="Restores">
          <h4 className="va-history__heading">Restores</h4>
          {restores.map(r => <RestoreLine key={r.restore_id} restore={r} />)}
        </div>
      )}

      <details className="va-history__fields">
        <summary>Tracked fields · {record ? record.fieldCount : baseline.totalFieldCount}</summary>
        {!record && evidenceLoading && <p className="va-muted">Loading tracked fields…</p>}
        {!record && !evidenceLoading && evidenceError && (
          <p className="va-muted">Tracked field detail could not be loaded. {evidenceError} <Button appearance="subtle" onClick={() => onRetryEvidence?.()}>Retry</Button></p>
        )}
        {record?.fields.map(f => <RecordField key={f.fieldId} field={f} />)}
        {notRetained > 0 && (
          <p className="va-subtlest">
            Values were not kept for {plural(notRetained, 'field')}. Their digests still detect changes, but the signed contents can't be shown or restored.
          </p>
        )}
      </details>
    </div>
  );
}

type Comparison = Result & { fromVersion: number; toVersion: number;
  from: { approvedName?: string | null; approvedAt?: number | null };
  to: { approvedName?: string | null; approvedAt?: number | null };
  fields: DiffField[]; groups?: ReviewGroup[]; changedFieldCount: number; incomplete?: boolean };

/** Two signed versions side by side, in the same merge view as Changes, read-only. */
function VersionComparison({ issueKey, from, to, latestVersion, onClose }: { issueKey: string; from: number; to: number; latestVersion: number; onClose: () => void }) {
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);

  useEffect(() => {
    const ticket = ++sequence.current;
    setError(''); setComparison(null);
    invoke<Comparison>('panel:compareVersions', { issueKey, fromVersion: from, toVersion: to, expectedBaselineVersion: latestVersion })
      .then(raw => {
        const next = assertResult(raw);
        if (ticket !== sequence.current) return;
        if (next.fromVersion !== from || next.toVersion !== to) throw new Error('The requested versions changed while loading.');
        setComparison(next);
      })
      .catch(e => { if (ticket === sequence.current) setError(errorMessage(e)); });
    return () => { ++sequence.current; };
  }, [issueKey, from, to, latestVersion, retry]);

  return (
    <section className="va-version-compare" aria-label="Compare signed versions">
      <div className="va-row">
        <h4 className="va-history__heading va-grow">Version {from} → {to}</h4>
        <button type="button" className="va-link-button" onClick={onClose}>Close comparison</button>
      </div>
      {!comparison && !error && <p className="va-muted">Loading saved versions…</p>}
      {error && <p className="va-warning-text" role="alert">The comparison could not be loaded. {error} <button type="button" className="va-link-button" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
      {comparison && <>
        <p className="va-secondary">
          Signed by {comparison.from.approvedName ?? 'an unrecorded reviewer'}{comparison.from.approvedAt ? ` on ${formatDate(comparison.from.approvedAt)}` : ''}
          {' → '}{comparison.to.approvedName ?? 'an unrecorded reviewer'}{comparison.to.approvedAt ? ` on ${formatDate(comparison.to.approvedAt)}` : ''}
          {' · '}{plural(comparison.changedFieldCount, 'difference')}
        </p>
        {comparison.incomplete && <p className="va-warning-text" role="status">Some work items in these versions can't be checked with your current Jira access. Differences you can see are shown; a match does not prove the versions are identical.</p>}
        <DiffView fields={comparison.fields} groups={comparison.groups} mode="versions" fromVersion={comparison.fromVersion} toVersion={comparison.toVersion} incomplete={comparison.incomplete} />
      </>}
    </section>
  );
}

function RecordField({ field }: { field: BaselineField }) {
  return (
    <div className="va-history__field">
      <span className="va-history__field-name">{field.fieldName}</span>
      <span className="va-history__field-value">
        {!field.retained ? <span className="va-muted">Value not kept</span>
          : !field.preview ? <span className="va-muted">Value unavailable</span>
            : field.preview.empty ? <span className="va-muted">Empty</span>
              : `${field.preview.text ?? ''}${field.preview.truncated ? '…' : ''}`}
      </span>
      {field.digest && <code className="va-hash" title={field.digest}>{field.digest.slice(0, 12)}</code>}
    </div>
  );
}
