import { useState } from 'react';
import Button from '@atlaskit/button';
import { Badge, Card, Person } from '../../ui/primitives';
import { AssuranceChip, Collapsible, MaterialityBadge, When } from '../../ui/feedback';
import { plural } from '../../ui/format';
import type { BaselineField, BaselineRecordData, PanelBaseline, PanelLatestApproval } from '../types';

/** The latest transition approval, shown even when it never created a
 *  baseline — see spec 5.2: "latest transition approval owner/time/outcome,
 *  including approvals that did not create a baseline." Rendered as a
 *  deliberate "not yet available" fact rather than being silently omitted. */
function LatestApproval({ approval }: { approval: PanelLatestApproval | null }) {
  return (
    <div className="va-stack va-stack--tight">
      <span className="va-secondary">Latest approval</span>
      {!approval ? (
        <p className="va-muted">No approval has been recorded for this work item yet.</p>
      ) : (
        <div className="va-row">
          <Person name={approval.actorName} meta={<>{approval.decision === 'REJECT' ? 'Rejected' : 'Approved'} <When ms={approval.decidedAt} /></>} noun="reviewer" />
          <span className="va-spacer" />
          <Badge tone={approval.state === 'PENDING' ? 'warning' : 'neutral'}>{approval.state === 'PENDING' ? 'Transition pending' : approval.decision}</Badge>
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
export default function BaselineRecord({ baseline, latestApproval, record, evidenceLoading, evidenceError, onOpen, onRetryEvidence }: {
  baseline: PanelBaseline | null;
  latestApproval: PanelLatestApproval | null;
  record: BaselineRecordData | null;
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
      </div>
    </Card>
  );
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
