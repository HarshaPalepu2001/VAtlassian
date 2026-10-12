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
 * "Any status -> Done" for a wildcard-source rule, "In Progress -> Done" for a
 * directed one. `fromStatusName` is the issue's CURRENT status name — Jira
 * only ever offers a directed (non-wildcard) transition from the exact status
 * it is configured for, so the current status IS that transition's source.
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

/**
 * How many FIELDS changed, from a node-level change list.
 *
 * `drift.changedFields` holds one entry per NODE — `diffTree` emits a single
 * FIELD_CHANGED change per node carrying its own `fields` array — while every
 * number shown beside it counts fields. Reading `.length` off it is what made
 * three edits to one work item render as "3 changes since approval · 1 changed
 * fields": two true numbers in two different units.
 *
 * Shared by the panel header and the drift breakdown so the two cannot drift
 * apart again. A node with no field list still counts as one change, because
 * something about it did change.
 */
export function changedFieldCount(drift?: { changedFields?: { fields?: unknown[] }[] } | null): number {
  return (drift?.changedFields ?? []).reduce(
    (total, change) => total + Math.max(1, change?.fields?.length ?? 0),
    0
  );
}
