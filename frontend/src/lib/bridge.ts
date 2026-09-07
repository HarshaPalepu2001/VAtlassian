import { invoke as forgeInvoke } from '@forge/bridge';
/** The app requests plain resolver bodies, never bridge response metadata. */
export async function invoke<T = unknown>(key: string, payload?: Record<string, unknown>): Promise<T> {
  // Bridge 6 types include a metadata envelope even when none was requested.
  // Its transport returns the raw body for this two-argument invocation.
  return await forgeInvoke<T>(key, payload) as T;
}
