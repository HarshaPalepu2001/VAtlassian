import { Modal } from '@forge/bridge';
import { recordHarnessEvent } from '../lib/harness';

export type ReviewTab = 'changes' | 'summary' | 'record';
/** What the review window hands back when it closes. */
export type ReviewOutcome = { decided?: boolean } | null | undefined;
/** Context passed to the review window and read by ReviewWindow. */
export type ReviewContext = { view: 'review'; issueKey?: string; tab: ReviewTab };

/**
 * Open changes, the AI summary and baseline history in a Jira modal to keep
 * the issue panel compact. The modal uses the same Custom UI resource and
 * resolver as the panel, with its own Approve and Reject controls.
 * When a decision is recorded, onClose receives { decided: true } so the
 * caller can refresh.
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
