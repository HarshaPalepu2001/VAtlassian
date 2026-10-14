/**
 * ALERT DELIVERY — carrying a detected security event to a person.
 *
 * The reasoning for alerting at all, and for Jira being the channel, is in
 * lib/alerts.js. This is the drain on the outbox.
 *
 * EVERY FIVE MINUTES, and that number is the compliance claim. 11.300(d) asks
 * for reporting "in an immediate and urgent manner". Five minutes is the
 * tightest cadence a Forge scheduled trigger offers, so the honest statement to
 * a customer is "reported within five minutes", never "reported immediately" —
 * the same discipline as jobs/verify.js, where the interval is the bound and
 * saying otherwise would be a claim the code cannot keep.
 *
 * WHY NOT DELIVER INLINE AT THE POINT OF DETECTION. The lockout path is inside
 * a request that is already refusing a signer, and it is the one path an
 * attacker can drive at will. Creating a Jira work item there would put a
 * network call with an unbounded tail latency into a refusal, give the attacker
 * a way to make the app slow on demand, and add a failure mode where the alert
 * throwing turns a clean "wrong code" into an opaque server error — which tells
 * an attacker they found an edge and tells an honest user nothing. Detection
 * writes one local row; delivery happens here, where taking its time is free.
 *
 * AN UNCONFIGURED CHANNEL DOES NOT DROP ALERTS. If no alert project is set,
 * alerts accumulate undelivered and this job says so on every run rather than
 * discarding them. When a project is finally configured the backlog goes out in
 * order, so the record of what happened before configuration is not lost — the
 * gap is in when someone was told, not in whether it was recorded.
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
      // One undeliverable alert must not block the rest of the queue — a
      // malformed body or a since-deleted project would otherwise wedge every
      // later alert behind it forever.
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
