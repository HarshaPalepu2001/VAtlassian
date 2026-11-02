import { listProjects } from './store.js';
import { memo } from '../lib/cache.js';
import { validAuditProof } from './governance.js';

/** Only sources enrolled by a governing record acquire the additional Done rule. */
export async function governedClosureGuard({ issue, readStatusCategory }, supplied = null) {
  const projects = supplied?.listProjects ? await supplied.listProjects() : await memo('tm:projects', listProjects);
  const project = projects.find(p => String(p.projectId) === String(issue.fields?.project?.id));
  if (!project?.enabled || [project.testTypeId, project.executionTypeId, project.planTypeId, project.setTypeId, project.preconditionTypeId]
    .filter(Boolean).map(String).includes(String(issue.fields?.issuetype?.id))) return null;
  if (String(await readStatusCategory()).toLowerCase() !== 'done') return null;
  const deps = supplied ?? await (await import('./runtime.js')).testManagementRuntime();
  const history = await deps.readGovernanceRecordsComplete(issue.id);
  if (history.complete !== true) return { error: true };
  if (!history.records.length) return null;
  const { createTestGovernance } = await import('../usecases/testGovernance.js');
  // Evaluation requires read visibility and proof; it cannot grant a human approval.
  const evaluation = await createTestGovernance(deps).evaluate({ issueKey: issue.key }, { accountId: 'system:workflow-validator' });
  return { evaluationId: evaluation.evaluationId, verdict: evaluation.verdict,
    auditConfirmed: validAuditProof(evaluation.auditProof) && evaluation.recorded !== false };
}
