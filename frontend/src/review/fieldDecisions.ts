/**
 * Draft field decisions for the review window.
 * See docs/specs/2026-10-07-drift-field-decision-design.md.
 *
 * These pure functions keep swipes, keyboard input, buttons and Reset all
 * consistent. Draft choices are requests, not evidence. The server re-derives
 * and checks the whole map before signing or applying it.
 * A missing entry means undecided. These functions never mutate state.
 */
export type Choice = 'APPROVE' | 'REJECT';
export type Decisions = Record<string, Choice>;
export type Direction = 'ltr' | 'rtl';
export type DecisionKey = 'ArrowRight' | 'ArrowLeft' | 'Escape' | 'Backspace' | 'Enter' | ' ';
/** What a decision needs to know about a field; DiffField and the evidence's `mixed.fields` both satisfy it. */
export type Decidable = { fieldId: string; restorable?: string | null; retained?: boolean | null };
export type MixedFacts = { eligible: boolean; reason: string | null } | null | undefined;

const CANNOT_RESTORE = new Set(['NO', 'NOT_RETAINED']);

/** Why this field cannot be rejected, or null when it can. Shown beside the control. */
export function blocked(field: Decidable): string | null {
  if (field.restorable === 'NO') return "Jira can't undo this kind of change, so it can only be approved.";
  if (CANNOT_RESTORE.has(field.restorable ?? '') || field.retained === false) {
    return "Its approved value was not kept, so it can't be restored. It can only be approved.";
  }
  return null;
}

/** An undecided field stays undecided; a refused rejection leaves the state as it was. */
export function decide(state: Decisions, field: Decidable, choice: Choice): Decisions {
  if (choice === 'REJECT' && blocked(field)) return state;
  return state[field.fieldId] === choice ? state : { ...state, [field.fieldId]: choice };
}

export function reset(state: Decisions, fieldId: string): Decisions {
  if (!(fieldId in state)) return state;
  const { [fieldId]: _dropped, ...rest } = state;
  return rest;
}

/** Dragging left to right rejects the change; right to left approves it. */
export function swipe(state: Decisions, field: Decidable, direction: Direction): Decisions {
  return decide(state, field, direction === 'ltr' ? 'REJECT' : 'APPROVE');
}

/** Enter and Space only re-confirm a choice already made; they never invent one. */
export function key(state: Decisions, field: Decidable, pressed: DecisionKey): Decisions {
  switch (pressed) {
    case 'ArrowRight': return decide(state, field, 'REJECT');
    case 'ArrowLeft': return decide(state, field, 'APPROVE');
    case 'Escape':
    case 'Backspace': return reset(state, field.fieldId);
    default: return state;
  }
}

/** Decisions for fields the review no longer shows (an evidence refresh) are dropped. */
export function prune(state: Decisions, fields: Decidable[]): Decisions {
  const present = new Set(fields.map(field => field.fieldId));
  const kept = Object.entries(state).filter(([fieldId]) => present.has(fieldId));
  return kept.length === Object.keys(state).length ? state : Object.fromEntries(kept);
}

export function summary(fields: Decidable[], state: Decisions) {
  let approve = 0, reject = 0;
  for (const field of fields) {
    if (state[field.fieldId] === 'APPROVE') approve += 1;
    else if (state[field.fieldId] === 'REJECT') reject += 1;
  }
  const undecided = fields.length - approve - reject;
  return { approve, reject, undecided, text: `${approve} approve · ${reject} reject · ${undecided} undecided` };
}

export type SaveGate = {
  fields: Decidable[];
  state: Decisions;
  mixed: MixedFacts;
  loading: boolean;
  /** The evidence read failed. */
  error: string;
  /** A previous read is still on screen while its replacement loads. */
  held: boolean;
  /** This reviewer may decide at all. */
  eligible: boolean;
};

/** One answer to "may this be saved?", with the sentence that explains a no. */
export function canSave({ fields, state, mixed, loading, error, held, eligible }: SaveGate): { enabled: boolean; reason: string } {
  const no = (reason: string) => ({ enabled: false, reason });
  if (loading) return no('The current record is still loading.');
  if (error) return no('The current record could not be loaded, so nothing can be decided yet.');
  if (held) return no('The record is being refreshed. Decide once it has loaded.');
  if (!eligible) return no('You are not an eligible reviewer for this work item.');
  if (!mixed) return no('Deciding field by field is not available for this review.');
  if (!mixed.eligible) return no(unavailable(mixed.reason));
  if (fields.length === 0) return no('Nothing has changed, so there is nothing to decide.');
  if (fields.some(field => state[field.fieldId] === 'REJECT' && blocked(field))) {
    return no('A field you chose to reject cannot be restored. Approve it instead.');
  }
  const { undecided } = summary(fields, state);
  if (undecided > 0) return no(`${undecided} ${undecided === 1 ? 'field still needs' : 'fields still need'} a decision.`);
  return { enabled: true, reason: '' };
}

/** What the server is told: only decided fields, in the order the server sorts them. */
export function payload(fields: Decidable[], state: Decisions): { fieldId: string; decision: Choice }[] {
  return fields
    .filter(field => state[field.fieldId] === 'APPROVE' || state[field.fieldId] === 'REJECT')
    .map(field => ({ fieldId: field.fieldId, decision: state[field.fieldId] }))
    // Code-unit order, never localeCompare: it has to equal the server's own comparison.
    .sort((x, y) => (x.fieldId < y.fieldId ? -1 : x.fieldId > y.fieldId ? 1 : 0));
}

/** The user-facing reason the field-by-field review is not offered. */
export function unavailable(reason: string | null | undefined): string {
  switch (reason) {
    case 'STRUCTURE_CHANGED': return 'Work items were added, removed or moved, so these changes can only be approved or rejected together.';
    case 'HIDDEN_CHANGES': return 'Some changes are on work items you cannot see, so these changes can only be approved or rejected together.';
    case 'NOT_TREE_BASELINE': return "This work item's approved record predates field-by-field review, so changes can only be approved or rejected together.";
    default: return 'Deciding field by field is not available for this review.';
  }
}
