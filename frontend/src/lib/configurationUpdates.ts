import { useEffect, useRef } from 'react';
import { events } from '@forge/bridge';

/** Refresh persisted configuration after another surface changes it or the
 * user returns from another tab. Own every listener; never add a polling loop. */
export function useConfigurationUpdates(refresh: () => void | Promise<unknown>) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    let stopped = false;
    let subscription: { unsubscribe: () => void } | undefined;
    const update = () => {
      if (!stopped && document.visibilityState !== 'hidden') void latest.current();
    };
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    // Some local preview bridges do not supply cross-surface events.
    if (events.on) void events.on('VA_CONFIGURATION_CHANGED', update).then(s => {
      if (stopped) s.unsubscribe(); else subscription = s;
    }).catch(() => {});
    return () => {
      stopped = true;
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
      subscription?.unsubscribe();
    };
  }, []);
}
