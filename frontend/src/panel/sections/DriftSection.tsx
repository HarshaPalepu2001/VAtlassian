import { lazy, Suspense, useState } from 'react';
import Button from '@atlaskit/button';
import { Loading } from '../../ui/primitives';
import { plural } from '../../ui/format';
import type { PanelEvidence, PanelSummary } from '../types';
import { recordHarnessEvent } from '../../lib/harness';
import { changedFieldCount } from '../approvalModel';


const ReviewWorkspace = lazy(() => import('../../review/ReviewWorkspace'));

/**
 * The state of the record, at the top of the panel.
 *
 * This was a yellow warning box. Drift on a signed record is not a malfunction
 * to be warned about — it is the reviewer's actual work arriving, and the tone
 * of the screen should say "here is what needs deciding", not "something went
 * wrong". So it reads as a heading with a count, the way an inbox does, and the
 * colour is spent on the individual changes below where it encodes materiality.
 *
 * The parent supplies one authoritative current-record evidence read. Until
 * it arrives, this section shows a neutral checking state rather than a clean
 * result or an actionable drift decision.
 */
export default function DriftSection({ drift, evidence, evidenceReady = true, issueKey }: { drift: PanelSummary['drift']; evidence?: PanelEvidence | null; evidenceReady?: boolean; issueKey?: string }) {
  const [open, setOpen] = useState(false);

  if (!evidenceReady) {
    return (
      <div className="va-banner" aria-busy="true">
        <strong>Checking the current record…</strong>
        <p>The approved baseline is being compared with the latest Jira content.</p>
      </div>
    );
  }

  if (!drift.count) {
    return (
      <div className="va-banner va-banner-success">
        <strong>Matches the approved baseline.</strong>
        <p>No tracked field has changed since this work item was signed.</p>
      </div>
    );
  }

  // ONE UNIT FOR BOTH NUMBERS.
  //
  // `drift.count` is FIELD-level: treeCollect sums Math.max(1, fields.length)
  // over every change. `changedFields` is NODE-level: buildTreeRejection pushes
  // one entry per FIELD_CHANGED change, and diffTree emits one of those per
  // node, carrying its own field list. Printing the two side by side is what
  // produced "3 changes since approval · 1 changed fields" on a single work
  // item with three edited fields — two true numbers counting different things.
  //
  // The breakdown is the one that has to move: it sits under a headline that is
  // already field-level, so it counts fields too, and the node categories
  // beside it stay node-level and say so in their own labels.
  const fieldCount = changedFieldCount(evidence?.drift);
  const addedCount = evidence?.drift?.addedNodes?.length ?? 0;
  const removedCount = evidence?.drift?.removedNodes?.length ?? 0;
  const movedCount = evidence?.drift?.movedNodes?.length ?? 0;
  const hasBreakdown = !!(fieldCount || addedCount || removedCount || movedCount);
  // A parent's review covers its children, each against its own baseline, and
  // one decision here approves or rejects them all. Say so before the reviewer
  // opens the list, since the parent itself may have no change of its own.
  const childrenChanged = (evidence?.drift?.groups ?? []).filter(g => g.kind === 'ISSUE' && !g.isRoot).length;

  return (
    <section className="va-stack">
      <div className="va-review-head">
        <span className="va-review-head__count">
          {plural(drift.count, 'change')} since approval
        </span>
        <span className="va-review-head__detail va-grow">
          {hasBreakdown ? (
            // plural() throughout, like the rest of this file. The hardcoded
            // "s" is what made a single change read as "1 changed fields".
            [
              fieldCount ? plural(fieldCount, 'changed field') : '',
              addedCount ? plural(addedCount, 'added node') : '',
              removedCount ? plural(removedCount, 'removed node') : '',
              movedCount ? plural(movedCount, 'moved node') : ''
            ].filter(Boolean).join(', ')
          ) : (
            drift.materialCount === 0
              ? 'All of them are formatting only.'
              : `${plural(drift.materialCount, 'change')} need${drift.materialCount === 1 ? 's' : ''} a decision.`
          )}
        </span>
        <Button appearance={open ? 'subtle' : 'primary'} onClick={() => {
          recordHarnessEvent('DRIFT', open ? 'click:hideChanges' : 'click:reviewChanges', { issueKey, driftCount: drift.count });
          setOpen(!open);
        }}>
          {open ? 'Hide changes' : 'Review changes'}
        </Button>
        {childrenChanged > 0 && (
          <span className="va-review-head__detail" style={{ flexBasis: '100%' }}>
            {childrenChanged === 1 ? '1 child work item has' : `${childrenChanged} child work items have`} changes.
            {' '}A decision here covers {childrenChanged === 1 ? 'it' : 'all of them'}; each can also be decided on its own.
          </span>
        )}

      </div>
      {open && (
        <Suspense fallback={<Loading label="Opening review…" />}>
          <ReviewWorkspace issueKey={issueKey} evidenceHash={evidence?.evidenceHash ?? undefined} evidence={evidence} />
        </Suspense>
      )}
    </section>
  );
}
