import { Component, useEffect, useState, type ReactNode } from 'react';
import { view } from '@forge/bridge';
import Button from '@atlaskit/button';
import { Card, Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import usePanelState from './usePanelState';
import usePanelEvidence from './usePanelEvidence';
import DriftSection from './sections/DriftSection';
import ApprovalControls from './sections/ApprovalControls';
import BaselineRecord from './sections/BaselineRecord';
import RestoreStatus from './sections/RestoreStatus';

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

  // The selected action belongs to the controls. Evidence is keyed to the
  // current baseline, because it is shared by every action surface.
  const [selectedTransitionId, setSelectedTransitionId] = useState('');
  const [baselineDisclosureOpen, setBaselineDisclosureOpen] = useState(false);
  const { evidence, loading: evidenceLoading, error: evidenceError, retry: retryEvidence } = usePanelEvidence({
    issueKey,
    // Evidence is the one current-record read shared by the clean banner,
    // control facts, and review workspace. It must not be keyed to a summary
    // action whose drift count may change after this read arrives.
    actionId: 'current-record',
    baselineVersion: summary?.baseline?.version ?? null,
    baselineId: summary?.baseline?.baselineId ?? null,
    enabled: Boolean(summary?.baseline) || baselineDisclosureOpen,
    onStale: refresh
  });
  const evidenceReady = !summary?.baseline || Boolean(evidence);
  const evidenceFieldCount = evidence?.drift?.fields?.length ?? 0;
  const evidenceStructuralCount = (evidence?.drift?.changedFields?.length ?? 0)
    + (evidence?.drift?.addedNodes?.length ?? 0) + (evidence?.drift?.removedNodes?.length ?? 0)
    + (evidence?.drift?.movedNodes?.length ?? 0);
  const evidenceDriftCount = evidence
    ? Number(evidence.drift.count ?? (evidenceFieldCount || evidenceStructuralCount || summary?.drift.count || 0))
    : 0;
  const evidenceMaterialFields = evidence?.drift?.fields?.filter(field => field.semanticChange && field.materiality !== 'COSMETIC').length ?? 0;
  const evidenceMaterialCount = evidence
    ? Number(evidence.drift.materialCount ?? (evidenceMaterialFields || summary?.drift.materialCount || 0))
    : 0;
  const displaySummary = summary && evidence
    ? { ...summary, drift: { ...summary.drift, count: evidenceDriftCount, materialCount: evidenceMaterialCount,
      decidesDrift: evidenceDriftCount > 0 && summary.drift.canApprove } }
    : summary;
  const authoritativeSummary = displaySummary ?? summary;

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

          {summary.baseline && (
            <DriftSection drift={authoritativeSummary!.drift} evidence={evidence} evidenceReady={evidenceReady} issueKey={issueKey} />
          )}

          {!evidenceReady && evidenceError && (
            <Notice>
              Change details could not be loaded. {evidenceError}
              {' '}<Button appearance="subtle" onClick={retryEvidence}>Reload evidence</Button>
            </Notice>
          )}

          <ApprovalControls
            summary={authoritativeSummary!}
            issueKey={issueKey}
            onDone={async () => { await refresh(); onDone?.(); }}
            disabled={!!error || !evidenceReady}
            evidence={evidence}
            evidenceLoading={evidenceLoading}
            evidenceError={evidenceError}
            selectedTransitionId={selectedTransitionId}
            onSelectTransition={setSelectedTransitionId}
          />

          <BaselineRecord
            baseline={summary.baseline}
            latestApproval={summary.latestApproval}
            record={evidence?.record ?? null}
            evidenceLoading={evidenceLoading}
            evidenceError={evidenceError}
            onOpen={() => setBaselineDisclosureOpen(true)}
            onRetryEvidence={retryEvidence}
          />

          <RestoreStatus issueKey={issueKey} restore={summary.restore} onDone={refresh} />
        </>
      )}
    </div>
  );
}
