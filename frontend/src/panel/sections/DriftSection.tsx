import { lazy, Suspense, useState } from 'react';
import Button from '@atlaskit/button';
import { Loading } from '../../ui/primitives';
import { plural } from '../../ui/format';
import type { PanelEvidence, PanelSummary } from '../types';

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
 * The count and material count are summary facts, present immediately. The
 * added/removed/moved node breakdown is evidence — loaded lazily by the
 * parent (IssuePanel) once this section is in drift mode — and is shown only
 * once it has arrived; its absence never blocks the count or the decision.
 */
export default function DriftSection({ drift, evidence, issueKey }: { drift: PanelSummary['drift']; evidence?: PanelEvidence | null; issueKey?: string }) {
  const [open, setOpen] = useState(false);

  if (!drift.count) {
    return (
      <div className="va-banner va-banner-success">
        <strong>Matches the approved baseline.</strong>
        <p>No tracked field has changed since this work item was signed.</p>
      </div>
    );
  }

  const hasBreakdown = !!(evidence?.drift?.addedNodes?.length || evidence?.drift?.removedNodes?.length || evidence?.drift?.movedNodes?.length || evidence?.drift?.changedFields?.length);

  return (
    <section className="va-stack">
      <div className="va-review-head">
        <span className="va-review-head__count">
          {plural(drift.count, 'change')} since approval
        </span>
        <span className="va-review-head__detail va-grow">
          {hasBreakdown ? (
            [
              evidence?.drift?.changedFields?.length ? `${evidence.drift.changedFields.length} changed fields` : '',
              evidence?.drift?.addedNodes?.length ? `${evidence.drift.addedNodes.length} added nodes` : '',
              evidence?.drift?.removedNodes?.length ? `${evidence.drift.removedNodes.length} removed nodes` : '',
              evidence?.drift?.movedNodes?.length ? `${evidence.drift.movedNodes.length} moved nodes` : ''
            ].filter(Boolean).join(', ')
          ) : (
            drift.materialCount === 0
              ? 'All of them are formatting only.'
              : `${plural(drift.materialCount, 'change')} need${drift.materialCount === 1 ? 's' : ''} a decision.`
          )}
        </span>
        <Button appearance={open ? 'subtle' : 'primary'} onClick={() => setOpen(!open)}>
          {open ? 'Hide changes' : 'Review changes'}
        </Button>
      </div>
      {open && (
        <Suspense fallback={<Loading label="Opening review…" />}>
          <ReviewWorkspace issueKey={issueKey} evidenceHash={evidence?.evidenceHash ?? undefined} />
        </Suspense>
      )}
    </section>
  );
}
