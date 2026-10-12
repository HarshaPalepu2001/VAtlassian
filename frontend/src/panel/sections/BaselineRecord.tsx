import { useEffect, useRef, useState } from 'react';
import Button from '@atlaskit/button';
import { Badge, Card, Person } from '../../ui/primitives';
import { AssuranceChip, Collapsible, MaterialityBadge, When } from '../../ui/feedback';
import { formatTimestamp, plural } from '../../ui/format';
import { invoke } from '../../lib/bridge';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import DiffView from '../../review/DiffView';
import type { DiffField, ReviewGroup } from '../../review/types';
import type { BaselineField, BaselineRecordData, PanelBaseline, PanelLatestApproval } from '../types';
import { RestoreLine } from './RestoreStatus';
import type { RestoreRow } from './RestoreStatus';

/** The latest transition approval, shown even when it never created a
 *  baseline — see spec 5.2: "latest transition approval owner/time/outcome,
 *  including approvals that did not create a baseline." Rendered as a
 *  deliberate "not yet available" fact rather than being silently omitted. */
export function LatestApproval({ approval }: { approval: PanelLatestApproval | null }) {
  return (
    <div className="va-stack va-stack--tight">
      <span className="va-secondary">Latest approval</span>
      {!approval ? (
        <p className="va-muted">No approval has been recorded for this work item yet.</p>
      ) : (
        <div className="va-row">
          <Person name={approval.actorName} meta={<>{approval.decision === 'REJECT' ? 'Rejected' : approval.decision === 'MIXED' ? 'Decided field by field' : 'Approved'} <When ms={approval.decidedAt} /></>} noun="reviewer" />
          <span className="va-spacer" />
          <Badge tone={approval.state === 'PENDING' ? 'warning' : 'neutral'}>{approval.state === 'PENDING' ? 'Transition pending' : approval.decision === 'MIXED' ? 'Field decisions' : approval.decision}</Badge>
        </div>
      )}
    </div>
  );
}

/**
 * The approved record — who signed, when, and exactly what they signed.
 *
 * Laid out as a signature block rather than a run-on sentence. It used to read
 * "Approved by Priya · 8 Sep 2026, 20:21", which is three facts joined by
 * punctuation; a reader scanning for the signatory has to parse the whole line.
 * Signatory and time are the two things an auditor looks for first, so they get
 * their own places on the page.
 */
/**
 * `baseline` (version, owner, time, method, tree stats) is a summary fact,
 * present as soon as `panel:getSummary` resolves. The field-level detail and
 * version history inside the disclosure is evidence — `panel:getEvidence` —
 * requested only once the disclosure is opened, via `onOpen`. The header
 * facts and the "latest approval" line stay visible and correct regardless of
 * whether that evidence has loaded, is loading, or failed.
 */
export default function BaselineRecord({ issueKey, baseline, latestApproval, record, restores, evidenceLoading, evidenceError, onOpen, onRetryEvidence }: {
  issueKey?: string;
  baseline: PanelBaseline | null;
  latestApproval: PanelLatestApproval | null;
  record: BaselineRecordData | null;
  /** Every restore of this work item, newest first — the permanent log of what was put back. */
  restores?: RestoreRow[] | null;
  evidenceLoading?: boolean;
  evidenceError?: string;
  onOpen: () => void;
  onRetryEvidence?: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (!baseline) {
    return (
      <Card title="Baseline record">
        <div className="va-stack">
          <LatestApproval approval={latestApproval} />
          <span className="va-secondary">Latest baseline</span>
          <p className="va-muted">
            No baseline has been captured yet. One is recorded the first time this work item
            is approved through a controlled transition.
          </p>
        </div>
      </Card>
    );
  }

  const notRetained = record ? record.fieldCount - record.retainedCount : 0;

  return (
    <div className="va-stack va-record-page">
    {issueKey && <VersionComparison key={`${issueKey}:${baseline.version}`} issueKey={issueKey} latestVersion={baseline.version} />}
    <Card title="Baseline record">
      <div className="va-stack">
        <LatestApproval approval={latestApproval} />
        <div className="va-row">
          <Person name={baseline.approvedName} meta={<>Approved <When ms={baseline.transitionAt ?? baseline.capturedAt} /></>} noun="reviewer" />
          <span className="va-spacer" />
          <Badge tone="brand">Version {baseline.version}</Badge>
          <AssuranceChip level={baseline.assuranceLevel} />
          {baseline.fidelity && (
            <Badge tone={baseline.fidelity === 'EXACT' ? 'success' : 'warning'}>
              {baseline.fidelity === 'EXACT' ? 'Complete capture' : 'Partial capture'}
            </Badge>
          )}
        </div>
        {baseline.capturedBy && (
          <p className="va-secondary">
            Baselined with {baseline.capturedBy.issueKey ?? 'its parent'} version {baseline.capturedBy.version}, signed by
            {' '}{baseline.approvedName ?? 'the parent\'s reviewer'}.
          </p>
        )}
        {baseline.policyIncomplete && (
          <p className="va-warning-text">
            This baseline predates recorded role/method policy. An administrator has been notified;
            drift on it cannot be decided until the incident is resolved.
          </p>
        )}

        <Collapsible
          open={open}
          onToggle={() => { const next = !open; setOpen(next); if (next) onOpen(); }}
          header={
            <span>
              {plural(record ? record.fieldCount : baseline.totalFieldCount, 'tracked field')}
              {record && record.retainedCount < record.fieldCount && (
                <span className="va-muted"> ({record.retainedCount} with saved values)</span>
              )}
            </span>
          }
        >
          {!record && evidenceLoading && <p className="va-muted">Loading tracked fields…</p>}
          {!record && !evidenceLoading && evidenceError && (
            <p className="va-muted">
              Tracked field detail could not be loaded. {evidenceError}
              {' '}<Button appearance="subtle" onClick={() => onRetryEvidence?.()}>Retry</Button>
            </p>
          )}
          {record?.fields.map((f) => (
            <RecordField key={f.fieldId} field={f} />
          ))}
          {notRetained > 0 && (
            <p className="va-subtlest" style={{ marginTop: 8 }}>
              Values were not retained for {plural(notRetained, 'field')}.
              {notRetained === 1 ? ' Its digest' : ' Their digests'} still
              {notRetained === 1 ? ' detects' : ' detect'} changes, but the approved
              {notRetained === 1 ? ' contents cannot' : ' contents cannot'} be shown or restored.
            </p>
          )}
          {baseline.nodeCount != null && (
            <div style={{ marginTop: 16 }}>
              <strong>Recursive Baseline Tree</strong>
              <ul style={{ margin: '8px 0 0 16px', padding: 0 }}>
                <li><strong>Nodes:</strong> {baseline.nodeCount}</li>
                <li><strong>Edges:</strong> {baseline.edgeCount}</li>
                <li><strong>Total fields:</strong> {baseline.totalFieldCount}</li>
                {baseline.treeHash && <li><strong>Tree Hash:</strong> <code className="va-hash">{baseline.treeHash}</code></li>}
              </ul>
            </div>
          )}
        </Collapsible>

        {!!record?.history?.length && (
          <details className="va-details">
            <summary>Earlier versions</summary>
            <div style={{ marginTop: 8 }}>
              {record.history.map((v) => (
                <div className="va-trace-row" key={v.version}>
                  <span className="va-grow va-truncate">
                    Version {v.version} — {v.approvedName ?? 'Reviewer'}
                  </span>
                  <AssuranceChip level={v.assuranceLevel} />
                  <When ms={v.approvedAt} />
                </div>
              ))}
            </div>
          </details>
        )}

        {!!restores?.length && (
          <div className="va-stack va-stack--tight" aria-label="Restores">
            <span className="va-secondary">Restores</span>
            {restores.map(r => <RestoreLine key={r.restore_id} restore={r} />)}
          </div>
        )}
      </div>
    </Card>
    </div>
  );
}

type Comparison = Result & { fromVersion: number; toVersion: number;
  from: { approvedName?: string | null; approvedAt?: number | null };
  to: { approvedName?: string | null; approvedAt?: number | null };
  fields: DiffField[]; groups?: ReviewGroup[]; changedFieldCount: number; incomplete?: boolean };

function VersionComparison({ issueKey, latestVersion }: { issueKey: string; latestVersion: number }) {
  const defaultFrom = Math.max(1, latestVersion - 1);
  const [fromDraft, setFromDraft] = useState(String(defaultFrom));
  const [toDraft, setToDraft] = useState(String(latestVersion));
  const [pair, setPair] = useState({ from: defaultFrom, to: latestVersion });
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);

  useEffect(() => {
    if (latestVersion < 2) return;
    const ticket = ++sequence.current;
    setLoading(true); setError(''); setComparison(null);
    invoke<Comparison>('panel:compareVersions', { issueKey, fromVersion: pair.from,
      toVersion: pair.to, expectedBaselineVersion: latestVersion })
      .then(raw => {
        const next = assertResult(raw);
        if (ticket === sequence.current) {
          if (next.fromVersion !== pair.from || next.toVersion !== pair.to) throw new Error('The requested versions changed while loading.');
          setComparison(next);
        }
      })
      .catch(e => { if (ticket === sequence.current) setError(errorMessage(e)); })
      .finally(() => { if (ticket === sequence.current) setLoading(false); });
    return () => { ++sequence.current; };
  }, [issueKey, latestVersion, pair.from, pair.to, retry]);

  function compare() {
    const from = Number(fromDraft), to = Number(toDraft);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < 1 || from > latestVersion || to > latestVersion) {
      setError(`Choose versions from 1 to ${latestVersion}.`); setComparison(null); return;
    }
    if (from === pair.from && to === pair.to) setRetry(value => value + 1);
    else setPair({ from, to });
  }

  return <section className="va-version-compare" aria-label="Compare signed versions">
    <div className="va-version-compare__head">
      <div><h3>Compare signed versions</h3><p className="va-secondary">Choose any two saved baselines to see what each signature recorded.</p></div>
      {latestVersion > 1 && <div className="va-version-compare__controls">
        <label>From version <input type="number" min="1" max={latestVersion} value={fromDraft} onChange={event => setFromDraft(event.target.value)} /></label>
        <label>To version <input type="number" min="1" max={latestVersion} value={toDraft} onChange={event => setToDraft(event.target.value)} /></label>
        <button type="button" className="va-btn" onClick={compare}>Compare</button>
      </div>}
    </div>
    {latestVersion < 2 && <p className="va-muted">A second signed baseline will make version comparison available.</p>}
    {loading && <p className="va-muted">Loading saved versions…</p>}
    {error && <p className="va-warning-text" role="alert">Version comparison could not be loaded. {error} <button type="button" className="va-link-button" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
    {comparison && <>
      {comparison.incomplete && <p className="va-warning-text" role="status">This comparison is incomplete because one or more historical work items cannot be verified against your current Jira access. Visible differences are shown below; a match does not establish that the complete baselines are identical.</p>}
      <div className="va-version-compare__provenance">
        <span><strong>Version {comparison.fromVersion}</strong> · {comparison.from.approvedName ?? 'Reviewer'} · {formatTimestamp(comparison.from.approvedAt) ?? 'Time unavailable'}</span>
        <span aria-hidden>→</span>
        <span><strong>Version {comparison.toVersion}</strong> · {comparison.to.approvedName ?? 'Reviewer'} · {formatTimestamp(comparison.to.approvedAt) ?? 'Time unavailable'}</span>
        <span className="va-secondary">{plural(comparison.changedFieldCount, 'difference')}</span>
      </div>
      <div className="va-version-compare__diff"><DiffView fields={comparison.fields} groups={comparison.groups}
        mode="versions" fromVersion={comparison.fromVersion} toVersion={comparison.toVersion} incomplete={comparison.incomplete} /></div>
      <p className="va-subtlest">This compares signed snapshots. The Changes tab shows edits since the active baseline and their Jira history.</p>
    </>}
  </section>;
}

function RecordField({ field }: {field: BaselineField}) {
  return (
    <details className="va-record-field">
      <summary>
        <span className="va-grow"><strong>{field.fieldName}</strong></span>
        <MaterialityBadge level={field.materiality} />
        {!field.retained && <Badge>Value not kept</Badge>}
      </summary>
      <p className="va-approved-value">
        {!field.retained
          ? 'Only the digest is retained, so the approved contents cannot be shown.'
          : !field.preview
            ? 'Approved value unavailable.'
            : field.preview.empty
              ? 'Approved with no value'
              : `${field.preview.text ?? ''}${field.preview.truncated ? '…' : ''}`}
      </p>
      {field.preview?.truncated && (
        <p className="va-muted">Preview shortened. Comparisons use the complete retained value.</p>
      )}
      {field.digest && <code className="va-hash">{field.digest}</code>}
    </details>
  );
}
