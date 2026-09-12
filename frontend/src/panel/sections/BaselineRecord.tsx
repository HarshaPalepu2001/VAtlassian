import { useState } from 'react';
import { Badge, Card, Person } from '../../ui/primitives';
import { AssuranceChip, Collapsible, MaterialityBadge, When } from '../../ui/feedback';
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
  const recordName = record.approvedName ?? (record as any).approved_name;
  const recordAt = record.approvedAt ?? (record as any).transition_at ?? (record as any).capturedAt ?? (record as any).captured_at;
  const recordLevel = record.assuranceLevel ?? (record as any).assurance_level;

  return (
    <Card title="Baseline record">
      <div className="va-stack">
        <div className="va-row">
          <Person name={recordName} meta={<>Approved <When ms={recordAt} /></>} noun="reviewer" />
          <span className="va-spacer" />
          <Badge tone="brand">Version {record.version}</Badge>
          <AssuranceChip level={recordLevel} />
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
            <span>
              {plural(record.fieldCount, 'tracked field')}
              {record.retainedCount < record.fieldCount && (
                <span className="va-muted">
                  {' '}
                  ({record.retainedCount} with saved values)
                </span>
              )}
            </span>
          }
        >
          {record.fields.map((f) => (
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
        </Collapsible>

        {!!record.history?.length && (
          <details className="va-details">
            <summary>Earlier versions</summary>
            <div style={{ marginTop: 8 }}>
              {record.history.map((v) => {
                const name = v.approvedName ?? (v as any).approved_name ?? 'Reviewer';
                const level = v.assuranceLevel ?? (v as any).assurance_level;
                const time = v.approvedAt ?? (v as any).transition_at ?? (v as any).capturedAt ?? (v as any).captured_at;
                return (
                  <div className="va-trace-row" key={v.version}>
                    <span className="va-grow va-truncate">
                      Version {v.version} — {name}
                    </span>
                    <AssuranceChip level={level} />
                    <When ms={time} />
                  </div>
                );
              })}
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
