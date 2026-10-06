import { useEffect, useRef, useState } from 'react';
import { view } from '@forge/bridge';
import { invoke } from '../lib/bridge';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
import { Loading } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { Icon, Mark, Seal } from '../ui/brand';
import { daysBetween, formatTimestamp, plural } from '../ui/format';
import usePanelState from '../panel/usePanelState';
import useDecisionState from '../panel/useDecisionState';
import ApprovalControls from '../panel/sections/ApprovalControls';
import BaselineRecord from '../panel/sections/BaselineRecord';
import DiffView from './DiffView';
import ChangeTimeline from './ChangeTimeline';
import ReportView from './ReportView';
import type { ReviewTab } from './openReview';
import type { DiffField, ReportMeta, ReviewReport } from './types';
import type { RestoreRow } from '../panel/sections/RestoreStatus';
import { recordHarnessEvent } from '../lib/harness';

type ReportEnvelope = ReportMeta & { body?: ReviewReport };
const TABS: { id: ReviewTab; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'summary', label: 'AI summary' },
  { id: 'record', label: 'Baseline record' }
];

/**
 * THE REVIEW WINDOW.
 *
 * One Jira modal with three tabs — the changes, the AI summary, the signed
 * record — and the decision in its footer. The panel's buttons only choose
 * which tab it opens on. Being one window means a reviewer can read the
 * summary, jump to the change it cites, and approve, without ever closing
 * anything or losing their place.
 *
 * It reads the summary and evidence through the same hooks as the panel, so
 * the counts and the permissions it shows are the panel's, exactly. When a
 * decision is recorded here the window ends on the signed receipt, and closes
 * with `{ decided: true }` so whatever opened it re-reads.
 */
export default function ReviewWindow({ issueKey, tab: initialTab = 'changes', now = Date.now() }: { issueKey?: string; tab?: ReviewTab; now?: number }) {
  const { state: summary, error, refresh } = usePanelState(issueKey);
  const key = issueKey ?? summary?.issue?.key;
  const { evidence, heldEvidence, evidenceLoading, evidenceError, retryEvidence, hasAuthoritativeEvidence, shownEvidence, authoritativeSummary } =
    useDecisionState(summary, key, refresh);
  const [tab, setTab] = useState<ReviewTab>(initialTab);
  const [focus, setFocus] = useState<{ driftId?: string; fieldId?: string; n: number }>({ n: 0 });
  const [selectedTransitionId, setSelectedTransitionId] = useState('');
  const decided = useRef(false);

  const [report, setReport] = useState<ReportEnvelope | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState('');
  const reportRequested = useRef(false);
  useEffect(() => {
    // The cached summary is fetched the first time the tab is shown, never
    // generated unasked: generating costs the customer, reading does not.
    if (tab !== 'summary' || reportRequested.current || !key) return;
    reportRequested.current = true;
    invoke<Result & { report: ReportEnvelope | null }>('report:get', { issueKey: key })
      .then(r => { assertResult(r); setReport(r.report); })
      .catch(() => { /* The deterministic diff remains available without AI or its cache. */ });
  }, [tab, key]);
  // The restore log is read when the record is first shown, like the report.
  const [restores, setRestores] = useState<RestoreRow[] | null>(null);
  const restoresRequested = useRef(false);
  useEffect(() => {
    if (tab !== 'record' || restoresRequested.current || !key || !summary?.restore) return;
    restoresRequested.current = true;
    invoke<Result & { restores: RestoreRow[] }>('restore:getState', { issueKey: key })
      .then(r => setRestores(assertResult(r).restores ?? []))
      .catch(() => { /* The record stands without its restore log. */ });
  }, [tab, key, summary?.restore]);
  async function generate() {
    recordHarnessEvent('UI', 'click:generateReport', { issueKey: key });
    setReportBusy(true); setReportError('');
    try { const r = assertResult(await invoke<Result & { report: ReportEnvelope }>('report:generate', { issueKey: key })); setReport(r.report); }
    catch (e) { setReportError(errorMessage(e)); }
    finally { setReportBusy(false); }
  }

  const fields: DiffField[] = shownEvidence?.drift?.fields ?? [];
  const baseline = summary?.baseline ?? null;
  const signedAt = baseline?.transitionAt ?? baseline?.capturedAt ?? null;

  const close = () => { void view.close({ decided: decided.current }).catch(() => {}); };
  const edits = fields.reduce((n, f) => n + Math.max(f.occurrences ?? 0, f.attribution?.filter(a => !a.detected).length ?? 0), 0);
  const people = [...new Set(fields.flatMap(f => (f.attribution ?? []).filter(a => !a.detected).map(a => a.authorName).filter(Boolean)))] as string[];
  const driftCount = authoritativeSummary?.drift.count ?? 0;
  const history = shownEvidence?.drift as { historyTruncated?: boolean; historyUnavailable?: boolean } | undefined;
  const split = Boolean(summary && tab === 'changes' && shownEvidence && fields.length > 0);

  return (
    <div className="va-window">
      <header className="va-window__head">
        <div className="va-row">
          <Mark />
          {key && <strong>{key}</strong>}
          {summary?.issue?.summary && <span className="va-secondary va-truncate">{summary.issue.summary}</span>}
          <span className="va-spacer" />
          <button type="button" className="va-icon-button" aria-label="Close" onClick={close}><Icon name="close" /></button>
        </div>
        <h2 className="va-window__title">
          {!baseline ? 'Approval record' : driftCount ? `Review changes to baseline version ${baseline.version}` : `Baseline version ${baseline.version}`}
        </h2>
        <div role="tablist" aria-label="Review" className="va-tabs">
          {TABS.map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
              className={`va-tab${t.id === 'summary' ? ' va-tab--discovery' : ''}`} onClick={() => setTab(t.id)}>
              {t.id === 'summary' && <Icon name="sparkle" size={14} />}
              {t.label}
              {t.id === 'changes' && fields.length > 0 && <span className="va-tab__count">{fields.length}</span>}
            </button>
          ))}
        </div>
      </header>

      {baseline && (
        <div className="va-window__compare">
          <Seal hash={shownEvidence?.record?.contentHash ?? baseline.treeHash ?? baseline.baselineId} size={22} tone={driftCount ? 'warning' : 'brand'} />
          <span className="va-grow">
            {tab === 'record' ? <>Current signed baseline <strong>version {baseline.version}</strong></> : <>Compared with <strong>version {baseline.version}</strong></>}, signed by <strong>{baseline.approvedName ?? 'an unrecorded reviewer'}</strong>
            {signedAt ? <> on <time>{formatTimestamp(signedAt)}</time>{daysBetween(signedAt, now) ? ` — ${plural(daysBetween(signedAt, now)!, 'day')} ago` : ''}</> : null}
          </span>
          {tab !== 'record' && fields.length > 0 && (
            <span className="va-secondary">
              {plural(fields.length, 'change')}{edits ? ` · ${plural(edits, 'edit')}` : ''}{people.length ? ` · ${people.slice(0, 3).join(', ')}${people.length > 3 ? ` and ${people.length - 3} more` : ''}` : ''}
            </span>
          )}
        </div>
      )}

      {/* The changes are two panes that scroll on their own, so the list stays
          in view beside a long description diff; the body itself does not scroll. */}
      <main className={split ? 'va-window__body va-window__body--split' : 'va-window__body'}>
        {error && <Notice danger>{error}</Notice>}
        {!summary && !error && <Loading label="Opening the review…" />}
        {summary && tab === 'changes' && (
          <div className="va-stack va-changes">
            {!shownEvidence && evidenceLoading && <Loading label="Comparing approved and current values…" />}
            {!shownEvidence && evidenceError && <Notice>Change details could not be loaded. {evidenceError} <button type="button" className="va-link-button" onClick={retryEvidence}>Reload evidence</button></Notice>}
            {(history?.historyTruncated || history?.historyUnavailable) && (
              <Notice>Some change history could not be loaded. The value comparison is current; the list of who changed it and when may be incomplete.</Notice>
            )}
            {shownEvidence && fields.length > 0 && (
              <ChangeTimeline fields={fields} baselineAt={signedAt} now={now} onPick={fieldId => setFocus(f => ({ fieldId, n: f.n + 1 }))} />
            )}
            {shownEvidence && (
              fields.length === 0 && !driftCount
                ? <p className="va-muted">Nothing tracked has changed since this baseline was signed.</p>
                : <DiffView fields={fields} groups={shownEvidence.drift?.groups} baselineAt={signedAt} now={now}
                    focusDriftId={focus.driftId} focusFieldId={focus.fieldId} focusKey={focus.n} />
            )}
          </div>
        )}
        {summary && tab === 'summary' && (
          <div className="va-stack">
            {reportError && <Notice danger>{reportError}</Notice>}
            <ReportView
              report={report?.body}
              meta={report ?? undefined}
              fields={fields}
              viewer={{
                name: summary.actorName,
                signedIt: Boolean(summary.actorName && baseline?.approvedName && summary.actorName === baseline.approvedName),
                decides: summary.drift.eligible === true && driftCount > 0,
                role: summary.approval.requiredRole,
                version: baseline?.version ?? null
              }}
              onCite={id => { setTab('changes'); setFocus(f => ({ driftId: id, n: f.n + 1 })); }}
              onGenerate={driftCount > 0 ? () => void generate() : undefined}
              busy={reportBusy}
              fallback={driftCount > 0 ? undefined : 'Nothing has changed since this baseline was signed, so there is nothing to summarise.'}
            />
          </div>
        )}
        {summary && tab === 'record' && (
          <BaselineRecord
            issueKey={key}
            baseline={baseline}
            latestApproval={summary.latestApproval}
            record={shownEvidence?.record ?? null}
            restores={restores}
            evidenceLoading={evidenceLoading && !shownEvidence}
            evidenceError={evidenceError}
            onOpen={() => {}}
            onRetryEvidence={retryEvidence}
          />
        )}
      </main>

      {summary && (
        <footer className="va-window__foot">
          <ApprovalControls
            variant="window"
            summary={authoritativeSummary!}
            issueKey={key}
            onDone={async () => { decided.current = true; await refresh(); }}
            onFinished={close}
            disabled={!!error || !hasAuthoritativeEvidence}
            evidence={evidence}
            evidenceLoading={evidenceLoading}
            evidenceError={evidenceError}
            evidenceHeld={Boolean(heldEvidence)}
            selectedTransitionId={selectedTransitionId}
            onSelectTransition={setSelectedTransitionId}
          />
        </footer>
      )}
    </div>
  );
}
