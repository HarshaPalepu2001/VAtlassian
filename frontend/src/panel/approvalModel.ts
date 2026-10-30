import { approvalMode } from '../lib/assurance';
import type { AssuranceLevel } from '../lib/assurance';
import type { PanelSummary, PanelTransition } from './types';

export function approvalReady({ level, confirmed, code, busy, eligible }: { level: AssuranceLevel; confirmed: boolean; code: string; busy: boolean; eligible: boolean }) {
  const mode = approvalMode(level);
  return eligible && !busy && confirmed && mode !== 'unavailable' && (mode !== 'totp' || /^\d{6}$/.test(code));
}

export type FieldDecision = { fieldId: string; decision: 'APPROVE' | 'REJECT' };

export function approvalPayload({ issueKey, transitionId, toStatusId, intent, decision, decisions, code, note, evidenceHash, confirmed, level }: { issueKey?: string; transitionId?: string; toStatusId?: string; intent?: 'WORKFLOW' | 'DRIFT' | 'DRIFT_MIXED'; decision?: 'APPROVE' | 'REJECT'; decisions?: FieldDecision[]; code: string; note: string; evidenceHash?: string | null; confirmed: boolean; level: AssuranceLevel }) {
  // A per-field decision names no whole-set decision: the server derives its
  // meaning from the map, and the map is part of what is signed.
  const mixed = intent === 'DRIFT_MIXED';
  return { issueKey, transitionId, toStatusId, intent, ...(mixed ? { decisions } : { decision }), confirmed, note: note.trim() || undefined, expectedEvidenceHash: evidenceHash ?? undefined, ...(approvalMode(level) === 'totp' ? { code } : {}) };
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
};

const ARROW = '->';

/** The progress copy every approval surface shows the moment an action starts. */
export const PROGRESS = {
  preparing: 'Preparing signature',
  biometric: 'Checking biometric',
  publishing: 'Publishing baseline',
  restoring: 'Starting restoration',
  restoreRunning: 'Restoration in progress',
  savingDecisions: 'Saving field decisions'
} as const;

/** The destination status a transition reaches. Never the transition's own
 *  Jira name, which can be anything an administrator typed. */
export function transitionDestination(transition: TransitionFacts): string {
  return transition.toStatusName || transition.toStatusId || 'the next status';
}

/**
 * Label wildcard rules "Any status -> Done" and directed rules
 * "In Progress -> Done". Jira offers directed transitions only from their
 * configured source, so fromStatusName is that source.
 */
export function transitionScopeLabel(transition: TransitionFacts, fromStatusName?: string | null): string {
  const from = transition.anyStatus ? 'Any status' : (fromStatusName || 'the current status');
  return `${from} ${ARROW} ${transitionDestination(transition)}`;
}

/** The primary decision button's label: "Approve to Done", the way Jira names a move. */
export function transitionApproveLabel(transition: TransitionFacts): string {
  return `Approve to ${transitionDestination(transition)}`;
}

/**
 * Identify each option by its scope, server label, Jira name and id.
 * Transitions with the same destination must remain distinguishable.
 * The option value is always the exact transitionId.
 */
export function transitionOptionLabel(transition: TransitionFacts, fromStatusName?: string | null): string {
  const rule = [transition.name, `#${transition.transitionId}`].filter(Boolean).join(' ');
  return `${transitionScopeLabel(transition, fromStatusName)} - ${transition.label || transitionApproveLabel(transition)} (${rule})`;
}

export function captureFact(transition: TransitionFacts): string {
  return transition.capturesBaseline ? 'Captures a new baseline' : 'Does not capture a baseline';
}

/** Drift always holds a work item still; no transition can opt out of it. */
export function driftFact(): string {
  return 'Blocked while changes are unapproved';
}

export function movingTo(transition?: TransitionFacts): string {
  return `Moving to ${transition ? transitionDestination(transition) : 'the next status'}`;
}

/** What the server does once a signature is proven, named for the reviewer. */
export function recordingProgress({ decision, reviewingDrift, transition }: { decision: 'APPROVE' | 'REJECT' | 'MIXED'; reviewingDrift: boolean; transition?: TransitionFacts }): string {
  if (decision === 'MIXED') return PROGRESS.savingDecisions;
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
 * Key the code, confirmation, challenge and evidence to one action.
 * Drift review is a fixed action. A single applicable transition is selected
 * automatically. Multiple transitions require an explicit, still-applicable
 * selection. A removed or ineligible selection resolves to nothing.
 */
export function resolveSelectedAction(summary: PanelSummary | null | undefined, selectedTransitionId: string): SelectedAction {
  if (!summary) return { reviewingDrift: false, eligible: [], actionKey: '' };
  const reviewingDrift = (summary.drift?.count ?? 0) > 0;
  const eligible = (summary.transitions ?? []).filter(t => t.canApprove);
  if (reviewingDrift) return { reviewingDrift, eligible, actionKey: 'drift' };
  const transition = eligible.length === 1 ? eligible[0] : eligible.find(t => t.transitionId === selectedTransitionId);
  return { reviewingDrift, eligible, transition, actionKey: transition ? `transition:${transition.transitionId}` : '' };
}

/**
 * Count fields in a node-level change list. Each drift.changedFields entry
 * represents a node, and its fields array contains FIELD_CHANGED details.
 * The panel header and breakdown share this count. A node with no field list
 * counts as one change.
 */
export function changedFieldCount(drift?: { changedFields?: { fields?: unknown[] }[] } | null): number {
  return (drift?.changedFields ?? []).reduce(
    (total, change) => total + Math.max(1, change?.fields?.length ?? 0),
    0
  );
}
