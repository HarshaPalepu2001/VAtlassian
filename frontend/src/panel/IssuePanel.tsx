import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { view } from '@forge/bridge';
import Button from '@atlaskit/button';
import { Card, Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import usePanelEvidence from './usePanelEvidence';
import DriftSection from './sections/DriftSection';
import ApprovalControls from './sections/ApprovalControls';
import BaselineRecord from './sections/BaselineRecord';
import RestoreStatus from './sections/RestoreStatus';
import DiagnosticsHud from './DiagnosticsHud';
import usePanelState from './usePanelState';
import { changedFieldCount } from './approvalModel';
import type { PanelEvidence, PanelSummary } from './types';



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
    <div className="va-row" role="toolbar" aria-label="Approval and baseline controls">
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

/** Drift totals as one evidence read states them, falling back to the summary. */
function evidenceCounts(evidence: PanelEvidence | null, summary: PanelSummary | null) {
  if (!evidence) return { driftCount: 0, materialCount: 0 };
  const fieldCount = evidence.drift?.fields?.length ?? 0;
  // changedFieldCount(), not changedFields.length: the list is node-level and
  // this total is compared against, and falls back to, field-level counts.
  const structuralCount = changedFieldCount(evidence.drift)
    + (evidence.drift?.addedNodes?.length ?? 0) + (evidence.drift?.removedNodes?.length ?? 0)
    + (evidence.drift?.movedNodes?.length ?? 0);
  const materialFields = evidence.drift?.fields?.filter(field => field.semanticChange && field.materiality !== 'COSMETIC').length ?? 0;
  return {
    driftCount: Number(evidence.drift.count ?? (fieldCount || structuralCount || summary?.drift.count || 0)),
    materialCount: Number(evidence.drift.materialCount ?? (materialFields || summary?.drift.materialCount || 0))
  };
}

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
  const [baselineDisclosureOpen, setBaselineDisclosureOpen] = useState(false);
  const { evidence, heldEvidence, loading: evidenceLoading, error: evidenceError, retry: retryEvidence } = usePanelEvidence({
    issueKey,
    // Evidence is the one current-record read shared by the clean banner,
    // control facts, and review workspace. It must not be keyed to a summary
    // action whose drift count may change after this read arrives.
    actionId: 'current-record',
    baselineVersion: summary?.baseline?.version ?? null,
    baselineId: summary?.baseline?.baselineId ?? null,
    evidenceVersion: summary?.evidenceVersion ?? null,
    contentHash: summary?.contentHash ?? null,
    enabled: Boolean(summary?.baseline) || baselineDisclosureOpen,
    onStale: refresh
  });
  const hasAuthoritativeEvidence = !summary?.baseline || Boolean(evidence);
  // What the informational sections show: the authoritative read, or — while
  // its replacement for the same baseline loads — the previous one, so a
  // background refresh updates in place instead of flashing "Checking…".
  const shownEvidence = evidence ?? heldEvidence;
  const evidenceReady = hasAuthoritativeEvidence || Boolean(evidenceError) || Boolean(heldEvidence);
  const { driftCount: evidenceDriftCount, materialCount: evidenceMaterialCount } = evidenceCounts(evidence, summary);
  // PERMISSION TRAVELS WITH THE COUNT IT BELONGS TO.
  //
  // Substituting the live re-diff's count for display while leaving
  // canApprove/canReject as the server computed them from the STORED counter is
  // what produced VJIRA-17: the panel entered drift-review mode on one number
  // (1 change) and refused on a verdict about another (0 recorded), then
  // explained the refusal by naming a role that had never been checked.
  //
  // `drift.eligible` is the viewer's own standing on this baseline, answered
  // independently of any count (panelSummary.js), so it is the right thing to
  // pair with whichever count is actually on screen.
  const canDecideShownDrift = evidenceDriftCount > 0 && summary?.drift.eligible === true;
  const displaySummary = summary && evidence
    ? { ...summary, drift: { ...summary.drift, count: evidenceDriftCount, materialCount: evidenceMaterialCount,
      canApprove: canDecideShownDrift, canReject: canDecideShownDrift,
      decidesDrift: canDecideShownDrift } }
    : summary;
  const authoritativeSummary = displaySummary ?? summary;
  // Counts that agree with the list DriftSection is drawing. Display only:
  // ApprovalControls keeps `authoritativeSummary`, whose permissions are
  // paired with the authoritative read and nothing else.
  const shownCounts = evidenceCounts(shownEvidence, summary);
  const shownDrift = summary && shownEvidence && !evidence
    ? { ...summary.drift, count: shownCounts.driftCount, materialCount: shownCounts.materialCount }
    : authoritativeSummary?.drift;

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
          <Card title="Approval"><SkeletonRow label="Control state" failed={!!error} /><SkeletonRow label="Available actions" failed={!!error} /></Card>
          <Card title="Baseline record"><SkeletonRow label="Latest baseline" failed={!!error} /><SkeletonRow label="Latest approval" failed={!!error} /></Card>
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

          {summary.baseline && (
            <DriftSection drift={shownDrift!} evidence={shownEvidence} evidenceReady={evidenceReady} issueKey={issueKey} />
          )}

          {!evidence && evidenceError && (
            <Notice>
              Change details could not be loaded. {evidenceError}
              {' '}<Button appearance="subtle" onClick={retryEvidence}>Reload evidence</Button>
            </Notice>
          )}

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
          />

          <BaselineRecord
            baseline={summary.baseline}
            latestApproval={summary.latestApproval}
            record={shownEvidence?.record ?? null}
            evidenceLoading={evidenceLoading && !shownEvidence}
            evidenceError={evidenceError}
            onOpen={() => setBaselineDisclosureOpen(true)}
            onRetryEvidence={retryEvidence}
          />

          <RestoreStatus issueKey={issueKey} restore={summary.restore} onDone={refresh} />
        </>
      )}

      <DiagnosticsHud summary={authoritativeSummary} evidence={evidence} />
    </div>
  );
}

