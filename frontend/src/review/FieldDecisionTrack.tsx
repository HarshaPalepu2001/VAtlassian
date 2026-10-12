import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { blocked, decide, key as pressKey, reset, swipe } from './fieldDecisions';
import type { Decidable, DecisionKey, Decisions } from './fieldDecisions';

/** How far a drag has to travel before it counts as a decision. */
const THRESHOLD = 40;
const THUMB_OUTER_WIDTH = 38;
const TRACK_INSET = 3;
const KEYS = new Set<string>(['ArrowRight', 'ArrowLeft', 'Escape', 'Backspace', 'Enter', ' ']);

/**
 * ONE FIELD'S DECISION: approve the change, reject it, or not yet.
 *
 * Three positions on a track: Approve on the left, undecided in the middle,
 * Reject on the right. Dragging the handle left to right rejects, right to left
 * approves. A drag is only ever a convenience: the keyboard (arrow keys on the
 * track), the three buttons beneath it, and Reset all make exactly the same
 * change through the same pure functions, and the choice is also written out in
 * words in a polite live region — it never relies on colour or on dragging.
 *
 * Choosing here only records a request. Nothing is signed or written until the
 * reviewer saves and authenticates (see ReviewWindow and ApprovalControls).
 */
export default function FieldDecisionTrack({ field, name, state, onChange }: {
  field: Decidable;
  /** The field's name as the reviewer reads it. */
  name: string;
  state: Decisions;
  onChange: (next: Decisions) => void;
}) {
  const choice = state[field.fieldId];
  const why = blocked(field);
  const start = useRef<number | null>(null);
  const [dragLeft, setDragLeft] = useState<number | null>(null);

  const apply = (next: Decisions) => { if (next !== state) onChange(next); };

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Space and Enter on one of the buttons below belong to that button.
    if (event.target !== event.currentTarget || !KEYS.has(event.key)) return;
    event.preventDefault();
    apply(pressKey(state, field, event.key as DecisionKey));
  }
  function down(event: PointerEvent<HTMLDivElement>) {
    start.current = event.clientX;
    setDragLeft(pointerLeft(event));
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function pointerLeft(event: PointerEvent<HTMLDivElement>) {
    const track = event.currentTarget;
    const rect = track.getBoundingClientRect();
    const width = track.clientWidth || rect.width;
    const left = rect.left + track.clientLeft;
    const min = TRACK_INSET;
    const max = Math.max(min, width - THUMB_OUTER_WIDTH - TRACK_INSET);
    return Math.max(min, Math.min(max, event.clientX - left - (THUMB_OUTER_WIDTH / 2)));
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (start.current == null) return;
    setDragLeft(pointerLeft(event));
  }
  function up(event: PointerEvent<HTMLDivElement>) {
    if (start.current == null) return;
    const travelled = event.clientX - start.current;
    start.current = null;
    setDragLeft(null);
    if (travelled >= THRESHOLD) apply(swipe(state, field, 'ltr'));
    else if (travelled <= -THRESHOLD) apply(swipe(state, field, 'rtl'));
  }
  function cancel() { start.current = null; setDragLeft(null); }

  const position = choice === 'APPROVE' ? 'approve' : choice === 'REJECT' ? 'reject' : 'none';
  const status = choice === 'REJECT' ? `Reject change selected for ${name}`
    : choice === 'APPROVE' ? `Approve change selected for ${name}`
      : `No decision yet for ${name}`;

  return (
    <div className="va-decision" role="group" aria-label={`Decision for ${name}`}>
      <div className="va-track" data-choice={position} tabIndex={0} onKeyDown={onKeyDown}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
        aria-label={`${name}: use the left and right arrow keys, or the buttons below`}>
        <span className="va-track__label va-track__label--approve" aria-hidden>Approve</span>
        <span className="va-track__label va-track__label--reject" aria-hidden>Reject</span>
        <span className="va-track__thumb" aria-hidden style={dragLeft !== null ? { left: `${dragLeft}px`, transition: 'none' } : undefined} />
      </div>
      <div className="va-decision__buttons">
        <button type="button" className="va-button" aria-pressed={choice === 'APPROVE'}
          onClick={() => apply(decide(state, field, 'APPROVE'))}>Approve change</button>
        <button type="button" className="va-button" aria-pressed={choice === 'REJECT'} disabled={Boolean(why)}
          onClick={() => apply(decide(state, field, 'REJECT'))}>Reject change</button>
        <button type="button" className="va-button" disabled={!choice}
          onClick={() => apply(reset(state, field.fieldId))}>Reset decision</button>
      </div>
      {why && <p className="va-subtlest va-decision__why">{why}</p>}
      <p className="va-decision__status" role="status" aria-live="polite">{status}</p>
    </div>
  );
}
