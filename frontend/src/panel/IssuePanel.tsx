import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { view } from '@forge/bridge';
import Button from '@atlaskit/button';
import { Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import useDecisionState from './useDecisionState';
import ApprovalControls, { restoredViaLine } from './sections/ApprovalControls';
import BaselineSection from './sections/BaselineSection';
import RestoreStatus, { restoreBelongsTo, restoreFinished } from './sections/RestoreStatus';
import { openReview } from '../review/openReview';
import DiagnosticsHud from './DiagnosticsHud';
import usePanelState from './usePanelState';
import { resolveSelectedAction, transitionDestination } from './approvalModel';



type Props = { issueKey?: string; onDone?: () => void };

class PanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <Notice danger>The panel could not be displayed. Use Refresh above to reload it.</Notice>
      : this.props.children;
  }
}

// The shell survives both failed requests and render errors in the body.
// My Approvals (QueueList.tsx) embeds this same component with an issueKey.
export default function IssuePanel(props: Props) {
  const [revision, setRevision] = useState(0);
  return <Page variant="panel">
    <div className="va-row va-panel-toolbar" role="toolbar" aria-label="VAtlassian controls">
      <span className="va-spacer" />
      <Button appearance="subtle" onClick={() => setRevision(value => value + 1)}>Refresh</Button>
    </div>
    <PanelBoundary key={`${props.issueKey ?? ''}:${revision}`}>
      <IssuePanelBody {...props} />
    </PanelBoundary>
  </Page>;
}

/** A labelled row standing in for a fact that has not resolved yet — never a
 *  bare/unlabelled spinner, and never an empty panel. */
function SkeletonRow({ label, failed }: { label: string; failed: boolean }) {
  return <div className="va-row"><span className="va-secondary">{label}</span><span className="va-muted">{failed ? 'Not available' : 'Loading…'}</span></div>;
}

/** A restore in any other state is still running (queued or mid-write). */
const RESTORE_ENDED = new Set(['COMPLETE', 'COMPLETE_WITH_REPLACEMENTS', 'PARTIAL', 'FAILED', 'QUEUING_FAILED', 'ERROR']);
const RESTORE_POLL_MS = 2500;
const RESTORE_POLL_LIMIT_MS = 120_000;
/** Matches the server's marker lifetime (db/linkPendingStore.js). */
const LINK_POLL_LIMIT_MS = 120_000;

function IssuePanelBody({ issueKey: issueKeyProp, onDone }: Props) {
  // The Forge issue-panel module renders <IssuePanel/> with no props. Read the
  // issue identity from the Forge context so the shell names the work item
  // before the summary lands; `panel:getSummary` resolves the same issue from
  // the request context server-side, so data fetching does not wait for this.
  const [contextIssue, setContextIssue] = useState<{ key?: string; id?: string } | null>(null);
  useEffect(() => {
    if (issueKeyProp) return;
    let active = true;
    view.getContext().then(ctx => { if (active) setContextIssue((ctx?.extension as { issue?: { key?: string; id?: string } })?.issue ?? null); }).catch(() => {});
    return () => { active = false; };
  }, [issueKeyProp]);

  const { state: summary, error, refresh, refreshing } = usePanelState(issueKeyProp);
  const issueKey = issueKeyProp ?? summary?.issue?.key ?? contextIssue?.key;

  // A REJECTION FINISHES AFTER ITS SUBMIT DOES. The restore runs as a queued
  // job (jobs/restoreWorker.js) that writes the fields a few seconds after
  // signature:submit returns, so the redraw ApprovalControls asks for on
  // submit lands before anything has changed — Jira kept showing the drifted
  // values until someone reloaded. While a restore is running, this quietly
  // re-reads the summary; when one ends, Jira is asked once to redraw, now
  // that its fields really are different. A restore already finished when the
  // panel opened is history and redraws nothing.
  //
  // Not an interval — this app keeps no standing poll (see the guard test in
  // test/panel.test.mjs). One timeout is armed per summary read while the
  // restore is running, so it ends the moment a read shows the restore ended,
  // and gives up after RESTORE_POLL_LIMIT_MS whatever happens.
  const restoreState = summary?.restore?.state;
  const restoreRunning = Boolean(restoreState) && !RESTORE_ENDED.has(restoreState!);
  const watchStarted = useRef<number | null>(null);
  useEffect(() => {
    if (!restoreRunning) { watchStarted.current = null; return; }
    watchStarted.current ??= Date.now();
    if (Date.now() - watchStarted.current > RESTORE_POLL_LIMIT_MS) return;
    const timer = setTimeout(() => {
      if (document.visibilityState !== 'hidden') void refresh({ background: true });
    }, RESTORE_POLL_MS);
    return () => clearTimeout(timer);
  }, [restoreRunning, summary, refresh]);
  // A LINK APPROVED ON THE OTHER ISSUE is recorded here by a queued job
  // (jobs/linkWorker.js) a few seconds after that approval, and nothing in
  // Jira changes when it lands, so no Jira event would redraw this panel. While
  // the summary says one is on its way, re-read quietly, the same bounded way
  // as a running restore above; it stops the moment a read shows it recorded.
  const linkPendingKey = (summary?.drift?.linkPending ?? []).map(p => `${p.decidedOnKey}:${p.queuedAt}`).join(',');
  const linkWatchStarted = useRef<number | null>(null);
  useEffect(() => {
    if (!linkPendingKey) { linkWatchStarted.current = null; return; }
    linkWatchStarted.current ??= Date.now();
    if (Date.now() - linkWatchStarted.current > LINK_POLL_LIMIT_MS) return;
    const timer = setTimeout(() => {
      if (document.visibilityState !== 'hidden') void refresh({ background: true });
    }, RESTORE_POLL_MS);
    return () => clearTimeout(timer);
  }, [linkPendingKey, summary, refresh]);
  const redrawnFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!summary) return;
    const ended = summary.restore && RESTORE_ENDED.has(summary.restore.state) ? summary.restore.restoreId : null;
    if (redrawnFor.current === undefined) { redrawnFor.current = ended; return; }
    if (ended && ended !== redrawnFor.current) {
      redrawnFor.current = ended;
      view.refresh().catch(() => {});
    }
  }, [summary]);

  // The selected action belongs to the controls. Evidence is keyed to the
  // current baseline, because it is shared by every action surface.
  const [selectedTransitionId, setSelectedTransitionId] = useState('');
  const { evidence, heldEvidence, evidenceLoading, evidenceError, retryEvidence, hasAuthoritativeEvidence,
    shownEvidence, evidenceReady, authoritativeSummary, shownDrift } = useDecisionState(summary, issueKey, refresh);

  // Drift is decided on the Baseline card; a clean record is decided in
  // Approvals. One set of controls either way, so one signing session.
  const reviewingDrift = resolveSelectedAction(authoritativeSummary, selectedTransitionId).reviewingDrift;
  // HELD IS THE VALIDATOR'S VERDICT, not the review's. The review counts every
  // change its decision would cover, children included, but drift is held only
  // downward (lib/ancestorHold.js): this item is held by its OWN change (the
  // server's live count, the same one the validator holds on) or by one above
  // it. A change below only asks this item for a decision.
  const heldHere = (summary?.drift?.count ?? 0) > 0 || Boolean(summary?.drift?.heldBy);
  const heldMove = (summary?.transitions ?? []).find(t => t.canApprove) ?? summary?.transitions?.[0];
  const heldNote = !heldHere
    ? 'Only the changes below this work item are waiting; it is not held itself.'
    : heldMove ? `Moving to ${transitionDestination(heldMove)} is held until these changes are decided.` : 'Controlled moves are held until these changes are decided.';
  const review = (tab: 'changes' | 'summary' | 'record') => {
    void openReview({ issueKey, tab, onClose: () => { void refresh(); onDone?.(); } }).catch(() => {});
  };
  const controls = summary && (
    <ApprovalControls
      summary={authoritativeSummary!}
      issueKey={issueKey}
      onDone={async () => { await refresh(); onDone?.(); }}
      disabled={!!error || !hasAuthoritativeEvidence}
      evidence={evidence}
      evidenceLoading={evidenceLoading}
      evidenceError={evidenceError}
      evidenceHeld={Boolean(heldEvidence)}
      selectedTransitionId={selectedTransitionId}
      onSelectTransition={setSelectedTransitionId}
      lead={<Button onClick={() => review('changes')}>Review changes</Button>}
    />
  );
  // Running, it is a card of its own; finished, one line of the baseline's record.
  const restoreStatus = summary && <RestoreStatus issueKey={issueKey} restore={summary.restore} onDone={refresh} />;

  return (
    <div className="va-stack">
      {error && (
        <Notice danger>
          {error} Refresh before making an approval decision.
          {' '}<Button appearance="subtle" isDisabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Try again'}</Button>
        </Notice>
      )}

      {/* A meaningful shell before the first response, and kept in place if
          that response fails — never an empty panel or a bare spinner. */}
      {!summary && (
        <div className="va-stack" aria-busy={!error} aria-label="Approval summary">
          {(issueKeyProp ?? contextIssue?.key) && <p className="va-secondary">{issueKeyProp ?? contextIssue?.key}</p>}
          <SkeletonRow label="Baseline" failed={!!error} />
        </div>
      )}

      {summary && (
        <>
          {/* Admin-only fact. Ordinary users never receive adminIncidentCount
              at all, so this never renders as an operational task for them. */}
          {summary.adminIncidentCount != null && summary.adminIncidentCount > 0 && (
            <Notice>
              {summary.adminIncidentCount} workflow control {summary.adminIncidentCount === 1 ? 'incident has' : 'incidents have'} been recorded
              for this configuration. Review them in the admin console.
            </Notice>
          )}
          {summary.adminIncidentUnavailable && (
            <Notice danger>Workflow control status is temporarily unavailable. No incident count is being shown; reload before relying on this control state.</Notice>
          )}

          {!evidence && evidenceError && (
            <Notice>
              Change details could not be loaded. {evidenceError}
              {' '}<Button appearance="subtle" onClick={retryEvidence}>Reload evidence</Button>
            </Notice>
          )}

          {/* ONE CARD. The baseline's state in a line, the changes when there
              are any, and the decision on them. With nothing waiting on the
              baseline, the next controlled move sits under it. */}
          <BaselineSection
            summary={summary}
            drift={shownDrift!}
            evidence={shownEvidence}
            evidenceReady={evidenceReady}
            evidenceLoading={evidenceLoading}
            evidenceError={evidenceError}
            onRetryEvidence={retryEvidence}
            onOpenReview={review}
            decision={reviewingDrift ? controls : null}
            heldNote={reviewingDrift ? heldNote : undefined}
            restore={<>
              {restoredViaLine(summary) && <p className="va-subtlest">{restoredViaLine(summary)}</p>}
              {restoreFinished(summary.restore?.state) && restoreBelongsTo(summary.restore, summary.baseline) ? restoreStatus : null}
            </>}
          />
          {!restoreFinished(summary.restore?.state) && restoreStatus}
          {!reviewingDrift && (summary.transitions?.length ?? 0) > 0 && <div className="va-next">{controls}</div>}
        </>
      )}

      {/* Diagnostics are for administrators, and folded away until asked for. */}
      {summary?.adminIncidentCount != null &&       <DiagnosticsHud summary={authoritativeSummary} evidence={evidence} />}
    </div>
  );
}
