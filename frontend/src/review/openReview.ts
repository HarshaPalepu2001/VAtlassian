import { Modal } from '@forge/bridge';
import { recordHarnessEvent } from '../lib/harness';

export type ReviewTab = 'changes' | 'summary' | 'record';
/** What the review window hands back when it closes. */
export type ReviewOutcome = { decided?: boolean } | null | undefined;
/** The context a review window is opened with — read back in ReviewWindow. */
export type ReviewContext = { view: 'review'; issueKey?: string; tab: ReviewTab };

/**
 * THE PANEL NEVER GROWS. Everything a reviewer reads at length — the changes,
 * the AI summary, the full baseline record — opens here, in a Jira modal, so
 * the issue panel stays the same size whatever state the work item is in.
 *
 * The window is the same Custom UI resource with the same resolver, so it
 * reads the summary and evidence exactly as the panel does and carries its
 * own Approve and Reject. `onClose` receives `{ decided: true }` when a
 * decision was recorded inside it, which is the caller's cue to re-read.
 */
export function openReview({ issueKey, tab = 'changes', onClose }: { issueKey?: string; tab?: ReviewTab; onClose?: (outcome: ReviewOutcome) => void }) {
  recordHarnessEvent('UI', 'open:reviewWindow', { issueKey, tab });
  const context: ReviewContext = { view: 'review', issueKey, tab };
  const modal = new Modal({
    size: 'max',
    context,
    closeOnEscape: true,
    onClose: (payload: ReviewOutcome) => onClose?.(payload)
  });
  return modal.open();
}

/** True when this app instance was opened as a review window. */
export function isReviewContext(modal: unknown): modal is ReviewContext {
  return !!modal && typeof modal === 'object' && (modal as { view?: unknown }).view === 'review';
}
