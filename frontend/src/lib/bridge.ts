import { invoke as forgeInvoke, events } from '@forge/bridge';
/** The app requests plain resolver bodies, never bridge response metadata. */
export async function invoke<T = unknown>(key: string, payload?: Record<string, unknown>): Promise<T> {
  // Bridge 6 types include a metadata envelope even when none was requested.
  // Its transport returns the raw body for this two-argument invocation.
  const result = await forgeInvoke<T>(key, payload) as T;
  if (['signature:submit', 'approval:submit', 'approval:retryTransition', 'restore:retry'].includes(key)) {
    // A partial restore also changes visible data. Re-read on every returned
    // decision outcome; a bridge notification failure must not hide the result.
    void events.emit('VA_ISSUE_CHANGED', { issueKey: payload?.issueKey }).catch(() => {});
  }
  return result;
}
