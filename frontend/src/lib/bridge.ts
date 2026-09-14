import { invoke as forgeInvoke, events } from '@forge/bridge';

/** Resolver keys whose success means a durable, visible state change — a
 *  signature recorded, a transition retried, a restoration retried. Every
 *  other open surface needs to know when one of these actually happens. */
const MUTATION_KEYS = ['signature:submit', 'approval:submit', 'approval:retryTransition', 'restore:retry'];

/** `respond()` on the server never rejects the resolver call — it resolves
 *  with `{ error, reason }` — so a failed mutation still returns here as a
 *  normal value. This is the one place that decides "durable" from that
 *  shape, so every caller of `invoke` gets the same answer without having to
 *  emit anything itself. A `transitionError` means Jira refused the move the
 *  decision was for, so the operation did not complete. */
function isDurable(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as { success?: boolean; ok?: boolean; error?: string; transitionError?: string };
  return r.success !== false && r.ok !== false && !r.error && !r.transitionError;
}

/** The app requests plain resolver bodies, never bridge response metadata. */
export async function invoke<T = unknown>(key: string, payload?: Record<string, unknown>): Promise<T> {
  // Bridge 6 types include a metadata envelope even when none was requested.
  // Its transport returns the raw body for this two-argument invocation.
  const result = await forgeInvoke<T>(key, payload) as T;
  // THE ONE PLACE THIS EVENT IS EMITTED for the Custom UI bundle. It fires
  // exactly once, only after the mutation is durable — never when the
  // resolver denies, validation fails, persistence fails, Jira refuses the
  // transition, or a WebAuthn ceremony was cancelled before recording
  // anything. Components must not emit this themselves; see
  // src/panel/sections/ApprovalControls.tsx and RestoreStatus.tsx, which rely
  // on this instead. (src/ui-kit/edit.jsx is a separate Forge UI Kit runtime
  // that cannot import this module and emits its own durable-only event.)
  if (MUTATION_KEYS.includes(key) && isDurable(result)) {
    void events.emit('VA_ISSUE_CHANGED', { issueKey: payload?.issueKey }).catch(() => {});
  }
  return result;
}
