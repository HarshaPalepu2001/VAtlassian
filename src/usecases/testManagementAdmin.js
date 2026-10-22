/**
 * TEST MANAGEMENT ADMINISTRATION — per project: which Jira work types are
 * tests, executions and bugs, and the two sign-off chains.
 *
 * A VAtlassian administrator only. Every save is validated against Jira as it
 * is now, revision-checked, and audited; a refused save changes nothing.
 *
 * Enablement guards (spec, owner decisions 9–11):
 *   - company-managed projects only, as for the rest of VAtlassian;
 *   - the Test, Plan and Execution types are distinct and are not the bug type;
 *   - none of them may already have a work item inside a stored baseline tree,
 *     because those types are then excluded from every tree read
 *     (testmgmt/treeExclusion.js) and nothing signed may be re-read under a
 *     different rule;
 *   - every transition of the Execution workflow into a Done status carries an
 *     enabled va-gate, because the execution guard runs inside it
 *     (testmgmt/executionGuard.js) and a Done transition without it closes an
 *     execution with its runs open.
 *
 * And the reverse: a type leaves the exclusion (test management switched off,
 * or the type no longer mapped) only while none of its work items has a
 * parent. Otherwise they would return to their parents' approved trees as
 * added work items, holding those parents, and rejecting that drift would
 * delete them.
 */
import { runAdmin, query, audit } from './adminRuntime.js';
import { validateChain, DEFAULT_RUN_CHAIN, DEFAULT_VERSION_CHAIN } from '../testmgmt/chain.js';
import { ROLES } from '../lib/roles.js';
import { isOurGate, isDisabled } from '../lib/gateDrift.js';
import { verifyRunProof } from '../testmgmt/proof.js';

const validProjectId = (v) => /^\d+$/.test(String(v ?? '')) && Number(v) > 0;

async function tm(overrides) {
  if (overrides?.tm) return overrides.tm;
  const [store, jira, bugStore] = await Promise.all([import('../testmgmt/store.js'), import('../testmgmt/jira.js'), import('../testmgmt/bugStore.js')]);
  return { ...store, ...jira, ...bugStore };
}

export async function getTestManagementConfig(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { projectId } = req.payload ?? {};
    if (!validProjectId(projectId)) throw new Error('Choose a project.');
    const t = await tm(overrides);
    const [project, config, linkTypes] = await Promise.all([t.projectIssueTypes(projectId), t.readProject(projectId), t.linkTypes()]);
    const repairs = t.listProjectBugRepairs ? await t.listProjectBugRepairs(projectId) : { items: [], complete: true };
    let missing = [];
    if (config?.enabled) {
      try { missing = await doneTransitionsWithoutGate(deps, projectId, config.executionTypeId); }
      catch { missing = null; }
    }
    return {
      success: true, project, linkTypes, roles: ROLES,
      config: config ?? null,
      repairs, workflowHealth: { readable: missing !== null, missingDoneRoutes: missing ?? [] },
      defaults: { runChain: DEFAULT_RUN_CHAIN, versionChain: DEFAULT_VERSION_CHAIN, linkTypeName: 'Relates' }
    };
  }, overrides);
}

/** Which of these issue types already have a non-root node in a stored baseline tree of this project. */
async function typesInsideBaselineTrees(deps, projectId, typeIds) {
  const marks = typeIds.map(() => '?').join(', ');
  const result = await query(deps, `SELECT DISTINCT issue_type_id FROM va_baseline_node
    WHERE project_id = ? AND issue_type_id IN (${marks}) AND parent_logical_node_id IS NOT NULL`, [Number(projectId), ...typeIds]);
  return (result.data ?? []).map(r => String(r.issue_type_id));
}

/**
 * The Execution workflow's transitions into a Done-category status that carry
 * no enabled va-gate, by name, or null when the workflow or a destination
 * status could not be read. Unreadable is never "none missing".
 */
async function doneTransitionsWithoutGate(deps, projectId, executionTypeId) {
  const [workflow, statuses] = await Promise.all([
    deps.readWorkflowForPair({ projectId: String(projectId), issueTypeId: String(executionTypeId) }),
    deps.lookupStatuses()
  ]);
  if (!workflow) return null;
  const appId = deps.runtimeAppId();
  const missing = [];
  for (const transition of workflow.transitions ?? []) {
    // Creating an execution straight into Done leaves it with no runs to hold:
    // a done execution takes none (usecases/testExecution.js).
    if (transition.type === 'INITIAL') continue;
    const category = statuses.get(String(transition.toStatusReference))?.category;
    if (category == null) return null;
    if (String(category).toLowerCase() !== 'done') continue;
    const ours = (transition.validators ?? []).filter(v => isOurGate(v, { appId }));
    if (ours.length === 0 || ours.every(isDisabled)) missing.push(transition.name ?? String(transition.id));
  }
  return missing;
}

/** Mapped types the exclusion covers under this configuration. */
function excludedTypes(config) {
  return config?.enabled ? [config.testTypeId, config.executionTypeId, config.planTypeId, config.setTypeId, config.preconditionTypeId].filter(Boolean) : [];
}

export async function saveTestManagementConfig(req, overrides) {
  return runAdmin(req, async (deps) => {
    const p = req.payload ?? {};
    if (!validProjectId(p.projectId)) throw new Error('Choose a project.');
    const t = await tm(overrides);
    const [project, existing, linkTypes] = await Promise.all([t.projectIssueTypes(p.projectId), t.readProject(p.projectId), t.linkTypes()]);
    if (project.style !== 'classic') throw new Error('Test management works on company-managed projects only.');
    const typeIds = new Set(project.issueTypes.filter(type => !type.subtask).map(type => type.id));
    const pick = (value, label, required = true) => {
      const id = value == null || value === '' ? null : String(value);
      if (!id && required) throw new Error(`Choose the ${label} work type.`);
      if (id && !typeIds.has(id)) throw new Error(`The ${label} work type is not a standard work type of this project.`);
      return id;
    };
    const testTypeId = pick(p.testTypeId, 'Test');
    const executionTypeId = pick(p.executionTypeId, 'Test Execution');
    const planTypeId = pick(p.planTypeId, 'Test Plan', false);
    const setTypeId = pick(p.setTypeId, 'Test Set', false);
    const preconditionTypeId = pick(p.preconditionTypeId, 'Precondition', false);
    const defectTypeId = pick(p.defectTypeId, 'Bug');
    const managed = [testTypeId, executionTypeId, planTypeId, setTypeId, preconditionTypeId].filter(Boolean);
    if (new Set(managed).size !== managed.length) throw new Error('Test, Test Plan, Test Set, Precondition and Test Execution must be different work types.');
    if (managed.includes(defectTypeId)) throw new Error('The bug work type cannot also be a test, plan or execution type.');
    const linkTypeName = String(p.linkTypeName ?? '').trim();
    if (!linkTypes.some(l => l.name === linkTypeName)) throw new Error('Choose an existing issue link type for bug links.');
    const sourceLinkTypeId = p.sourceLinkTypeId == null || p.sourceLinkTypeId === '' ? null : String(p.sourceLinkTypeId);
    if (sourceLinkTypeId && (!/^\d+$/.test(sourceLinkTypeId) || !linkTypes.some(l => String(l.id) === sourceLinkTypeId && l.name !== linkTypeName))) {
      throw new Error('Choose an existing Verifies link type distinct from the bug link type.');
    }
    if (existing?.sourceLinkTypeId && existing.sourceLinkTypeId !== sourceLinkTypeId) {
      const linked = await query(deps, 'SELECT version_id FROM tm_source_association WHERE project_id = ? LIMIT 1', [Number(p.projectId)]);
      if (linked.data?.length) throw new Error('Signed Test versions use this Verifies type. Keep it to preserve their native Jira relationship identity.');
    }
    const runChain = validateChain(p.runChain);
    if (runChain.error) throw new Error(`Run sign-off chain: ${chainProblem(runChain.error)}`);
    const versionChain = validateChain(p.versionChain);
    if (versionChain.error) throw new Error(`Test version sign-off chain: ${chainProblem(versionChain.error)}`);
    const enabled = p.enabled === true;
    if (enabled) {
      const inside = await typesInsideBaselineTrees(deps, p.projectId, managed);
      if (inside.length) {
        const names = inside.map(id => project.issueTypes.find(type => type.id === id)?.name ?? id).join(', ');
        throw new Error(`${names} already has work items inside approved baselines in this project. Choose work types used only for test management.`);
      }
    }
    if (enabled) {
      // The automatic bug is created as a child of the test's parent and found
      // again by its marker label, so both must be settable on its create screen.
      const screen = await t.createScreenFields(p.projectId, defectTypeId);
      if (!screen.has('labels')) throw new Error('Add the Labels field to the bug work type\'s create screen: the automatic bug is found again by its label.');
      if (!screen.has('parent')) throw new Error('The bug work type cannot have a parent in this project. The automatic bug is created under the test\'s parent (the Epic).');
      const unguarded = await doneTransitionsWithoutGate(deps, p.projectId, executionTypeId);
      if (unguarded == null) throw new Error('The Test Execution workflow could not be read from Jira, so test management was not enabled. Try again.');
      if (unguarded.length) {
        throw new Error(`Attach the VAtlassian Approval validator to every transition into a Done status of the Test Execution workflow, then enable again. Missing on: ${unguarded.join(', ')}.`);
      }
    }
    const nextExcluded = enabled ? managed : [];
    for (const typeId of excludedTypes(existing).filter(id => !nextExcluded.includes(id))) {
      const parented = await t.issuesOfTypeWithParent(p.projectId, typeId);
      if (!parented.complete || parented.ids.length) {
        const name = project.issueTypes.find(type => type.id === typeId)?.name ?? typeId;
        const count = parented.complete ? String(parented.ids.length) : 'more than 500';
        throw new Error(`${count} ${name} work items in this project sit under a parent. Switching test management off for ${name} would put them back into their parents' approved trees as added work items, holding those parents. Keep the mapping, or move those work items out from under their parents first.`);
      }
    }
    const next ={ projectId: String(p.projectId), enabled, testTypeId, executionTypeId, planTypeId, setTypeId, preconditionTypeId, defectTypeId,
      linkTypeName, sourceLinkTypeId, runChain: runChain.chain, versionChain: versionChain.chain };
    const saved = await t.saveProject(next, { expectedRevision: existing ? Number(p.expectedRevision) : 0,
      now: Date.now(), actor: req.context.accountId });
    if (!saved) throw new Error('Someone else changed this configuration since you opened it. Reload and try again.');
    await audit(deps, req.context.accountId, 'TM_PROJECT_CONFIGURED', { ...next, previousRevision: existing?.revision ?? 0 });
    return { success: true, config: await t.readProject(p.projectId) };
  }, overrides);
}

/**
 * NEEDS_REPAIR is an administrator's decision: link the bug that is the right
 * one, after checking it exists. Audited with the reason.
 */
export async function repairTestBug(req, overrides) {
  return runAdmin(req, async (deps) => {
    const { runId, bugKey, reason } = req.payload ?? {};
    if (!/^[0-9a-f]{32}$/.test(String(runId ?? ''))) throw new Error('Unknown run.');
    if (!String(reason ?? '').trim()) throw new Error('Give a reason for the repair.');
    const t = await tm(overrides);
    const bug = await t.readBug(runId);
    if (!bug || bug.state !== 'NEEDS_REPAIR') throw new Error('This run has no bug waiting for repair.');
    if (req.payload?.projectId != null && String(req.payload.projectId) !== String(bug.projectId)) throw new Error('The run belongs to a different project.');
    const run = await t.readRun(runId);
    if (!run || run.state !== 'SIGNED' || run.result !== 'FAILED' || String(run.projectId) !== String(bug.projectId)) {
      throw new Error('Only a fully signed failed run can have its automatic bug repaired.');
    }
    if (!(await verifyRunProof(run, await t.readVersion(run.testVersionId), t)).ok) {
      throw new Error('This failed run has incomplete or invalid audit-confirmed sign-off proof. Investigate its signatures before repairing the bug.');
    }
    const config = await t.readProject(bug.projectId);
    if (!config?.enabled) throw new Error('Test management must be enabled for this project.');
    const [issue, test, execution] = await Promise.all([
      t.readIssueAsUser(String(bugKey ?? '').trim()), t.readIssueAsUser(run.testIssueId), t.readIssueAsUser(run.executionIssueId)
    ]);
    if ([issue, test, execution].some(i => String(i?.fields?.project?.id) !== String(bug.projectId))) throw new Error('The bug, test and execution must be in the same project.');
    if (String(issue?.fields?.issuetype?.id) !== String(config.defectTypeId)) throw new Error('Choose a work item of the mapped Bug work type.');
    if (String(test?.fields?.issuetype?.id) !== String(config.testTypeId) || String(execution?.fields?.issuetype?.id) !== String(config.executionTypeId)) {
      throw new Error('The run\'s test or execution no longer has its mapped work type.');
    }
    const parent = test?.fields?.parent?.id;
    if (!parent || String(issue?.fields?.parent?.id) !== String(parent) || String(bug.parentIssueId) !== String(parent)) {
      throw new Error('The bug must have the test\'s expected current parent. Investigate any parent change before repairing.');
    }
    if (bug.issueId && String(bug.issueId) !== String(issue.id)) throw new Error('This run already identifies a different bug. Investigate that issue before repairing.');
    const governed = await query(deps, 'SELECT current_issue_id FROM va_baseline_node WHERE current_issue_id = ? OR original_issue_id = ? LIMIT 1',
      [Number(issue.id), Number(issue.id)]);
    if (governed.data?.length) throw new Error('This work item already belongs to a stored baseline and cannot acquire a test-management tree exemption.');
    const associated = await t.readBugByIssue(issue.id);
    if (associated && associated.runId !== runId) throw new Error('This bug is already assigned to another run.');
    if (!await t.claimBugIssue({ runId, issueId: issue.id, now: Date.now() })) throw new Error('This bug is already assigned to another run, or this run has a different reserved bug.');
    try {
      for (const outwardId of [run.testIssueId, run.executionIssueId]) {
        await (t.ensureIssueLinkAsApp ?? t.linkIssueAsApp)({ typeName: config.linkTypeName, inwardId: String(issue.id), outwardId: String(outwardId) });
      }
    } catch { throw new Error('The required test and execution links could not be created. Repair remains open; try again after fixing the Jira link permission.'); }
    // The audit must be durable before this repair can release the execution guard.
    await audit(deps, req.context.accountId, 'TM_BUG_REPAIRED', { runId, bugKey: issue.key, reason: String(reason).trim() });
    const ok = await t.updateBug(runId, { from: 'NEEDS_REPAIR', state: 'CREATED', issueId: issue.id, issueKey: issue.key,
      lastError: null, now: Date.now() });
    if (!ok) throw new Error('The bug changed since you opened it. Reload and try again.');
    return { success: true };
  }, overrides);
}

function chainProblem(code) {
  return ({ CHAIN_EMPTY: 'add at least one step.', CHAIN_TOO_LONG: 'at most six steps.',
    CHAIN_ROLE_INVALID: 'every step needs a role.', CHAIN_LABEL_INVALID: 'every step needs a short label.',
    CHAIN_MEANING_INVALID: 'every step needs the statement the signer attests to.' })[code] ?? 'invalid.';
}
