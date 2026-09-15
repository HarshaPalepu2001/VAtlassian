import { events } from '@forge/bridge';

/** Jira events can lag or be absent after app writes, and another browser tab
 * may have changed things since this one last painted — so this reconciles on
 * focus and on becoming visible again, not on a fixed timer. All listeners are
 * owned by the mounted view. */
export function subscribeIssueUpdates(refresh: () => void | Promise<void>) {
  let stopped = false;
  const subscriptions: { unsubscribe: () => void }[] = [];
  const update = () => {
    if (!stopped && document.visibilityState !== 'hidden') {
      void refresh();
      // Jira REST API has read replica lag. When JIRA_ISSUE_CHANGED fires, a synchronous
      // fetch might return the old data. We schedule follow-up refreshes to ensure we
      // capture the drifted state once the replicas converge.
      setTimeout(() => { if (!stopped && document.visibilityState !== 'hidden') void refresh(); }, 2000);
      setTimeout(() => { if (!stopped && document.visibilityState !== 'hidden') void refresh(); }, 5000);
    }
  };
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
