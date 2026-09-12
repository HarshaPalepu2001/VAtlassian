import { lazy, Suspense, useState } from 'react';
import Button from '@atlaskit/button';
import { Loading } from '../../ui/primitives';
import { plural } from '../../ui/format';
import type { PanelState } from '../types';

const ReviewWorkspace = lazy(() => import('../../review/ReviewWorkspace'));

/**
 * The state of the record, at the top of the panel.
 *
 * This was a yellow warning box. Drift on a signed record is not a malfunction
 * to be warned about — it is the reviewer's actual work arriving, and the tone
 * of the screen should say "here is what needs deciding", not "something went
 * wrong". So it reads as a heading with a count, the way an inbox does, and the
 * colour is spent on the individual changes below where it encodes materiality.
 */
export default function DriftSection({ drift, issueKey }: {drift: PanelState['drift']; issueKey?: string}) {
  const [open, setOpen] = useState(false);

  if (!drift.count) {
    return (
      <div className="va-banner va-banner-success">
        <strong>Matches the approved baseline.</strong>
        <p>No tracked field has changed since this work item was signed.</p>
      </div>
    );
  }

  return (
    <section className="va-stack">
      <div className="va-review-head">
        <span className="va-review-head__count">
          {plural(drift.count, 'change')} since approval
        </span>
        <span className="va-review-head__detail va-grow">
          {(drift.addedNodes || drift.removedNodes || drift.movedNodes) ? (
            [
              drift.changedFields?.length ? `${drift.changedFields.length} changed fields` : '',
              drift.addedNodes?.length ? `${drift.addedNodes.length} added nodes` : '',
              drift.removedNodes?.length ? `${drift.removedNodes.length} removed nodes` : '',
              drift.movedNodes?.length ? `${drift.movedNodes.length} moved nodes` : ''
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
          <ReviewWorkspace issueKey={issueKey} evidenceHash={drift.evidenceHash} />
        </Suspense>
      )}
    </section>
  );
}
