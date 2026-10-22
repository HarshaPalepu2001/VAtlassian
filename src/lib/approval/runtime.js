import { FailClosed } from '../errors.js';
import { ELIGIBILITY_PREDICATE, eligibilityParams } from '../eligibility.js';
import { project } from '../content.js';
import { scopeFromIssue } from '../trackedFields.js';
import { baselinePolicy } from '../baselinePolicy.js';
import { baselineDecisionMeaning } from './challenge.js';
import { availableTransitions, exactAvailableTransition, applyTransition } from '../transitions.js';
import { readStableTree } from '../tree/stableRead.js';
import { readTreeWithNodeFields, scopeForItem } from '../tree/nodeFields.js';
import { planTreeCapture } from '../tree/capturePlan.js';
import { createTreeReader } from '../tree/jira.js';
import { testManagementExclusion, testManagementRole } from '../../testmgmt/treeExclusion.js';
import { executionGuard } from '../../testmgmt/executionGuard.js';
import { baselineLinkPolicy, hydrateLinkPolicyIssue, hydrateLinkPolicyNodes } from '../linkPolicy.js';

/** A status's category key ('new', 'indeterminate', 'done'). Read as the app: categories are not secret. */
async function statusCategory(api, route, statusId) {
  const response = await api.asApp().requestJira(route`/rest/api/3/status/${statusId}`);
  if (!response?.ok) throw new FailClosed('SERVICE_UNAVAILABLE');
  return (await response.json())?.statusCategory?.key ?? null;
}
import { baselineDrift, logLiveDrift } from '../liveDrift.js';
import { linkDecisionsPending } from '../../db/linkPendingStore.js';
import { canonicaliseIssue } from '../attachmentIdentity.js';
import { hashBasis } from '../hashBasis.js';
import { driftedAncestor, ownDrift } from '../ancestorHold.js';

export async function approvalContentHash({ issue, declared, modifiedFields = {}, activeBaseline, readTree, linkPolicy = null, readIssue }) {
  const { fields } = scopeFromIssue({ declared, issueFields: issue.fields, editmetaFields: {} });
  // A child baseline captured by its parent has no tree_hash of its own, but
  // its panel signs the child's recursive subtree (panelAccess.snapshot).
  if (!activeBaseline?.tree_hash && !activeBaseline?.captured_by_baseline_id) {
    const hydrated = await hydrateLinkPolicyIssue({ ...issue, fields: { ...issue.fields, ...modifiedFields } }, linkPolicy, readIssue);
    return { fields, mode: 'flat', contentHash: project(hydrated.fields, fields, { issue: hydrated, linkPolicy }).contentHash };
  }
  if (typeof readTree !== 'function') throw new FailClosed('SERVICE_UNAVAILABLE');
  const rootIssueId = issue.issueId ?? issue.id;
  // Every node over the root's fields, as the panel's evidence and the
  // capture compute it (lib/tree/nodeFields.js), or no signature would match.
  const stable = await readTreeWithNodeFields({ readStableTree, readTree, rootIssueKey: issue.issueKey ?? issue.key,
    rootFields: fields });
  const nodes = await hydrateLinkPolicyNodes(stable.tree.nodes.map(node => String(node.id) === String(rootIssueId)
    ? { ...node, fields: { ...issue.fields, ...node.fields, ...modifiedFields } }
    : node), () => linkPolicy, readIssue);
  return { fields, mode: 'tree', contentHash: planTreeCapture({ rootIssueId, nodes, controlledFields: fields,
    fieldsFor: stable.fieldsFor, linkPolicy }).treeHash };
}

async function shared() {
  const [forge, db, ledger, store, approvals, config, baselines] = await Promise.all([
    import('@forge/api'), import('../db.js'), import('../ledger.js'), import('../../db/store.js'),
    import('../../db/approvalStore.js'), import('../../db/configStore.js'), import('../../db/baselineStore.js')
  ]);
  const api = forge.default?.asUser ? forge.default : forge;
  const query = async (sql, params) => {
    const result = await db.executeQuery(sql, params);
    if (!result.result) throw new FailClosed('SERVICE_UNAVAILABLE');
    return result.data;
  };
  const audit = (event, options) => ledger.append(store.auditStore, { eventId: store.newId(), ...event }, options);
  const eligible = async (scope) => (await query(`SELECT 1 AS ok FROM va_eligibility WHERE ${ELIGIBILITY_PREDICATE} LIMIT 1`, eligibilityParams({ ...scope, state: 'ACTIVE' }))).length > 0;
  return { api, route: forge.route, query, audit, eligible, approvals, config, baselines };
}
function describeIssue(issue) {
  return { ...issue, issueId: Number(issue.id), issueKey: issue.key, projectId: Number(issue.fields.project.id),
    issueTypeId: String(issue.fields.issuetype.id), statusId: String(issue.fields.status.id) };
}
/**
 * The validator's own read of a work item, and what lib/ancestorHold.js needs
 * to judge the items above it the same way. As the user first; as the app
 * only where Forge cannot act as this user (see readAsUserOrApp). A 404 or
 * 5xx still fails closed.
 */
function liveReads({ api, route, config, baselines, rootNodeDigests, activeRootsForNode }) {
  const readIssue = async key => {
    const issuePath = route`/rest/api/3/issue/${key}?fields=*all`;
    const response = await readAsUserOrApp(() => api.asUser().requestJira(issuePath),
      () => api.asApp().requestJira(issuePath)).catch(() => { throw new FailClosed('SERVICE_UNAVAILABLE'); });
    if (!response?.ok) throw new FailClosed('SERVICE_UNAVAILABLE');
    return canonicaliseIssue(await response.json());
  };
  const ancestorDeps = { readIssue, projectConfig: config.projectConfig, activeBaseline: baselines.activeBaseline,
    activeRootsForNode, controlledFields: config.controlledFields, rootNodeDigests,
    exempt: async issue => !!(await testManagementRole(issue)) };
  return { readIssue, ancestorDeps };
}

export async function approvalRuntime() {
  const { api, route, audit, eligible, approvals, config, baselines } = await shared();
  const [{ readableIssue }, drift, trees] = await Promise.all([import('../../usecases/panelAccess.js'),
    import('../../usecases/drift.js'), import('../../db/baselineTreeStore.js')]);
  const { ancestorDeps } = liveReads({ api, route, config, baselines,
    rootNodeDigests: trees.rootNodeDigests, activeRootsForNode: trees.activeRootsForNode });
  return {
    now: Date.now, audit, eligible,
    // Signing a transition the validator will refuse spends an authentication
    // for nothing: a work item held from above is refused before the challenge.
    ancestorDrift: issue => driftedAncestor(issue, ancestorDeps, { surface: 'signing-ancestor' }),
    // The item's OWN drift, as the validator holds it: a change below a parent
    // asks it for a decision but never holds its transitions.
    ownDriftCount: async issue => (await ownDrift(issue, ancestorDeps, 'signing-own')).length,
    issue: async args => describeIssue(await readableIssue(args)),
    actor: async accountId => {
      const response = await api.asUser().requestJira(route`/rest/api/3/myself`);
      if (!response.ok) throw new FailClosed('NOT_ELIGIBLE');
      const user = await response.json();
      if (user.accountId !== accountId || user.active === false || !user.displayName) throw new FailClosed('NOT_ELIGIBLE');
      return { accountId, displayName: user.displayName };
    },
    transition: async (issue, payload) => {
      const transitions = await availableTransitions(api, issue.issueKey).catch(() => {
        throw new FailClosed('SERVICE_UNAVAILABLE');
      });
      const exact = exactAvailableTransition(transitions, payload);
      if (!exact) throw new FailClosed('TRANSITION_UNAVAILABLE');
      return { id: exact.id, toStatusId: exact.toStatusId };
    },
    edge: (issue, transition, prepared) => transition ? config.gatedTransition({ projectId: issue.projectId,
      issueTypeId: issue.issueTypeId, fromStatusId: issue.statusId, toStatusId: transition.toStatusId,
      transitionId: transition.id }) : prepared.gate,
    prepare: drift.prepareApproval, apply: drift.applyApproval,
    record: approvals.recordApproval, activate: approvals.activateApproval,
    invalidate: approvals.invalidateApproval, byId: approvals.approvalById,
    performTransition: async (issue, transition, row) => {
      const response = await applyTransition(api, { issueKey: issue.issueKey, transitionId: transition.id });
      if (!response.ok) {
        const detail = [...(response.messages ?? []), ...Object.values(response.errors ?? {})]
          .filter(Boolean).join(' ');
        return { transitioned: false, transitionError: detail
          ? `Approval recorded. Jira refused the transition: ${detail}`
          : 'Approval recorded. Jira refused the transition. Refresh the work item before signing again.' };
      }
      await audit({ eventType: 'TRANSITION_COMPLETED', actorAccountId: row.account_id, issueId: issue.issueId,
        approvalId: row.approval_id, payload: { transitionId: transition.id, toStatusId: transition.toStatusId } });
      return { transitioned: true };
    }
  };
}

/**
 * Which exact Jira transition is running, and does VAtlassian control it?
 *
 * Returns `edgeFailure` rather than throwing: the validator must still be able
 * to refuse a drifted item for its drift, whatever is wrong with the edge.
 */
export async function resolveEdge({ gated, signedTransitionId, transitions },
  { toStatusId, transitionId, approvalId, configuredTransitionId = null }) {
  let id = transitionId == null ? null : String(transitionId);
  if (!id && approvalId) {
    const signed = await signedTransitionId();
    if (signed != null) id = String(signed);
  }
  if (id) return { transitionId: id, ct: await gated(id), edgeFailure: null };

  let available;
  try { available = await transitions(); }
  catch { return { transitionId: null, ct: null, edgeFailure: 'SERVICE_UNAVAILABLE' }; }
  const matches = available.filter(candidate => candidate.isAvailable !== false
    && String(candidate.toStatusId) === String(toStatusId));
  if (matches.length === 0) return { transitionId: null, ct: null, edgeFailure: 'NOT_CONFIGURED' };
  // The id the validator's setup screen recorded for the transition it is
  // attached to. Jira's payload never carries one, so this is what tells
  // siblings into the same status apart. It is trusted only while it names one
  // of the transitions actually available into this status right now; a stale
  // id (a transition since replaced, or one saved before its workflow was
  // published) falls through to the resolution below, exactly as before. The
  // Health check reports a configured id that differs from its transition.
  if (configuredTransitionId != null) {
    const configured = matches.find(candidate => String(candidate.id) === String(configuredTransitionId));
    if (configured) return { transitionId: String(configured.id), ct: await gated(String(configured.id)), edgeFailure: null };
  }
  if (matches.length === 1) {
    id = String(matches[0].id);
    return { transitionId: id, ct: await gated(id), edgeFailure: null };
  }
  // Sibling transitions share this destination and Jira's validator payload
  // does not say which one is running. When none of them is controlled it does
  // not matter which: each carries only the drift hold, which has already
  // passed. When any one is, a signature could be spent on the wrong sibling,
  // so the edge fails closed.
  const rules = await Promise.all(matches.map(candidate => gated(String(candidate.id))));
  return { transitionId: null, ct: null,
    edgeFailure: rules.every(rule => rule == null) ? null : 'SERVICE_UNAVAILABLE' };
}

/**
 * Read as the user; where Forge cannot act as this user, read as the app.
 *
 * The validator is attached to every transition of a governed workflow, so it
 * runs for every Jira user and every automation rule — most of whom have never
 * opened VAtlassian and never granted it consent to act as them. Forge then
 * throws (NeedsAuthenticationError) or Jira answers 401/403. Refusing on that
 * would freeze the whole workflow for them, clean items included, although the
 * drift hold needs only facts the app can read as itself: the issue and its
 * transitions.
 *
 * Only "could not act as this user" falls back. Any other answer — a 404, a
 * 5xx, a list read that failed with such a status — is returned or rethrown
 * exactly as the user read gave it, and the caller fails closed as before.
 * `availableTransitions` reports a non-ok status only in its message, as
 * "(status N)", so that is where the status is read from.
 */
const NOT_THIS_USER = new Set([401, 403]);
export async function readAsUserOrApp(asUser, asApp) {
  try {
    const result = await asUser();
    if (!NOT_THIS_USER.has(result?.status)) return result;
  } catch (error) {
    const status = Number(/\(status (\d+)\)/.exec(String(error?.message ?? ''))?.[1]);
    if (status && !NOT_THIS_USER.has(status)) throw error;
  }
  return asApp();
}

/**
 * Could a controlled transition into this status be running unseen by the app?
 *
 * The user's own transition list always contains the transition they are
 * running. The app's may not: a workflow condition ("only the assignee", a
 * group) can hide from the app a transition the user can perform. If that
 * hidden one is controlled and the app sees only uncontrolled siblings into
 * the same status, resolveEdge would take an uncontrolled edge and let a
 * controlled transition through unsigned. So, for an app-read list only, every
 * active rule that could match this move must name a transition the app can
 * see; otherwise the edge is unresolved and fails closed, as it did before the
 * fallback existed. `rules` is listGatedTransitions(projectId), capped at 200
 * rows, so a full page is treated as incomplete.
 */
export function hidesControlledTransition(rules, available, { issueTypeId, fromStatusId, toStatusId }) {
  if (!Array.isArray(rules) || rules.length >= 200) return true;
  const seen = new Set(available.filter(t => t.isAvailable !== false).map(t => String(t.id)));
  const covers = (value, wanted) => String(value) === '*' || String(value) === String(wanted);
  return rules.some(rule => rule.state === 'ACTIVE' && covers(rule.issue_type_id, issueTypeId)
    && covers(rule.from_status_id, fromStatusId) && covers(rule.to_status_id, toStatusId)
    && !seen.has(String(rule.transition_id)));
}

/** No diff/LLM or writes on the hot-path snapshot; fresh Jira content closes trigger lag. */
export async function gateRuntime() {
  const { api, route, query, audit, eligible, approvals, config, baselines } = await shared();
  const { rootNodeDigests, activeRootsForNode } = await import('../../db/baselineTreeStore.js');
  const resolve = args => resolveEdge({
    gated: id => config.gatedTransition({ projectId: args.issue.projectId, issueTypeId: args.issue.issueTypeId,
      fromStatusId: args.fromStatusId, toStatusId: args.toStatusId, transitionId: id }),
    signedTransitionId: async () => (await approvals.pendingApprovalByToken({
      issueId: args.issue.issueId, fromStatusId: args.fromStatusId, toStatusId: args.toStatusId,
      approvalId: Buffer.from(args.approvalId, 'hex'), now: Date.now()
    }))?.transition_id,
    transitions: () => readAsUserOrApp(
      () => availableTransitions(api, args.issue.issueKey),
      async () => {
        const available = await availableTransitions(api, args.issue.issueKey, { asApp: true });
        if (hidesControlledTransition(await config.listGatedTransitions(args.issue.projectId), available, {
          issueTypeId: args.issue.issueTypeId, fromStatusId: args.fromStatusId, toStatusId: args.toStatusId
        })) throw new FailClosed('SERVICE_UNAVAILABLE');
        return available;
      })
  }, args);

  const { readIssue, ancestorDeps } = liveReads({ api, route, config, baselines, rootNodeDigests, activeRootsForNode });

  return {
    now: Date.now, log: data => console.log('gate', JSON.stringify(data)), audit, eligible,
    pending: approvals.pendingApprovalFor, consume: approvals.casConsume, voidOthers: approvals.voidOthers,
    policyForApproval: async ({ approval, issueId }) => {
      const baseline = await baselines.baselineByVersion(issueId, Number(approval.baseline_version));
      if (!baseline || !Buffer.from(baseline.baseline_id).equals(Buffer.from(approval.baseline_id))) {
        throw new FailClosed('BASELINE_POLICY_INCOMPLETE');
      }
      const policy = baselinePolicy(baseline);
      return {
        transition_id: policy.transitionId,
        from_status_id: policy.reviewStatusId,
        to_status_id: policy.destinationStatusId,
        required_role: policy.requiredRole,
        required_assurance: policy.requiredAssurance,
        meaning: baselineDecisionMeaning(approval.decision, policy.version),
        capture_baseline: true
      };
    },
    load: async ({ issueKey, fromStatusId, toStatusId, transitionId, approvalId, modifiedFields, configuredTransitionId }) => {
      const issue = describeIssue(await readIssue(issueKey));
      if (issue.statusId !== fromStatusId) throw new FailClosed('STATUS_CHANGED');

      // THE ITEM FIRST, THE EDGE SECOND. This validator is attached to every
      // transition, and drift holds the item on all of them — so nothing about
      // which transition this is may stand between a drifted item and its
      // refusal. Everything below that can fail on the edge is reported, not
      // thrown, and gate.js refuses on it only after the drift hold has run.
      const [items, scoped, health, active] = await Promise.all([
        query('SELECT state, baseline_version FROM va_item_state WHERE issue_id = ?', [issue.issueId]),
        // A child of an approved tree is held to its root's fields, here as on
        // every other path — or a file added to it would never hold anything.
        scopeForItem(issue, { activeRootsForNode }).then(async found => ({ found,
          fields: await config.controlledFields({ projectId: found.projectId, issueTypeId: found.issueTypeId }) })),
        config.projectConfig(issue.projectId),
        baselines.activeBaseline(issue.issueId)
      ]);
      const item = items[0] ?? null;
      const declared = scoped.fields;
      const scope = scoped.found;
      if (active && item && Number(item.baseline_version) !== Number(active.version)) {
        query('UPDATE va_item_state SET baseline_version = ? WHERE issue_id = ?', [active.version, issue.issueId]).catch(() => {});
        item.baseline_version = active.version;
      }
      // Drift is the live content against the active baseline, never a stored
      // counter: this is what the panel offers a decision on, so an item held
      // here always has a decision waiting for it, and an edit made a moment
      // ago holds the item before any collector has seen it.
      const drift = await baselineDrift({ baseline: active, issueId: issue.issueId, issueFields: issue.fields,
        declared, readRootDigests: rootNodeDigests });
      logLiveDrift('gate', { issueKey: issue.issueKey, issueTypeId: issue.issueTypeId, comparison: drift, scope });
      // Only a held link explains itself this way, and only then is it read.
      const linkPending = drift.changed.includes('issuelinks')
        && (await linkDecisionsPending(issue.issueId).catch(() => [])).length > 0;

      // Held from above (lib/ancestorHold.js): read only when the item's own
      // content is unchanged, since its own drift already holds it. A failed
      // read is reported, not thrown, so gate.js refuses on it after the
      // item's own checks, like an unresolved edge.
      let ancestorDrift = null;
      let ancestorDriftError = null;
      if (drift.changed.length === 0 && health?.enabled !== false) {
        ancestorDrift = await driftedAncestor(issue, ancestorDeps, { surface: 'gate-ancestor' })
          .catch(error => { ancestorDriftError = error?.reason ?? error?.message ?? 'UNREADABLE'; return null; });
      }

      // A test execution reaches Done only with every run terminal and every
      // failed run's bug created (testmgmt/executionGuard.js). Reported, not
      // thrown, like the ancestor read: gate.js refuses on it in order.
      let testGuard = null;
      try {
        testGuard = await executionGuard({ issue, readStatusCategory: () => statusCategory(api, route, toStatusId) });
      } catch { testGuard = { error: true }; }

      const edge = await resolve({ issue, fromStatusId, toStatusId, transitionId, approvalId, configuredTransitionId });
      // The approval content hash reads the whole tree for a tree baseline, so
      // it is computed only when a signature is actually being checked.
      let basis = null;
      const contentHash = async approval => {
        const linkPolicy = baselineLinkPolicy(approval);
        const computed = await approvalContentHash({ issue, declared, modifiedFields, activeBaseline: active, linkPolicy,
          readTree: active?.tree_hash || active?.captured_by_baseline_id
            ? createTreeReader({ api, route, exclude: testManagementExclusion }).read : null });
        basis = hashBasis({ mode: computed.mode, scopeSource: scope.source, scopeIssueTypeId: scope.issueTypeId,
          fields: computed.fields, issue, linkPolicy });
        return computed.contentHash;
      };
      return { ...issue, ...edge, health, item, contentHash, hashBasis: () => basis, driftCount: drift.changed.length, linkPending,
        driftedFields: drift.changed, driftDiagnostics: drift.diagnostics ?? null, driftScope: scope,
        ancestorDrift, ancestorDriftError, testGuard };
    }
  };
}
