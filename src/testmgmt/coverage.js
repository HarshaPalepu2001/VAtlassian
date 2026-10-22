import { contentDigest } from './content.js';
import { sourceBaseline } from './sources.js';

export const TERMINAL_COVERAGE_STATES = new Set(['SIGNED', 'REJECTED', 'NOT_EXECUTED']);
export const flattenedEvidence = run => [...(run.steps ?? []), ...(run.iterations ?? []).flatMap(i => i.steps ?? [])].flatMap(step => step.evidence ?? []);
export const proofOkay = result => result === true || result?.ok === true;
export const contextKey = run => JSON.stringify([String(run.testIssueId), run.configuration ?? '', run.release?.id ?? null, run.environment ?? '']);

/** A newer rejected or deliberately unexecuted attempt stays selected even if an older pass exists. */
export function latestTerminalRuns(runs) {
  const byContext = new Map();
  for (const run of runs ?? []) {
    if (!TERMINAL_COVERAGE_STATES.has(run.state)) continue;
    const key = contextKey(run), prior = byContext.get(key);
    if (!prior || Number(run.createdAt) > Number(prior.createdAt) || (Number(run.createdAt) === Number(prior.createdAt) && String(run.runId) > String(prior.runId))) byContext.set(key, run);
  }
  return [...byContext.values()].sort((a, b) => contextKey(a).localeCompare(contextKey(b)));
}

export function sourceChange(pinned, current) {
  if (!pinned?.siteId || !pinned?.projectId || !pinned?.sourceDigest) return 'SOURCE_NOT_PINNED';
  if (!current || current.issueId !== pinned.issueId || current.siteId !== pinned.siteId || current.projectId !== pinned.projectId) return 'SOURCE_UNAVAILABLE';
  if ((current.linkTypeId ?? null) !== (pinned.linkTypeId ?? null)) return 'SOURCE_CHANGED';
  if (current.drifted) return 'SOURCE_DRIFT';
  if (current.sourceDigest !== pinned.sourceDigest || contentDigest(sourceBaseline(current.baseline)) !== contentDigest(sourceBaseline(pinned.baseline))) return 'SOURCE_CHANGED';
  return null;
}

export function hasPlanningSnapshot(run) {
  return !!(run.planSnapshot || run.planningSnapshot || run.planRevisionId || run.datasetSnapshot || run.datasetDigest || run.planDigest);
}

/** A later unrelated pass cannot discharge a closed failure; the immutable retest chain supplies the provenance. */
export async function passingRetestProblem({ run, priorFailures }, deps) {
  if (run.state !== 'SIGNED' || !['PASSED', 'PARTLY_PASSED'].includes(run.result)) return null;
  const failures = priorFailures.filter(failed => contextKey(failed) === contextKey(run) && failed.runId !== run.runId && Number(failed.createdAt) <= Number(run.createdAt));
  const ancestors = new Set();
  let parentId = run.retestOf, child = run;
  while (parentId) {
    if (ancestors.has(parentId) || ancestors.size >= 1000) return 'RETEST_PROVENANCE_UNAVAILABLE';
    let parent;
    try {
      parent = await deps.readRun(parentId);
      if (!parent || parent.runId !== parentId || contextKey(parent) !== contextKey(run) || parent.projectId !== run.projectId ||
          Number(parent.createdAt) > Number(child.createdAt) || !proofOkay(await deps.verifyAncestorProof(parent))) return 'RETEST_PROVENANCE_UNAVAILABLE';
    } catch { return 'RETEST_PROVENANCE_UNAVAILABLE'; }
    ancestors.add(parentId); child = parent; parentId = parent.retestOf;
  }
  return failures.some(failed => !ancestors.has(failed.runId)) ? 'PASSING_RETEST_REQUIRED' : null;
}

/** Every failure is explicit. These checks cannot make an unavailable proof look like an empty list. */
export async function inspectRunProof(run, version, deps, viewer) {
  const problems = [];
  if (!version || version.state !== 'SIGNED' || version.digest !== run.testDigest || contentDigest(version.content) !== version.digest ||
      version.versionId !== run.testVersionId || String(version.testIssueId) !== String(run.testIssueId) || String(version.projectId) !== String(run.projectId)) problems.push('TEST_VERSION_UNVERIFIABLE');
  try { if (!deps.verifyRunProof || !proofOkay(await deps.verifyRunProof(run, version))) problems.push('SIGNATURE_PROOF_INCOMPLETE'); }
  catch { problems.push('SIGNATURE_PROOF_INCOMPLETE'); }
  try { if (!deps.verifyEvidence || !proofOkay(await deps.verifyEvidence(flattenedEvidence(run), { run, viewer }))) problems.push('EVIDENCE_UNAVAILABLE'); }
  catch { problems.push('EVIDENCE_UNAVAILABLE'); }
  try {
    if (deps.validateRunPlanningSnapshot) {
      const planning = await deps.validateRunPlanningSnapshot(run, version, { viewer });
      if (!proofOkay(planning) || planning?.current === false) problems.push(planning?.reason ?? 'PLANNING_SNAPSHOT_CHANGED');
    } else if (hasPlanningSnapshot(run)) problems.push('PLANNING_PROOF_UNAVAILABLE');
  } catch { problems.push('PLANNING_PROOF_UNAVAILABLE'); }
  try {
    const defects = deps.readBlockingDefects ? await deps.readBlockingDefects({ testIssueId: run.testIssueId, projectId: run.projectId, runId: run.runId }, viewer) : null;
    if (!proofOkay(defects)) problems.push('DEFECT_STATUS_UNAVAILABLE');
    else if (defects.blocking) problems.push('UNRESOLVED_BLOCKING_DEFECT');
    else if (defects.retestValid === false) problems.push('PASSING_RETEST_REQUIRED');
  } catch { problems.push('DEFECT_STATUS_UNAVAILABLE'); }
  return problems;
}
