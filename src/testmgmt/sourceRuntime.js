import { createTestSources, sourceBaseline, sourceStateFromReadback } from './sources.js';
import { createReportStore } from './reportStore.js';
import { passingRetestProblem, proofOkay } from './coverage.js';
import { hydrateLinkPolicyIssue, resolveNewLinkPolicy } from '../lib/linkPolicy.js';

/** One production source-state path, with its read boundaries injectable for regressions. */
export function createSourceStateReader(deps) {
  return async function getSourceState(issue, { viewer } = {}) {
    const issueId = Number(issue.id), projectId = Number(issue.fields.project.id), issueTypeId = String(issue.fields.issuetype.id);
    const [baseline, review] = await Promise.all([deps.activeBaseline(issueId), deps.getReview(issueId)]);
    if (!baseline) {
      const linkPolicy = await (deps.resolveLinkPolicy ?? resolveNewLinkPolicy)(issue);
      const hydrated = await hydrateLinkPolicyIssue(issue, linkPolicy, id => deps.readPolicyEndpoint(id, viewer));
      return sourceStateFromReadback({ issue: hydrated, baseline, linkPolicy });
    }
    // Existing native baselines retain their stored policy through baselineDrift.
    const scope = await deps.fieldScope({ issueId, projectId, issueTypeId });
    const comparison = await deps.baselineDrift({ baseline, issueId, issueFields: issue.fields, declared: scope.fields });
    let tree = null;
    if (baseline.tree_hash || baseline.captured_by_baseline_id) {
      const snapshot = await deps.snapshot({ issue, actor: viewer, includeChangelog: false });
      if ((snapshot.tree?.nodes?.length ?? 0) > 1000) throw new Error('Source tree exceeds the complete read limit');
      for (const node of snapshot.tree?.nodes ?? []) await deps.readVisibleTreeNode(String(node.id), viewer);
      tree = { complete: !!snapshot.baselineTree && !!snapshot.treeDiff && !!snapshot.currentTree && !!snapshot.treeHash,
        baselineId: sourceBaseline(snapshot.baseline)?.id, contentHash: snapshot.contentHash, driftCount: snapshot.driftCount };
    }
    return sourceStateFromReadback({ issue, baseline, review, comparison, tree });
  };
}

/** Production boundary, installed by the shared runtime after its signing/evidence adapters. */
export async function sourceReportingRuntime(baseDeps) {
  const [{ default: api, route }, baselineStore, itemState, treeStore, configStore, nodeFields, liveDrift, attachmentIdentity] = await Promise.all([
    import('@forge/api'), import('../db/baselineStore.js'), import('../db/itemStateStore.js'), import('../db/baselineTreeStore.js'),
    import('../db/configStore.js'), import('../lib/tree/nodeFields.js'), import('../lib/liveDrift.js'), import('../lib/attachmentIdentity.js')
  ]);
  const forge = api?.asUser ? api : api.default;
  async function jira(path) {
    const response = await forge.asUser().requestJira(path);
    if (!response?.ok) throw Object.assign(new Error('A record is unavailable.'), { reason: 'NOT_FOUND' });
    return response.json();
  }
  let sitePromise;
  const siteIdentity = baseDeps.siteIdentity ?? (() => {
    sitePromise ??= jira(route`/rest/api/3/serverInfo`).then(info => {
      if (!info?.baseUrl) throw new Error('Site identity unavailable');
      return String(info.baseUrl).replace(/\/$/, '').toLowerCase();
    });
    return sitePromise;
  });
  const fullIssueAsUser = async issueId => attachmentIdentity.canonicaliseIssue(await jira(route`/rest/api/3/issue/${issueId}?fields=*all`));
  const getSourceState = createSourceStateReader({ activeBaseline: baselineStore.activeBaseline, getReview: itemState.getReview,
    readPolicyEndpoint: (id, viewer) => baseDeps.readIssueAsUser(id, viewer),
    fieldScope: input => nodeFields.fieldScope(input, { activeRootsForNode: treeStore.activeRootsForNode, controlledFields: configStore.controlledFields }),
    baselineDrift: input => liveDrift.baselineDrift({ ...input, readRootDigests: treeStore.rootNodeDigests }),
    snapshot: args => import('../usecases/panelAccess.js').then(access => access.snapshot(args)),
    readVisibleTreeNode: fullIssueAsUser
  });
  const reportStore = createReportStore();
  const deps = { ...reportStore, ...baseDeps, siteIdentity, getSourceState };
  const sources = createTestSources({ ...deps, readIssueAsUser: fullIssueAsUser });
  async function readBlockingDefects({ testIssueId, projectId, runId }, viewer) {
    const list = await deps.readDefectsForTestComplete(testIssueId);
    if (!list.complete) return { ok: false, blocking: true };
    const priorFailures = [];
    for (const bug of list.records) {
      if (String(bug.projectId) !== String(projectId) || bug.state !== 'CREATED' || !bug.issueId) return { ok: false, blocking: true };
      try {
        const issue = await fullIssueAsUser(bug.issueId, viewer);
        if (String(issue.fields?.project?.id) !== String(projectId)) return { ok: false, blocking: true };
        // The existing defect model has no signed waiver/nonblocking flag: unresolved app defects conservatively block.
        if (!issue.fields?.resolution && issue.fields?.status?.statusCategory?.key !== 'done') return { ok: true, blocking: true };
        const failed = await deps.readRun(bug.runId);
        if (!failed || failed.testIssueId !== String(testIssueId) || failed.projectId !== String(projectId)) return { ok: false, blocking: true };
        const version = await deps.readVersion(failed.testVersionId);
        if (!proofOkay(await deps.verifyRunProof(failed, version))) return { ok: false, blocking: true };
        if (failed.state === 'SIGNED' && failed.result === 'FAILED') priorFailures.push(failed);
      } catch { return { ok: false, blocking: true }; }
    }
    const selected = await deps.readRun(runId);
    if (!selected) return { ok: false, blocking: true };
    const retest = await passingRetestProblem({ run: selected, priorFailures }, {
      readRun: deps.readRun,
      verifyAncestorProof: async run => {
        const execution = await baseDeps.readIssueAsUser(run.executionIssueId, viewer);
        if (String(execution.fields?.project?.id) !== String(projectId)) return false;
        return deps.verifyRunProof(run, await deps.readVersion(run.testVersionId));
      }
    });
    return retest === 'RETEST_PROVENANCE_UNAVAILABLE' ? { ok: false, blocking: false, retestValid: false }
      : { ok: true, blocking: false, retestValid: !retest };
  }
  const { sourceLinkRuntime } = await import('./sourceLinkRuntime.js');
  return sourceLinkRuntime({ ...deps, ...sources, readBlockingDefects, getFullIssueAsUser: fullIssueAsUser });
}
