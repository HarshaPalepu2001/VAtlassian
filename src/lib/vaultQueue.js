import { Queue } from '@forge/events';

export const VAULT_QUEUE_KEY = 'va-vault-queue';
const vaultQueue = new Queue({ key: VAULT_QUEUE_KEY });

function bodyFor(body) {
  if (!body || typeof body !== 'object') throw new TypeError('Vault queue body is required');
  if (typeof body.baselineId !== 'string' || !body.baselineId) throw new TypeError('baselineId is required');
  if (!Number.isSafeInteger(Number(body.issueId)) || Number(body.issueId) <= 0) throw new TypeError('issueId is required');
  if (typeof body.issueKey !== 'string' || !body.issueKey) throw new TypeError('issueKey is required');
  if (!Number.isSafeInteger(Number(body.projectId)) || Number(body.projectId) <= 0) throw new TypeError('projectId is required');
  const out = {
    baselineId: body.baselineId,
    issueId: Number(body.issueId),
    issueKey: body.issueKey,
    projectId: Number(body.projectId)
  };
  // The files the baseline recorded, when it tracks attachments: the vault
  // copies exactly these. Absent, the worker copies what is on the issue.
  if (Array.isArray(body.attachments)) {
    out.attachments = body.attachments.map(a => ({
      id: String(a?.id ?? ''), jiraId: String(a?.jiraId ?? a?.id ?? ''), filename: String(a?.filename ?? '')
    }));
    if (out.attachments.some(a => !a.id || !a.jiraId)) throw new TypeError('every recorded attachment needs an id');
  }
  return out;
}

export function enqueueVault(body, { queue = vaultQueue } = {}) {
  const normalized = bodyFor(body);
  return queue.push({
    body: normalized,
    concurrency: { key: `vault:${normalized.issueId}`, limit: 1 }
  });
}

/** Forge accepts at most this many events in one push. */
const PUSH_LIMIT = 50;

/**
 * Many jobs at once — one per baseline a capture wrote, which for a parent is
 * one per child as well. Pushed in batches, so a 500-node tree costs ten
 * requests, not five hundred, inside the approval's time budget. Never throws:
 * returns the jobs that were not queued, each with its error, for the caller
 * to audit. A job Forge reports as failed within an otherwise accepted batch
 * is reported alone; if the batch as a whole failed, all of it is.
 */
export async function enqueueVaultJobs(bodies, { queue = vaultQueue } = {}) {
  const failed = [];
  const events = [];
  for (const body of bodies ?? []) {
    try {
      const normalized = bodyFor(body);
      events.push({ body: normalized, concurrency: { key: `vault:${normalized.issueId}`, limit: 1 } });
    } catch (error) {
      failed.push({ body, error });
    }
  }
  for (let start = 0; start < events.length; start += PUSH_LIMIT) {
    const batch = events.slice(start, start + PUSH_LIMIT);
    try {
      await queue.push(batch);
    } catch (error) {
      const named = (error?.failedEvents ?? [])
        .map(entry => entry?.payload?.body ?? entry?.payload)
        .filter(body => body?.baselineId);
      const lost = named.length
        ? batch.filter(event => named.some(body => body.baselineId === event.body.baselineId))
        : batch;
      for (const event of lost) failed.push({ body: event.body, error });
    }
  }
  return { failed };
}
