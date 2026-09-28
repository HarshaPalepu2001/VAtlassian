import type { ReactNode } from 'react';
import Button from '@atlaskit/button';
import { Badge } from '../../ui/primitives';
import { AssuranceChip, MaterialityBadge } from '../../ui/feedback';
import { Icon, Seal } from '../../ui/brand';
import { daysBetween, formatTimestamp, plural, relativeTime } from '../../ui/format';
import { headline } from '../../review/DiffView';
import type { ReviewTab } from '../../review/openReview';
import type { DiffField } from '../../review/types';
import type { PanelEvidence, PanelSummary } from '../types';
import { changedFieldCount } from '../approvalModel';
import { recordHarnessEvent } from '../../lib/harness';

const ROWS_SHOWN = 4;

/**
 * THE BASELINE, AND WHAT HAS HAPPENED TO IT.
 *
 * Drift is not a separate section any more. It is a fact about the baseline,
 * so it is shown where the baseline is: the same card, turned amber, saying
 * how many changes, by whom and how recently, one line per change. The
 * decision on those changes sits at the bottom of the card, and everything a
 * reviewer reads at length — the full diff, the AI summary, the record —
 * opens in the review window rather than expanding here. The card is the same
 * size however much has changed.
 */
export default function BaselineSection({ summary, drift, evidence, evidenceReady, evidenceLoading, evidenceError, onRetryEvidence, onOpenReview, decision, restore, now = Date.now() }: {
  summary: PanelSummary;
  drift: PanelSummary['drift'];
  evidence: PanelEvidence | null;
  evidenceReady: boolean;
  evidenceLoading?: boolean;
  evidenceError?: string;
  onRetryEvidence?: () => void;
  onOpenReview: (tab: ReviewTab) => void;
  /** The drift decision (Approve changes / Reject and restore), when drift is open. */
  decision?: ReactNode;
  /** A finished restore's outcome: part of the baseline's record, so it is shown on its card. */
  restore?: ReactNode;
  now?: number;
}) {
  const baseline = summary.baseline;
  if (!baseline) {
    return (
      <div className="va-base va-base--empty">
        <p className="va-muted" style={{ margin: 0 }}>
          No baseline has been captured yet. One is recorded the first time this work item
          is approved through a controlled transition.
        </p>
      </div>
    );
  }

  const record = evidence?.record ?? null;
  const signedAt = baseline.transitionAt ?? baseline.capturedAt ?? null;
  const seal = record?.contentHash ?? baseline.treeHash ?? baseline.baselineId;
  const open = (tab: ReviewTab) => { recordHarnessEvent('DRIFT', `click:open:${tab}`, { issueKey: summary.issue?.key, driftCount: drift.count }); onOpenReview(tab); };

  const signature = (
    <div className="va-base__signature">
      <Seal hash={seal} size={32} tone={drift.count ? 'warning' : 'brand'} label={`Seal of baseline version ${baseline.version}`} />
      <div className="va-grow va-stack va-stack--tight">
        <span><strong>Version {baseline.version}</strong> · signed by {baseline.approvedName ?? 'an unrecorded reviewer'}</span>
        <span className="va-subtlest">
          <time title={formatTimestamp(signedAt) ?? undefined}>{formatTimestamp(signedAt) ?? 'Time not recorded'}</time>
          {' · '}{plural(record ? record.fieldCount : baseline.totalFieldCount, 'tracked field')}
          {baseline.nodeCount > 1 ? ` across ${plural(baseline.nodeCount, 'work item')}` : ''}
        </span>
      </div>
      <AssuranceChip level={baseline.assuranceLevel} />
      {baseline.fidelity && baseline.fidelity !== 'EXACT' && <Badge tone="warning">Partial capture</Badge>}
    </div>
  );

  const notes = <>
    {baseline.capturedBy && (
      <p className="va-secondary" style={{ margin: 0 }}>
        Baselined with {baseline.capturedBy.issueKey ?? 'its parent'} version {baseline.capturedBy.version}, signed by
        {' '}{baseline.approvedName ?? 'the parent\'s reviewer'}.
      </p>
    )}
    {baseline.policyIncomplete && (
      <p className="va-warning-text" style={{ margin: 0 }}>
        This baseline predates recorded role/method policy. An administrator has been notified;
        drift on it cannot be decided until the incident is resolved.
      </p>
    )}
    <TrackedLine record={record} loading={Boolean(evidenceLoading) && !record} error={evidenceError} onRetry={onRetryEvidence} />
    {restore}
  </>;

  const links = (
    <div className="va-base__links">
      <button type="button" className="va-link-button" onClick={() => open('record')}>View record</button>
      {!!record?.history?.length && <>
        <span aria-hidden className="va-subtlest">·</span>
        <button type="button" className="va-link-button" onClick={() => open('record')}>Version history ({record.history.length + 1})</button>
      </>}
    </div>
  );

  if (!evidenceReady) {
    return (
      <div className="va-base" aria-busy="true">
        <div className="va-base__status"><strong>Checking the current record…</strong>
          <span className="va-secondary">The approved baseline is being compared with the latest Jira content.</span></div>
        {signature}
        <TrackedLine record={record} loading={Boolean(evidenceLoading) && !record} error={evidenceError} onRetry={onRetryEvidence} />
        {restore}
      </div>
    );
  }

  if (!drift.count) {
    const steady = daysBetween(signedAt, now);
    return (
      <div className="va-base va-base--clean">
        <div className="va-base__status va-row">
          <Icon name="check" />
          <strong className="va-grow">Matches baseline version {baseline.version}</strong>
          {/* A small reward for a record nobody has had to touch. */}
          {steady != null && steady > 0 && <span className="va-steady" title="Days since this baseline was signed with nothing tracked changing">Steady for {plural(steady, 'day')}</span>}
          <span className="va-lozenge va-lozenge--success">In sync</span>
        </div>
        {signature}
        {notes}
        {links}
      </div>
    );
  }

  // ONE UNIT FOR BOTH NUMBERS. `drift.count` is field-level; `changedFields` is
  // node-level. The breakdown under a field-level headline counts fields too,
  // and the node categories beside it say so in their own labels.
  const fields: DiffField[] = evidence?.drift?.fields ?? [];
  const fieldCount = changedFieldCount(evidence?.drift);
  const addedCount = evidence?.drift?.addedNodes?.length ?? 0;
  const removedCount = evidence?.drift?.removedNodes?.length ?? 0;
  const movedCount = evidence?.drift?.movedNodes?.length ?? 0;
  const breakdown = [
    fieldCount ? plural(fieldCount, 'changed field') : '',
    addedCount ? plural(addedCount, 'added node') : '',
    removedCount ? plural(removedCount, 'removed node') : '',
    movedCount ? plural(movedCount, 'moved node') : ''
  ].filter(Boolean).join(', ');
  const needs = drift.materialCount === 0 ? 'all formatting only'
    : `${plural(drift.materialCount, 'change')} need${drift.materialCount === 1 ? 's' : ''} a decision`;
  const childrenChanged = (evidence?.drift?.groups ?? []).filter(g => g.kind === 'ISSUE' && !g.isRoot).length;
  const linkPendingFrom = [...new Set((summary.drift?.linkPending ?? []).map(p => p.decidedOnKey))];
  const latest = fields.map(f => ({ at: Number(f.lastChangedAt ?? f.attribution?.[f.attribution.length - 1]?.at ?? 0), by: f.lastChangedBy ?? f.attribution?.[f.attribution.length - 1]?.authorName }))
    .filter(x => x.at > 0).sort((a, b) => b.at - a.at)[0];
  const rank = (m?: string) => { const i = ['CRITICAL', 'MAJOR', 'MINOR', 'COSMETIC'].indexOf(m ?? 'COSMETIC'); return i < 0 ? 4 : i; };
  const shown = [...fields].sort((a, b) => rank(a.materiality) - rank(b.materiality)).slice(0, ROWS_SHOWN);

  return (
    <div className="va-base va-base--drifted">
      <div className="va-base__flag">
        <Icon name="warning" size={20} />
        <div className="va-grow va-stack va-stack--tight">
          <div className="va-row">
            <strong className="va-grow">{plural(drift.count, 'change')} since approval</strong>
            <span className="va-lozenge va-lozenge--moved">Drifted</span>
          </div>
          <span className="va-secondary">
            {[breakdown || needs, breakdown ? needs : '', latest ? `last change ${relativeTime(latest.at, now)}${latest.by ? ` by ${latest.by}` : ''}` : ''].filter(Boolean).join(' · ')}
          </span>
          {childrenChanged > 0 && (
            <span className="va-secondary">
              {childrenChanged === 1 ? '1 child work item has' : `${childrenChanged} child work items have`} changes.
              {' '}A decision here covers {childrenChanged === 1 ? 'it' : 'all of them'}; each can also be decided on its own.
            </span>
          )}
          {linkPendingFrom.length > 0 && (
            <span className="va-secondary">
              The link approved on {linkPendingFrom.join(', ')} is being recorded here; this updates on its own.
            </span>
          )}
        </div>
      </div>
      <div className="va-base__body">
        {signature}
        {shown.length > 0 && (
          <ul className="va-changes" aria-label="Changes since approval">
            {shown.map(field => {
              const last = field.attribution?.[field.attribution.length - 1];
              const at = field.lastChangedAt ?? last?.at ?? null;
              const by = field.lastChangedBy ?? last?.authorName ?? null;
              const edits = Math.max(field.occurrences ?? 0, field.attribution?.length ?? 0);
              return (
                <li key={`${field.issueKey ?? ''}:${field.fieldId}`} className="va-change-row">
                  <span className="va-change-row__name">{[field.issueKey, field.label ?? field.fieldName].filter(Boolean).join(' · ')}</span>
                  <span className="va-change-row__what va-truncate">{headline(field)}</span>
                  <span className="va-change-row__who" title={formatTimestamp(at) ?? undefined}>
                    {[by, relativeTime(at, now), edits > 1 ? `${edits} edits` : ''].filter(Boolean).join(' · ')}
                  </span>
                  <MaterialityBadge level={field.materiality} />
                </li>
              );
            })}
          </ul>
        )}
        {fields.length > ROWS_SHOWN && (
          <button type="button" className="va-link-button" onClick={() => open('changes')}>and {plural(fields.length - ROWS_SHOWN, 'more change')}</button>
        )}
        {notes}
        <div className="va-row va-base__actions">
          <button type="button" className="va-btn" onClick={() => open('changes')}><Icon name="compare" />See changes</button>
          <button type="button" className="va-btn va-btn--discovery" onClick={() => open('summary')}><Icon name="sparkle" />AI summary</button>
          <span className="va-spacer" />
          <button type="button" className="va-link-button" onClick={() => open('record')}>View record</button>
        </div>
        {decision}
      </div>
    </div>
  );
}

/**
 * What the baseline covers, in one line: "Tracks Summary, Priority and 40
 * more". It used to be a disclosure listing every field; a list of names is
 * one line, and the full record — values, digests, versions — opens in the
 * review window instead.
 */
function TrackedLine({ record, loading, error, onRetry }: { record: PanelEvidence['record'] | null; loading: boolean; error?: string; onRetry?: () => void }) {
  if (record) {
    const names = record.fields.map(f => f.fieldName);
    const listed = names.slice(0, 5);
    const rest = names.length - listed.length;
    const notRetained = record.fieldCount - record.retainedCount;
    return (
      <p className="va-subtlest" style={{ margin: 0 }}>
        Tracks {listed.join(', ')}{rest > 0 ? ` and ${rest} more` : ''}
        {notRetained > 0 && ` · values not kept for ${plural(notRetained, 'field')}`}
      </p>
    );
  }
  if (loading) return <p className="va-muted" style={{ margin: 0 }}>Loading tracked fields…</p>;
  if (error) {
    return (
      <p className="va-muted" style={{ margin: 0 }}>
        Tracked field detail could not be loaded. {error}
        {' '}<Button appearance="subtle" onClick={() => onRetry?.()}>Retry</Button>
      </p>
    );
  }
  return null;
}
