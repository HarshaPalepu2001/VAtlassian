import { tmFail } from './messages.js';

export const MACHINE_REVIEW_MEANING = 'I reviewed these machine-recorded results and their evidence.';
export const machineRecorded = run => run.evidenceSchema === 2 && run.provenance?.kind === 'MACHINE';

/** A receipt can reserve runs before their physical result rows have changed. */
export async function assertRunReady(run, deps) {
  if (deps.assertIntakeReady) return deps.assertIntakeReady(run, deps);
  if (run.intakeReceiptId || machineRecorded(run)) tmFail('INTAKE_PENDING');
}

export function reviewStep(run, step) {
  return machineRecorded(run) ? { ...step, label: 'Machine results reviewed by', meaning: MACHINE_REVIEW_MEANING } : step;
}

export function humanRunMetadata({ classification = null, reportedBuild = null }, actor) {
  if (classification !== null && (typeof classification !== 'object' || Array.isArray(classification) ||
      !['level', 'method'].every(key => typeof classification[key] === 'string' && classification[key].trim() && classification[key].length <= 128))) tmFail('INVALID_INPUT');
  if (reportedBuild !== null && (typeof reportedBuild !== 'object' || Array.isArray(reportedBuild) ||
      !Object.keys(reportedBuild).length || Object.keys(reportedBuild).length > 20 ||
      Object.entries(reportedBuild).some(([key, value]) => !key || key.length > 64 || typeof value !== 'string' || !value.trim() || value.length > 2048))) tmFail('INVALID_INPUT');
  return { evidenceSchema: 2, classification: classification ? { level: classification.level.trim(), method: classification.method.trim() } : null,
    reportedBuild, provenance: { kind: 'HUMAN', accountId: actor.accountId }, intakeReceiptId: null };
}
