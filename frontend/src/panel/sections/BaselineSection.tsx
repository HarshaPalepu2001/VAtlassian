import type { ReactNode } from 'react';
import Button from '@atlaskit/button';
import { formatDate, formatTimestamp, plural, relativeTime } from '../../ui/format';
import { headline } from '../../review/DiffView';
import type { ReviewTab } from '../../review/openReview';
import type { DiffField } from '../../review/types';
import type { PanelEvidence, PanelSummary } from '../types';
import { recordHarnessEvent } from '../../lib/harness';

const ROWS_SHOWN = 4;

/**
 * Show whether this work item matches its signed baseline. If it matches,
 * show the status and history link. Otherwise list the main changes and offer
 * Review changes, Reject and restore, and Approve changes.
 * Open detailed content in the review window to keep the card compact.
 */
export default function BaselineSection({ summary, drift, evidence, evidenceReady, evidenceLoading, evidenceError, onRetryEvidence, onOpenReview, decision, heldNote, restore, now = Date.now() }: {
  summary: PanelSummary;
  drift: PanelSummary['drift'];
  evidence: PanelEvidence | null;
  evidenceReady: boolean;
  evidenceLoading?: boolean;
  evidenceError?: string;
  onRetryEvidence?: () => void;
  onOpenReview: (tab: ReviewTab) => void;
  /** The drift decision (Review changes, Reject and restore, Approve changes), when drift is open. */
  decision?: ReactNode;
  /** What the open drift is holding, e.g. the next controlled transition. */
  heldNote?: string;
  /** A finished restore's outcome: part of the baseline's record, so it is shown on its card. */
  restore?: ReactNode;
  now?: number;
}) {
  const baseline = summary.baseline;
  if (!baseline) {
    return (
      <div className="va-base va-base--empty">
        <p className="va-secondary">No baseline yet. One is recorded the first time this work item is approved.</p>
        {restore}
      </div>
    );
  }

  const record = evidence?.record ?? null;
  const signedAt = baseline.transitionAt ?? baseline.capturedAt ?? null;
  const open = (tab: ReviewTab) => { recordHarnessEvent('DRIFT', `click:open:${tab}`, { issueKey: summary.issue?.key, driftCount: drift.count }); onOpenReview(tab); };
  const signedLine = `Signed by ${baseline.approvedName ?? 'an unrecorded reviewer'}${signedAt ? ` on ${formatDate(signedAt)}` : ''}`;
  const history = <button type="button" className="va-link-button" onClick={() => open('record')}>History</button>;

  const notes = <>
    {baseline.capturedBy && (
      <p className="va-subtlest">Baselined with {baseline.capturedBy.issueKey ?? 'its parent'} version {baseline.capturedBy.version}.</p>
    )}
    {baseline.fidelity && baseline.fidelity !== 'EXACT' && <p className="va-subtlest">Some content could not be captured in this baseline.</p>}
    {baseline.policyIncomplete && (
      <p className="va-warning-text">
        This baseline predates recorded role and method policy, so its changes can't be decided until an administrator resolves the incident.
      </p>
    )}
    {evidenceError && !record && (
      <p className="va-subtlest">Change detail could not be loaded. <button type="button" className="va-link-button" onClick={() => onRetryEvidence?.()}>Retry</button></p>
    )}
    {restore}
  </>;

  const head = (lozenge: ReactNode) => (
    <div className="va-base__head">
      <span className="va-base__title">Baseline version {baseline.version}</span>
      <span className="va-spacer" />
      {lozenge}
    </div>
  );

  if (!evidenceReady) {
    return (
      <div className="va-base" aria-busy="true">
        {head(null)}
        <p className="va-secondary">{evidenceLoading ? 'Checking for changes since it was signed…' : signedLine}</p>
        {notes}
      </div>
    );
  }

  if (!drift.count) {
    return (
      <div className="va-base va-base--clean">
        {head(<span className="va-lozenge va-lozenge--success">Matches</span>)}
        <p className="va-secondary">{signedLine} · {history}</p>
        {notes}
      </div>
    );
  }

  const fields: DiffField[] = evidence?.drift?.fields ?? [];
  const childrenChanged = (evidence?.drift?.groups ?? []).filter(g => g.kind === 'ISSUE' && !g.isRoot).length;
  const linkPendingFrom = [...new Set((summary.drift?.linkPending ?? []).map(p => p.decidedOnKey))];
  const rank = (m?: string) => { const i = ['CRITICAL', 'MAJOR', 'MINOR', 'COSMETIC'].indexOf(m ?? 'COSMETIC'); return i < 0 ? 4 : i; };
  const shown = [...fields].sort((a, b) => rank(a.materiality) - rank(b.materiality)).slice(0, ROWS_SHOWN);
  const reviewButton = <Button onClick={() => open('changes')}>Review changes</Button>;

  return (
    <div className="va-base va-base--drifted">
      {head(<span className="va-lozenge va-lozenge--moved">Changed</span>)}
      <p className="va-secondary">
        {plural(drift.count, 'change')} since {baseline.approvedName ?? 'it was'} signed{signedAt ? ` on ${formatDate(signedAt)}` : ''}
        {childrenChanged > 0 ? `, including ${childrenChanged === 1 ? '1 child work item' : `${childrenChanged} child work items`}` : ''}
      </p>
      {shown.length > 0 && (
        <table className="va-changes" aria-label="Changes since approval">
          <tbody>
            {shown.map(field => {
              const last = field.attribution?.[field.attribution.length - 1];
              const at = field.lastChangedAt ?? last?.at ?? null;
              const by = field.lastChangedBy ?? last?.authorName ?? null;
              return (
                <tr key={`${field.issueKey ?? ''}:${field.fieldId}`} className="va-change-row">
                  <td className="va-change-row__name">
                    <span className={`va-sev va-sev--${field.materiality ?? 'COSMETIC'}`} aria-hidden />
                    {field.label ?? field.fieldName}
                    {field.issueKey && field.issueKey !== summary.issue?.key && <span className="va-subtlest"> {field.issueKey}</span>}
                  </td>
                  <td className="va-change-row__what va-truncate">{headline(field)}</td>
                  <td className="va-change-row__who" title={formatTimestamp(at) ?? undefined}>{[by, relativeTime(at, now)].filter(Boolean).join(' · ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {fields.length > ROWS_SHOWN && (
        <button type="button" className="va-link-button" onClick={() => open('changes')}>and {plural(fields.length - ROWS_SHOWN, 'more change')}</button>
      )}
      {linkPendingFrom.length > 0 && (
        <p className="va-subtlest">The link approved on {linkPendingFrom.join(', ')} is being recorded here; this updates on its own.</p>
      )}
      {notes}
      {decision ?? <div className="va-row va-decision-row">{reviewButton}</div>}
      {heldNote && <p className="va-subtlest">{heldNote}</p>}
    </div>
  );
}
