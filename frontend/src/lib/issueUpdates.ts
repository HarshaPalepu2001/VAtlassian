import { events } from '@forge/bridge';

export type RefreshOptions = { background?: boolean };

/**
 * Refresh on Jira/app events, focus and visibility changes. Jira events can
 * lag or be absent after app writes, and other tabs may have changed data.
 * The mounted view owns the listeners. These background refreshes update
 * loaded data in place and preserve it if a request fails.
 */
export function subscribeIssueUpdates(refresh: (options: RefreshOptions) => void | Promise<void>) {
  let stopped = false;
  const subscriptions: { unsubscribe: () => void }[] = [];
  const background = { background: true };
  const update = () => {
    if (!stopped && document.visibilityState !== 'hidden') {
      void refresh(background);
      // Jira REST API has read replica lag. When JIRA_ISSUE_CHANGED fires, a synchronous
      // fetch might return the old data. We schedule follow-up refreshes to ensure we
      // capture the drifted state once the replicas converge.
      setTimeout(() => { if (!stopped && document.visibilityState !== 'hidden') void refresh(background); }, 2000);
      setTimeout(() => { if (!stopped && document.visibilityState !== 'hidden') void refresh(background); }, 5000);
    }
  };
  window.addEventListener('focus', update);
  document.addEventListener('visibilitychange', update);
  for (const event of ['JIRA_ISSUE_CHANGED', 'VA_ISSUE_CHANGED', 'VA_CONFIGURATION_CHANGED']) {
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
