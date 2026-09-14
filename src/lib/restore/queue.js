import { Queue } from '@forge/events';

export const RESTORE_QUEUE_KEY = 'va-restore-queue';
const restoreQueue = new Queue({ key: RESTORE_QUEUE_KEY });

function bodyFor(body) {
  if (!body || typeof body !== 'object') throw new TypeError('Restore queue body is required');
  if (typeof body.restoreId !== 'string' || !body.restoreId) throw new TypeError('restoreId is required');
  if (!Number.isSafeInteger(Number(body.issueId)) || Number(body.issueId) <= 0) throw new TypeError('issueId is required');
  if (typeof body.baselineId !== 'string' || !body.baselineId) throw new TypeError('baselineId is required');
  if (!Number.isSafeInteger(Number(body.baselineVersion)) || Number(body.baselineVersion) <= 0) throw new TypeError('baselineVersion is required');
  return {
    restoreId: body.restoreId,
    issueId: Number(body.issueId),
    baselineId: body.baselineId,
    baselineVersion: Number(body.baselineVersion)
  };
}

export function enqueueRestore(body, { queue = restoreQueue } = {}) {
  const normalized = bodyFor(body);
  return queue.push({
    body: normalized,
    concurrency: { key: `restore:${normalized.issueId}`, limit: 1 }
  });
}
