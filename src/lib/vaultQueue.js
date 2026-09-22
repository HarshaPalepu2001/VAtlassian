import { Queue } from '@forge/events';

export const VAULT_QUEUE_KEY = 'va-vault-queue';
const vaultQueue = new Queue({ key: VAULT_QUEUE_KEY });

function bodyFor(body) {
  if (!body || typeof body !== 'object') throw new TypeError('Vault queue body is required');
  if (typeof body.baselineId !== 'string' || !body.baselineId) throw new TypeError('baselineId is required');
  if (!Number.isSafeInteger(Number(body.issueId)) || Number(body.issueId) <= 0) throw new TypeError('issueId is required');
  if (typeof body.issueKey !== 'string' || !body.issueKey) throw new TypeError('issueKey is required');
  if (!Number.isSafeInteger(Number(body.projectId)) || Number(body.projectId) <= 0) throw new TypeError('projectId is required');
  return {
    baselineId: body.baselineId,
    issueId: Number(body.issueId),
    issueKey: body.issueKey,
    projectId: Number(body.projectId)
  };
}

export function enqueueVault(body, { queue = vaultQueue } = {}) {
  const normalized = bodyFor(body);
  return queue.push({
    body: normalized,
    concurrency: { key: `vault:${normalized.issueId}`, limit: 1 }
  });
}
