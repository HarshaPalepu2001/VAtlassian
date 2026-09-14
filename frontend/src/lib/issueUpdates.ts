import { events } from '@forge/bridge';

/** Jira events can lag or be absent after app writes, and another browser tab
 * may have changed things since this one last painted — so this reconciles on
 * focus and on becoming visible again, not on a fixed timer. All listeners are
 * owned by the mounted view. */
export function subscribeIssueUpdates(refresh: () => void | Promise<void>) {
  let stopped = false;
  const subscriptions: { unsubscribe: () => void }[] = [];
  const update = () => { if (!stopped && document.visibilityState !== 'hidden') void refresh(); };
  window.addEventListener('focus', update);
  document.addEventListener('visibilitychange', update);
  for (const event of ['JIRA_ISSUE_CHANGED', 'VA_ISSUE_CHANGED']) {
    events.on(event, update).then(subscription => {
      if (stopped) subscription.unsubscribe();
      else subscriptions.push(subscription);
    }).catch(() => {});
  }
  return () => {
    stopped = true;
    window.removeEventListener('focus', update);
    document.removeEventListener('visibilitychange', update);
    subscriptions.forEach(subscription => subscription.unsubscribe());
  };
}
