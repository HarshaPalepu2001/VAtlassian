import { runAdmin, query } from './adminRuntime.js';
const ACTIVE = 'ACTIVE';
const REVOKED = 'REVOKED';

export async function getRetentionPolicy(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, retentionPolicy, describeRetention, RETENTION_DAYS_CFG, RETENTION_ACK_CFG, RETENTION_FLOOR_DAYS } = deps;
    const { accountId } = req.context;
  const res = await executeQuery(
    'SELECT cfg_key, cfg_value FROM va_config WHERE cfg_key IN (?, ?)',
    [RETENTION_DAYS_CFG, RETENTION_ACK_CFG]
  );
  if (!res.result) return { success: false, error: 'Failed to read retention policy' };
  const policy = retentionPolicy(Object.fromEntries((res.data ?? []).map((r) => [r.cfg_key, r.cfg_value])));
  return {
    success: true,
    configured: policy.configured,
    days: policy.days,
    belowFloor: policy.belowFloor,
    acknowledged: policy.acknowledged,
    prunesAnything: policy.mayPrune,
    warning: policy.warning,
    description: describeRetention(policy),
    floorDays: RETENTION_FLOOR_DAYS
  };
  }, overrides, 'retention');
}

export async function setRetentionPolicy(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { executeQuery, append, EVENT, auditStore, newId, retentionPolicy, describeRetention, RETENTION_DAYS_CFG, RETENTION_ACK_CFG, RETENTION_FLOOR_DAYS } = deps;
    const { accountId } = req.context;
  const { days = null, acknowledgeShortPeriod = false } = req.payload ?? {};
  if (days == null || days === '') {
    for (const key of [RETENTION_DAYS_CFG, RETENTION_ACK_CFG]) {
      await query(deps, 'DELETE FROM va_config WHERE cfg_key = ?', [key]);
    }
    await append(auditStore, {
      eventId: newId(), actorAccountId: accountId, eventType: EVENT.CONTROLLED_TRANSITION_CHANGED,
      payload: { change: 'RETENTION_POLICY', action: 'CLEARED', effect: 'Records retained indefinitely' }
    });
    return { success: true, description: describeRetention(retentionPolicy({})) };
  }
  const parsed = Number(days);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { success: false, error: 'Retention period must be a positive number of days, or empty to retain records indefinitely.' };
  }
  if (parsed < RETENTION_FLOOR_DAYS && acknowledgeShortPeriod !== true) {
    return {
      success: false,
      requiresAcknowledgement: true,
      error: `${parsed} days is below the ${RETENTION_FLOOR_DAYS}-day floor. GxP predicate rules are measured in years — 21 CFR 211.180, 820.180 and 312.62 all run to multiple years — so a period this short is usually an operational number entered into a legal field. Re-submit with acknowledgement if this is genuinely your predicate rule's retention period.`
    };
  }
  const now = Date.now();
  for (const [key, value] of [[RETENTION_DAYS_CFG, String(parsed)], [RETENTION_ACK_CFG, String(acknowledgeShortPeriod === true)]]) {
    const res = await executeQuery(
      `INSERT INTO va_config (cfg_key, cfg_value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
      [key, value, now, accountId]
    );
    if (!res.result) return { success: false, error: 'Failed to save retention policy' };
  }
  await append(auditStore, {
    eventId: newId(), actorAccountId: accountId, eventType: EVENT.CONTROLLED_TRANSITION_CHANGED,
    payload: {
      change: 'RETENTION_POLICY', action: 'SET', days: parsed,
      belowFloor: parsed < RETENTION_FLOOR_DAYS,
      acknowledged: acknowledgeShortPeriod === true
    }
  });
  return { success: true, description: describeRetention(retentionPolicy({ [RETENTION_DAYS_CFG]: String(parsed), [RETENTION_ACK_CFG]: String(acknowledgeShortPeriod === true) })) };
  }, overrides, 'retention');
}
