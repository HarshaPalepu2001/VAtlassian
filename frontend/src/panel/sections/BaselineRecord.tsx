import { useState } from 'react';
import { Badge, Card, Facts, Person } from '../../ui/primitives';
import { AssuranceChip, Collapsible, MaterialityBadge, Notice, When } from '../../ui/feedback';
import { plural } from '../../ui/format';
import type { BaselineRecordData, BaselineField } from '../types';

/**
 * The approved record — who signed, when, and exactly what they signed.
 *
 * Laid out as a signature block rather than a run-on sentence. It used to read
 * "Approved by Priya · 8 Sep 2026, 20:21", which is three facts joined by
 * punctuation; a reader scanning for the signatory has to parse the whole line.
 * Signatory and time are the two things an auditor looks for first, so they get
 * their own places on the page.
 */
export default function BaselineRecord({ record }: {record: BaselineRecordData | null}) {
  const [open, setOpen] = useState(false);

  if (!record) {
    return (
      <Card title="Baseline record">
        <p className="va-muted">
          No baseline has been captured yet. One is recorded the first time this work item
          is approved through a controlled transition.
        </p>
      </Card>
    );
  }

  const notRetained = record.fieldCount - record.retainedCount;

  return (
    <Card title="Baseline record">
      <div className="va-stack">
        <div className="va-row">
          <Person name={record.approvedName} meta={<>Approved <When ms={record.approvedAt} /></>} noun="reviewer" />
          <span className="va-spacer" />
          <Badge tone="brand">Version {record.version}</Badge>
          <AssuranceChip level={record.assuranceLevel} />
          {record.fidelity && (
            <Badge tone={record.fidelity === 'EXACT' ? 'success' : 'warning'}>
              {record.fidelity === 'EXACT' ? 'Complete capture' : 'Partial capture'}
            </Badge>
          )}
        </div>

        <Collapsible
          open={open}
          onToggle={() => setOpen(!open)}
          header={
            <span className="va-grow">
              <strong>{plural(record.fieldCount, 'tracked field')}</strong>
              <span className="va-muted"> — view what was approved</span>
            </span>
          }
        >
          <Facts
            items={[
              { label: 'Captured', value: <When ms={record.capturedAt} /> },
              { label: 'Content hash', value: <code className="va-hash">{record.contentHash ?? 'Not recorded'}</code> }
            ]}
          />
          {record.fieldCount === 0 && <Notice>This baseline contains no tracked fields.</Notice>}
          <div style={{ marginTop: 12 }}>
            {record.fields.map((field) => <RecordField key={field.fieldId} field={field} />)}
          </div>
          {notRetained > 0 && (
            <p className="va-muted" style={{ marginTop: 12 }}>
              {plural(notRetained, 'field value')} {notRetained === 1 ? 'is' : 'are'} not retained.
              {notRetained === 1 ? ' Its digest' : ' Their digests'} still
              {notRetained === 1 ? ' detects' : ' detect'} changes, but the approved
              {notRetained === 1 ? ' contents cannot' : ' contents cannot'} be shown or restored.
            </p>
          )}
        </Collapsible>

        {!!record.history?.length && (
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
