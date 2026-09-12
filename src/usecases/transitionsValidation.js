import { isAssuranceLevel } from '../lib/approval/levels.js';
import { validScope } from './adminRuntime.js';

export function transitionInput(payload = {}) {
  const { projectId, issueTypeId, fromStatusId, toStatusId, requiredRole, meaning } = payload;
  if (!validScope(projectId, issueTypeId) || !/^(\d+|\*)$/.test(String(fromStatusId ?? '')) ||
      !/^\d+$/.test(String(toStatusId ?? ''))) throw new Error('A project, issue type and valid status edge are required.');
  if (![requiredRole, meaning].every(s => typeof s === 'string' && s.trim() === s && s.length > 0 && s.length <= 32)) {
    throw new Error('Role and meaning must be nonempty text of at most 32 characters, without surrounding spaces.');
  }
  const requiredAssurance = payload.requiredAssurance ?? payload.required_assurance ?? 'ESIGNATURE';
  if (!isAssuranceLevel(requiredAssurance)) throw new Error('Unknown required assurance level.');
  const flags = {};
  for (const [camel, snake, fallback] of [['captureBaseline', 'capture_baseline', true],
    ['blockOnDrift', 'block_on_drift', true], ['requireDecision', 'require_decision', false]]) {
    const value = payload[camel] ?? payload[snake] ?? fallback;
    if (typeof value !== 'boolean') throw new Error(`${camel} must be a boolean.`);
    flags[camel] = value;
  }
  const rejectToStatusId = payload.rejectToStatusId || null;
  if (rejectToStatusId !== null && !/^\d+$/.test(String(rejectToStatusId))) throw new Error('Invalid rejection status id.');
  // The exact Jira transition, not a guess at one. Two workflow transitions can
  // share a destination status, and a rule saved without picking the precise
  // one cannot be enforced without risking a sibling edge borrowing it — see
  // gatedTransition() in db/configStore.js.
  if (!/^\d+$/.test(String(payload.transitionId ?? ''))) throw new Error('An exact Jira transition is required.');
  const transitionId = String(payload.transitionId);
  return { projectId: String(projectId), issueTypeId: String(issueTypeId), fromStatusId: String(fromStatusId),
    toStatusId: String(toStatusId), requiredRole, meaning, rejectToStatusId, transitionId, requiredAssurance, ...flags };
}
