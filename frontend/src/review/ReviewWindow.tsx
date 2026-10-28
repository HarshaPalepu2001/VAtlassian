import { useEffect, useRef, useState } from 'react';
import { view } from '@forge/bridge';
import { invoke } from '../lib/bridge';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
import { Loading } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { Icon } from '../ui/brand';
import { formatDate, plural } from '../ui/format';
import usePanelState from '../panel/usePanelState';
import useDecisionState from '../panel/useDecisionState';
import ApprovalControls from '../panel/sections/ApprovalControls';
import type { MixedRequest } from '../panel/sections/ApprovalControls';
import { payload as decisionPayload } from './fieldDecisions';
import { canSave, summary as decisionSummary } from './fieldDecisions';
import type { Decisions } from './fieldDecisions';
import { clearDecisionDraft, loadDecisionDraft, saveDecisionDraft } from './decisionDrafts';
import BaselineRecord from '../panel/sections/BaselineRecord';
import DiffView from './DiffView';
import type { ReviewTab } from './openReview';
import type { DiffField, ReportMeta, ReviewReport } from './types';
import type { RestoreRow } from '../panel/sections/RestoreStatus';
import { recordHarnessEvent } from '../lib/harness';

type ReportEnvelope = ReportMeta & { body?: ReviewReport };
const TABS: { id: 'changes' | 'record'; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'record', label: 'History' }
];

/**
 * THE REVIEW WINDOW.
 *
 * One Jira modal with two tabs — the changes and the signed history — and the
 * decision in its footer. A short written summary of the changes sits above
 * them when one has been generated; it is a reading aid, never a tab of its
 * own, and never stands in for reading the changes.
 *
 * It reads the summary and evidence through the same hooks as the panel, so
 * the counts and the permissions it shows are the panel's, exactly. When a
 * decision is recorded here the window ends on the signed receipt, and closes
 * with `{ decided: true }` so whatever opened it re-reads.
 */
export default function ReviewWindow({ issueKey, tab: requestedTab = 'changes', now = Date.now() }: { issueKey?: string; tab?: ReviewTab; now?: number }) {
  // Older callers still ask for the summary tab; the summary now heads Changes.
  const initialTab = requestedTab === 'record' ? 'record' : 'changes';
  const { state: summary, error, refresh } = usePanelState(issueKey);
  const key = issueKey ?? summary?.issue?.key;
  const { evidence, heldEvidence, evidenceLoading, evidenceError, retryEvidence, hasAuthoritativeEvidence, shownEvidence, authoritativeSummary } =
    useDecisionState(summary, key, refresh);
  const [tab, setTab] = useState<'changes' | 'record'>(initialTab);
  const [selectedTransitionId, setSelectedTransitionId] = useState('');
  const decided = useRef(false);
  // FIELD-BY-FIELD CHOICES, kept here rather than in the diff so they survive
  // switching tabs and cancelling the signing sheet. They belong to ONE reading
  // of the record: a choice made against evidence that has since changed was
  // never made about what is now there, so a new evidence hash starts clean.
  const [choices, setChoices] = useState<{ hash: string | null; state: Decisions }>({ hash: null, state: {} });
  const [mixedRequest, setMixedRequest] = useState<MixedRequest | null>(null);

  const [report, setReport] = useState<ReportEnvelope | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState('');
  const reportRequested = useRef(false);
  const draftIdentity = useRef<{ issueKey: string; evidenceHash: string } | null>(null);
  useEffect(() => {
    // The cached summary is read once there are changes to read about, never
    // generated unasked: generating costs the customer, reading does not.
    if (tab !== 'changes' || reportRequested.current || !key || !(summary?.drift?.count)) return;
    reportRequested.current = true;
    invoke<Result & { report: ReportEnvelope | null }>('report:get', { issueKey: key })
      .then(r => { assertResult(r); setReport(r.report); })
      .catch(() => { /* The deterministic diff remains available without AI or its cache. */ });
  }, [tab, key, summary?.drift?.count]);
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
  const driftCount = authoritativeSummary?.drift.count ?? 0;
  const evidenceHash = shownEvidence?.evidenceHash ?? null;
  useEffect(() => {
    if (!key || !evidenceHash) return;
    const previous = draftIdentity.current;
    if (previous && (previous.issueKey !== key || previous.evidenceHash !== evidenceHash)) {
      clearDecisionDraft(previous.issueKey, previous.evidenceHash);
    }
    draftIdentity.current = { issueKey: key, evidenceHash };
    const restored = loadDecisionDraft(key, evidenceHash);
    if (restored) setChoices({ hash: evidenceHash, state: restored });
    else if (choices.hash === null) setChoices({ hash: evidenceHash, state: {} });
  }, [key, evidenceHash]);
  const decisionState: Decisions = choices.hash === evidenceHash ? choices.state : {};
  const choicesCleared = choices.hash !== evidenceHash && Object.keys(choices.state).length > 0;
  const history = shownEvidence?.drift as { historyTruncated?: boolean; historyUnavailable?: boolean } | undefined;
  const workItems = new Set(fields.map(f => f.issueKey ?? key)).size;

  // FIELD BY FIELD, when the server will take it: the footer then counts the
  // choices and signs them all at once. Otherwise the footer keeps the
  // whole-set decision and the merge view is read-only.
  const mixed = shownEvidence?.drift?.mixed ?? null;
  const fieldByField = Boolean(authoritativeSummary && driftCount > 0 && mixed?.eligible && authoritativeSummary.drift.canApprove === true);
  const gate = canSave({ fields, state: decisionState, mixed, loading: evidenceLoading, error: evidenceError ?? '',
    held: Boolean(heldEvidence) || !hasAuthoritativeEvidence, eligible: authoritativeSummary?.drift.canApprove === true });
  const tally = decisionSummary(fields, decisionState);
  const fieldDecisions = fieldByField ? {
    text: `${tally.approve} approved · ${tally.reject} rejected · ${tally.undecided ? `${tally.undecided} still to decide` : 'all decided'}`,
    enabled: gate.enabled,
    reason: gate.enabled ? '' : gate.reason,
    // Signing only asks the server to check the map and open the signing
    // sheet; nothing is recorded until the reviewer signs.
    onSave: () => setMixedRequest(previous => ({ token: (previous?.token ?? 0) + 1,
      decisions: decisionPayload(fields, decisionState), fields }))
  } : undefined;
  // A summary written without AI (AI off, or the model unavailable) is still
  // shown, labelled, so the reviewer is never offered a button that can only
  // produce another hidden summary.
  const reportText = report?.body ? report.body.headline || report.body.narrative : '';

  return (
    <div className="va-window">
      <header className="va-window__head">
        <div className="va-row">
          <span className="va-secondary va-truncate">{[key, summary?.issue?.summary].filter(Boolean).join(' · ')}</span>
          <span className="va-spacer" />
          <button type="button" className="va-icon-button" aria-label="Close" onClick={close}><Icon name="close" /></button>
        </div>
        <h2 className="va-window__title">
          {!baseline ? 'Approval record' : driftCount ? `Review changes to baseline version ${baseline.version}` : `Baseline version ${baseline.version}`}
        </h2>
        {baseline && (
          <p className="va-window__meta">
            Signed by {baseline.approvedName ?? 'an unrecorded reviewer'}{signedAt ? ` on ${formatDate(signedAt)}` : ''}
            {fields.length > 0 ? ` · ${plural(fields.length, 'change')}${workItems > 1 ? ` across ${plural(workItems, 'work item')}` : ''}` : ''}
          </p>
        )}
        <div role="tablist" aria-label="Review" className="va-tabs">
          {TABS.map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="va-tab" onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === 'changes' && fields.length > 0 && <span className="va-tab__count">{fields.length}</span>}
            </button>
          ))}
        </div>
      </header>

      <main className="va-window__body">
        {error && <Notice danger>{error}</Notice>}
        {!summary && !error && <Loading label="Opening the review…" />}
        {summary && tab === 'changes' && (
          <div className="va-stack">
            {!shownEvidence && evidenceLoading && <Loading label="Comparing approved and current values…" />}
            {!shownEvidence && evidenceError && <Notice>Change details could not be loaded. {evidenceError} <button type="button" className="va-link-button" onClick={retryEvidence}>Reload evidence</button></Notice>}
            {(history?.historyTruncated || history?.historyUnavailable) && (
              <Notice>Some change history could not be loaded. The value comparison is current; the list of who changed it and when may be incomplete.</Notice>
            )}
            {choicesCleared && <Notice>The record changed while you were deciding, so your choices were cleared. Review the current changes and decide again.</Notice>}
            {shownEvidence && fields.length > 0 && (reportText ? (
              <div className="va-brief" aria-label="Summary of the changes">
                <p>{reportText}</p>
                <span className="va-subtlest" title={report?.degraded ? report.degradedReason ?? '' : report?.model}>
                  {report?.degraded ? 'Written without AI from the changes below.' : 'Written from the changes below.'} Check each one before deciding.
                </span>
              </div>
            ) : (
              <div className="va-brief va-brief--empty">
                {reportError ? <span className="va-subtlest">A summary could not be written. {reportError}</span>
                  : <button type="button" className="va-link-button" disabled={reportBusy} onClick={() => void generate()}>{reportBusy ? 'Writing a summary…' : 'Summarise these changes'}</button>}
              </div>
            ))}
            {shownEvidence && (
              fields.length === 0 && !driftCount
                ? <p className="va-muted">Nothing tracked has changed since this baseline was signed.</p>
                : <DiffView fields={fields} groups={shownEvidence.drift?.groups} baselineAt={signedAt} now={now}
                    decisions={authoritativeSummary && driftCount > 0 ? {
                      state: decisionState,
                      onChange: next => {
                        setChoices({ hash: evidenceHash, state: next });
                        if (key && evidenceHash) saveDecisionDraft(key, evidenceHash, next);
                      },
                      mixed,
                      loading: evidenceLoading,
                      error: evidenceError ?? '',
                      // A previous read still on screen is not authority to decide on.
                      held: Boolean(heldEvidence) || !hasAuthoritativeEvidence,
                      eligible: authoritativeSummary.drift.canApprove === true
                    } : undefined} />
            )}
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
            onDone={async () => {
              decided.current = true;
              if (key && evidenceHash) clearDecisionDraft(key, evidenceHash);
              setChoices({ hash: null, state: {} });
              await refresh();
            }}
            onFinished={close}
            disabled={!!error || !hasAuthoritativeEvidence}
            evidence={evidence}
            evidenceLoading={evidenceLoading}
            evidenceError={evidenceError}
            evidenceHeld={Boolean(heldEvidence)}
            selectedTransitionId={selectedTransitionId}
            onSelectTransition={setSelectedTransitionId}
            mixedRequest={mixedRequest}
            fieldDecisions={fieldDecisions}
          />
        </footer>
      )}
    </div>
  );
}
