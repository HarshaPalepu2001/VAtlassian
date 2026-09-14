import { approvalMode } from '../lib/assurance';
import type { AssuranceLevel } from '../lib/assurance';
import type { PanelSummary, PanelTransition } from './types';

export function approvalReady({ level, confirmed, code, busy, eligible }: { level: AssuranceLevel; confirmed: boolean; code: string; busy: boolean; eligible: boolean }) {
  const mode = approvalMode(level);
  return eligible && !busy && confirmed && mode !== 'unavailable' && (mode !== 'totp' || /^\d{6}$/.test(code));
}

export function approvalPayload({ issueKey, transitionId, toStatusId, decision, code, note, evidenceHash, confirmed, level }: { issueKey?: string; transitionId?: string; toStatusId?: string; decision: 'APPROVE' | 'REJECT'; code: string; note: string; evidenceHash?: string | null; confirmed: boolean; level: AssuranceLevel }) {
  return { issueKey, transitionId, toStatusId, decision, confirmed, note: note.trim() || undefined, expectedEvidenceHash: evidenceHash ?? undefined, ...(approvalMode(level) === 'totp' ? { code } : {}) };
}

/** The facts a panel transition and a transition-screen action share. */
export type TransitionFacts = {
  transitionId: string;
  toStatusId?: string | null;
  toStatusName?: string | null;
  name?: string | null;
  label?: string | null;
  anyStatus?: boolean;
  capturesBaseline?: boolean;
  blocksOnDrift?: boolean;
};

const ARROW = '->';

/** The progress copy every approval surface shows the moment an action starts. */
export const PROGRESS = {
  preparing: 'Preparing signature',
  biometric: 'Checking biometric',
  publishing: 'Publishing baseline',
  restoring: 'Starting restoration',
  restoreRunning: 'Restoration in progress'
} as const;

/** The destination status a transition reaches. Never the transition's own
 *  Jira name, which can be anything an administrator typed. */
export function transitionDestination(transition: TransitionFacts): string {
  return transition.toStatusName || transition.toStatusId || 'the next status';
}

/**
 * "Any status -> Done" for a wildcard-source rule, "In Progress -> Done" for a
 * directed one. `fromStatusName` is the issue's CURRENT status name — Jira
 * only ever offers a directed (non-wildcard) transition from the exact status
 * it is configured for, so the current status IS that transition's source.
 */
export function transitionScopeLabel(transition: TransitionFacts, fromStatusName?: string | null): string {
  const from = transition.anyStatus ? 'Any status' : (fromStatusName || 'the current status');
  return `${from} ${ARROW} ${transitionDestination(transition)}`;
}

/** The primary decision button's label. */
export function transitionApproveLabel(transition: TransitionFacts): string {
  return `Approve ${ARROW} ${transitionDestination(transition)}`;
}

/**
 * A selector option: exact scope, the server's `label`, then the rule's Jira
 * name and id. Two siblings into the same status — or a wildcard and a
 * directed edge both reaching "Done" — can never read identically, and the
 * option's `value` is always the exact transitionId.
 */
export function transitionOptionLabel(transition: TransitionFacts, fromStatusName?: string | null): string {
  const rule = [transition.name, `#${transition.transitionId}`].filter(Boolean).join(' ');
  return `${transitionScopeLabel(transition, fromStatusName)} - ${transition.label || transitionApproveLabel(transition)} (${rule})`;
}

export function captureFact(transition: TransitionFacts): string {
  return transition.capturesBaseline ? 'Captures a new baseline' : 'Does not capture a baseline';
}

export function driftFact(transition: TransitionFacts): string {
  return transition.blocksOnDrift ? 'Blocked while changes are unapproved' : 'Not blocked by unapproved changes';
}

export function movingTo(transition?: TransitionFacts): string {
  return `Moving to ${transition ? transitionDestination(transition) : 'the next status'}`;
}

/** What the server does once a signature is proven, named for the reviewer. */
export function recordingProgress({ decision, reviewingDrift, transition }: { decision: 'APPROVE' | 'REJECT'; reviewingDrift: boolean; transition?: TransitionFacts }): string {
  if (decision === 'REJECT') return PROGRESS.restoring;
  if (reviewingDrift || transition?.capturesBaseline) return PROGRESS.publishing;
  return movingTo(transition);
}

/** A restore state in words. Anything not yet terminal is still in progress. */
export function restoreStateLabel(state: string): string {
  switch (state) {
    case 'COMPLETE_WITH_REPLACEMENTS': return 'Complete with replacement identities';
    case 'COMPLETE': return 'Restored and verified';
    case 'PARTIAL': return 'Partly restored';
    case 'FAILED': return 'Restore failed';
    case 'QUEUING_FAILED': return 'Queuing failed';
    case 'ERROR': return 'Restore error';
    default: return PROGRESS.restoreRunning;
  }
}

export type SelectedAction = {
  reviewingDrift: boolean;
  eligible: PanelTransition[];
  transition?: PanelTransition;
  /** '' when nothing is chosen; otherwise 'drift' or 'transition:<exact id>'. */
  actionKey: string;
};

/**
 * THE ACTION IDENTITY every piece of action-bound state is keyed to — the
 * code, the confirmation, the open challenge, and the loaded evidence.
 *
 * Drift review is one fixed action. Otherwise a single applicable transition
 * is the action; with two or more, only an explicit selection that is still
 * applicable counts. A selection that vanished or lost eligibility resolves
 * to nothing rather than to a sibling reaching the same status.
 */
export function resolveSelectedAction(summary: PanelSummary | null | undefined, selectedTransitionId: string): SelectedAction {
  if (!summary) return { reviewingDrift: false, eligible: [], actionKey: '' };
  const reviewingDrift = (summary.drift?.count ?? 0) > 0;
  const eligible = (summary.transitions ?? []).filter(t => t.canApprove);
  if (reviewingDrift) return { reviewingDrift, eligible, actionKey: 'drift' };
  const transition = eligible.length === 1 ? eligible[0] : eligible.find(t => t.transitionId === selectedTransitionId);
  return { reviewingDrift, eligible, transition, actionKey: transition ? `transition:${transition.transitionId}` : '' };
}
