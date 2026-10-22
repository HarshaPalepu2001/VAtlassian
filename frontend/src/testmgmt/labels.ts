import type { Tone } from '../ui/primitives';

const WORDS: Record<string, string> = {
  PUBLISHED: 'Waiting for sign-off', SIGNED: 'Signed', REJECTED: 'Rejected', SUPERSEDED: 'Superseded',
  IN_PROGRESS: 'In progress', SIGNING: 'Signing', NOT_EXECUTED: 'Not executed',
  PASSED: 'Passed', PARTLY_PASSED: 'Partly passed', FAILED: 'Failed', BLOCKED: 'Blocked',
  NOT_APPLICABLE: 'Not applicable', NOT_RUN: 'Not run',
  INTENT: 'Bug pending', CREATED: 'Bug created', NEEDS_REPAIR: 'Bug needs repair'
};

export const words = (value: string | null | undefined) => (value ? WORDS[value] ?? value : '');

export function stateTone(state: string): Tone {
  if (state === 'SIGNED') return 'success';
  if (state === 'REJECTED' || state === 'NOT_EXECUTED') return 'danger';
  if (state === 'PUBLISHED' || state === 'SIGNING') return 'warning';
  return 'neutral';
}

export function resultTone(result: string): Tone {
  if (result === 'PASSED') return 'success';
  if (result === 'FAILED' || result === 'BLOCKED') return 'danger';
  if (result === 'PARTLY_PASSED') return 'warning';
  return 'neutral';
}

export const PROBLEMS: Record<string, string> = {
  NO_STEPS: 'This run has no steps.',
  STEPS_NOT_RUN: 'Record a result for every step before signing.',
  NA_REASON_REQUIRED: 'A step marked Not applicable needs a reason in its comment.',
  RUN_BLOCKED: 'A blocked run cannot be signed. Resume once the cause is removed, or close it as not executed.'
};
