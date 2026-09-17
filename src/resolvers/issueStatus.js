import { getReview } from '../db/itemStateStore.js';
import { issueControlStatus } from '../db/incidentStore.js';
import { withRequestCache } from '../lib/cache.js';

/** Forge invokes this with its issue-context payload, not a bridge request. */
export async function handler(payload) {
  return withRequestCache(() => issueStatus(payload, { getReview, issueControlStatus }));
}

export async function issueStatus(payload, deps) {
  const issueId = payload?.extension?.issue?.id;
  const projectId = payload?.extension?.project?.id;
  const issueTypeId = payload?.extension?.issue?.typeId;
  if (!/^\d+$/.test(String(issueId ?? ''))) return status('Status unavailable', 'default');
  try {
    const [review, controls] = await Promise.all([
      deps.getReview(Number(issueId)),
      deps.issueControlStatus({ issueId: Number(issueId), projectId, issueTypeId })
    ]);
    if (controls.incidents.length || controls.gateFindings.length) return status('Control alert', 'removed');
    if (review?.state === 'ERROR') return status('Review needs attention', 'removed');
    if (review?.state === 'DRIFTED' || Number(review?.drift_count) > 0) return status('Changes need review', 'moved');
    if (['DECIDING', 'RESTORING'].includes(review?.state)) return status('Review in progress', 'inprogress');
    if (review?.state === 'BASELINED') return status('Baselined', 'success');
    return status('No active baseline', 'default');
  } catch {
    return status('Status unavailable', 'default');
  }
}
function status(label, type) { return { status: { type: 'lozenge', value: { label, type } } }; }
