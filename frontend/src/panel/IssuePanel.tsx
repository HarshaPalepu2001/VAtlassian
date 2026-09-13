import { Component, useState, type ReactNode } from 'react';
import Button from '@atlaskit/button';
import { Card, Loading, Page } from '../ui/primitives';
import { Notice, When } from '../ui/feedback';
import usePanelState from './usePanelState';
import DriftSection from './sections/DriftSection';
import ApprovalControls from './sections/ApprovalControls';
import BaselineRecord from './sections/BaselineRecord';
import RestoreStatus from './sections/RestoreStatus';

type Props = { issueKey?: string; onDone?: () => void };

class PanelBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <Notice danger>The panel could not be displayed. Use Refresh above to reload it.</Notice>
      : this.props.children;
  }
}

// The shell survives both failed requests and render errors in the body.
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

function IssuePanelBody({ issueKey, onDone }: Props) {
  const { state, error, refresh, refreshing } = usePanelState(issueKey);

  if (!state && !error) return <Loading label="Loading approval and baseline…" />;

  return (
    <div className="va-stack">
        {error && <Notice danger>{error} Refresh before making an approval decision.</Notice>}

        {state?.controls && (
          <>
            {state.controls.unavailable && (
              <Notice danger>
                Workflow control alerts could not be checked. Refresh before relying on this approval.
              </Notice>
            )}

            {!!state.controls.gateFindings?.length && (
              <Notice danger>
                <strong>Workflow protection needs attention.</strong>
                <p>
                  A workflow check found a missing or changed approval control for this issue type.
                  Ask a Jira administrator to review the workflow validator.
                </p>
                {state.controls.gateFindings.map((finding, index) => (
                  <p key={index}>{finding.detail} — last checked <When ms={finding.last_seen_at} /></p>
                ))}
              </Notice>
            )}

            {!!state.controls.incidents?.length && (
              <Notice danger>
                <strong>A control incident was recorded on this work item.</strong>
                {state.controls.incidents.map((incident, index) => (
                  <p key={index}>
                    {incident.event_type === 'UNAUTHORIZED_TRANSITION'
                      ? 'A controlled transition occurred without verified approval.'
                      : incident.event_type === 'BASELINE_CAPTURE_FAILED'
                        ? 'An approved transition did not produce a complete baseline.'
                        : 'A workflow control incident was recorded.'}{' '}
                    <When ms={incident.occurred_at} />
                  </p>
                ))}
                <p>
                  Review the issue history and workflow controls with an administrator. These are
                  historical records; a later approval does not erase them.
                </p>
              </Notice>
            )}
          </>
        )}

        {state && (
          <>
            {state.record && <DriftSection drift={state.drift} issueKey={issueKey ?? state.issue?.key} />}
            {state.tier === 'observer' ? (
              <Card title="Approval">
                <Notice>{state.state ?? 'Waiting on signature'}</Notice>
              </Card>
            ) : (
              <ApprovalControls
                state={state}
                issueKey={issueKey}
                onDone={async () => { await refresh(); onDone?.(); }}
                disabled={!!error || refreshing}
              />
            )}
            <BaselineRecord record={state.record} baseline={state.baseline} />
            <RestoreStatus
              issueKey={issueKey ?? state.issue?.key}
              revision={`${state.record?.version}:${state.drift.evidenceHash ?? ''}`}
            />
          </>
        )}
    </div>
  );
}

