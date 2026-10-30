/**
 * Deliver queued security alerts as Jira work items.
 *
 * Detection writes a local outbox row. This job attempts delivery every five
 * minutes, the shortest Forge scheduled-trigger interval. Describe that
 * cadence as "reported within five minutes", never "reported immediately".
 * See lib/alerts.js for the alert policy and channel choice.
 *
 * Delivery stays outside the lockout request. A caller can trigger that path
 * repeatedly; creating Jira work items inline would add network latency and
 * could turn a wrong-code response into a delivery error.
 *
 * Without a configured alert project, the job retains pending alerts and logs
 * the configuration gap on each run. Once configured, it delivers the backlog
 * in order. Recording an event does not prove anyone received it on time.
 */
import { asApp, route } from '@forge/api';
import { executeQuery } from '../lib/db.js';
import { pending, markDelivered, markAttemptFailed } from '../db/alertStore.js';
import { ALERT_SEVERITY } from '../lib/alerts.js';

export const PROJECT_KEY_CFG = 'alert.projectId';
export const ISSUE_TYPE_CFG = 'alert.issueTypeId';

const BATCH = 25;

export async function readAlertTarget() {
  const res = await executeQuery(
    'SELECT cfg_key, cfg_value FROM va_config WHERE cfg_key IN (?, ?)',
    [PROJECT_KEY_CFG, ISSUE_TYPE_CFG]
  );
  if (!res.result) {
    console.error('alerts: could not read alert destination config', res.error);
    return null;
  }
  const cfg = Object.fromEntries((res.data ?? []).map((r) => [r.cfg_key, r.cfg_value]));
  const projectId = cfg[PROJECT_KEY_CFG];
  const issueTypeId = cfg[ISSUE_TYPE_CFG];
  if (!projectId || !issueTypeId) return null;
  return { projectId, issueTypeId };
}

/** Create the work item. Returns its key, or throws with a readable reason. */
export async function deliverToJira(alert, target, { request = defaultCreate } = {}) {
  const response = await request({
    fields: {
      project: { id: String(target.projectId) },
      issuetype: { id: String(target.issueTypeId) },
      // Severity rides in the summary rather than a custom field: a priority or
      // label mapping would need per-customer configuration to mean anything,
      // and an alert that fails to deliver because a field scheme differs is
      // worse than one whose severity is in its title.
      summary: `[${alert.severity}] ${alert.title}`.slice(0, 254),
      description: JSON.parse(alert.body)
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jira ${response.status}: ${text.slice(0, 300)}`);
  }
  const created = await response.json();
  return created.key ?? created.id ?? 'created';
}

async function defaultCreate(body) {
  return asApp().requestJira(route`/rest/api/3/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
}

export async function run({ request = defaultCreate } = {}) {
  const started = Date.now();

  const queue = await pending(BATCH);
  if (queue === null) {
    console.error('alerts: outbox unreadable this run');
    return { ok: false, reason: 'OUTBOX_UNREADABLE' };
  }
  if (queue.length === 0) {
    return { ok: true, delivered: 0, pending: 0, ms: Date.now() - started };
  }

  const target = await readAlertTarget();
  if (!target) {
    const critical = queue.filter((a) => a.severity === ALERT_SEVERITY.CRITICAL).length;
    // Loud every run, on purpose. This is a configured-away control: the app is
    // detecting correctly and telling nobody, which is exactly the state
    // 11.300(d) is written against.
    console.error('alerts: NO ALERT DESTINATION CONFIGURED — security alerts are undelivered', JSON.stringify({
      undelivered: queue.length, critical,
      fix: 'Set the alert project and work item type under Jira settings -> Apps -> VAtlassian -> Control health'
    }));
    return { ok: false, reason: 'NO_DESTINATION', pending: queue.length, critical };
  }

  let delivered = 0;
  let failed = 0;
  for (const alert of queue) {
    try {
      const ref = await deliverToJira(alert, target, { request });
      await markDelivered(alert.alert_id, ref);
      delivered += 1;
    } catch (e) {
      // Continue after an undeliverable alert. A malformed body or deleted project
      // must not block later alerts.
      failed += 1;
      await markAttemptFailed(alert.alert_id, e?.message ?? String(e));
      console.error(`alerts: delivery failed for ${alert.dedupe_key} (attempt ${alert.attempts + 1})`, e);
    }
  }

  const summary = { ok: failed === 0, delivered, failed, batch: queue.length, ms: Date.now() - started };
  if (failed > 0) console.error('alerts:', JSON.stringify(summary));
  else console.log('alerts:', JSON.stringify(summary));
  return summary;
}

export const handler = run;
