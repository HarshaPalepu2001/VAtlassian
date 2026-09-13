/**
 * WORKFLOW SOURCE — the one place this app reads what Jira's workflow engine
 * is actually enforcing, right now.
 *
 * Moved out of jobs/gatecheck.js, which was the first caller and is still one
 * of two: gatecheck diffs this read against va_controlled_transition on a
 * schedule (src/lib/gateDrift.js), and the admin transition picker
 * (src/usecases/adminDirectory.js#listWorkflowTransitions) calls it live, on
 * demand, so an administrator can select an exact Jira transition instead of
 * typing status ids that may or may not correspond to a real edge. Both
 * callers need the identical contract, so it lives once, here.
 *
 * ONE PAIR PER CALL. The bulk-get endpoint accepts several project/issue-type
 * pairs at once, but the response carries no mapping from each returned
 * workflow back to the pair that produced it — verified against a live instance
 * on 2026-08-31, where four issue types collapsed into a single unattributed
 * workflow. Sending one pair per call is what makes the attribution sound.
 *
 * FAIL CLOSED. `readWorkflowForPair` returns `null` on any error, missing
 * data, or thrown exception. Callers must treat `null` as "not read", never as
 * "workflow has no transitions" — see gatecheck.js's own header for why that
 * distinction matters for drift detection, and adminDirectory.js for why the
 * picker must refuse to offer a transition it could not itself verify live.
 */
import { asApp, route, getAppContext } from '@forge/api';

/** The Forge module key this app registers its signature-gate validator
 *  under. Shared by gate-drift detection (gateDrift.js#isOurGate) and the
 *  admin picker's "is this edge actually gated" fact. */
export const MODULE_KEY = 'va-gate';

/** This app's own identity, needed to tell OUR va-gate validator apart from
 *  another vendor's Forge validator with the same rule key. */
export function runtimeAppId() {
  const id = getAppContext().appAri.appId;
  if (!id) throw new Error('workflowSource: runtime app identity unavailable');
  return id;
}

/**
 * Fetch the workflow Jira actually serves for one project + issue type.
 * Returns null on any failure, which callers treat as "not evaluated" rather
 * than "nothing found".
 */
export async function readWorkflowForPair({ projectId, issueTypeId }, { request = defaultRequest } = {}) {
  try {
    const response = await request({ projectId, issueTypeId });
    if (!response.ok) {
      const body = await response.text();
      console.error(`workflowSource: workflow read failed for ${projectId}/${issueTypeId}`, response.status, body.slice(0, 300));
      return null;
    }
    const data = await response.json();
    const workflows = data.workflows ?? [];
    if (workflows.length === 0) {
      console.warn(`workflowSource: no workflow returned for ${projectId}/${issueTypeId}`);
      return null;
    }
    // A single pair resolves to a single workflow. More than one would mean the
    // endpoint's contract changed under us; take the first but say so, because
    // silently picking one would produce findings — or a picker offer — against
    // the wrong workflow.
    if (workflows.length > 1) {
      console.warn(`workflowSource: ${workflows.length} workflows for one pair ${projectId}/${issueTypeId}; using the first`);
    }
    return workflows[0];
  } catch (e) {
    console.error(`workflowSource: workflow read threw for ${projectId}/${issueTypeId}`, e);
    return null;
  }
}

export async function defaultRequest({ projectId, issueTypeId }) {
  // asApp(), not asUser(): reading workflow configuration needs admin
  // authority. gatecheck runs from a scheduled trigger with no user in
  // context at all; the admin picker runs from a request that already
  // rechecked admin authority in adminRuntime.js#requireAdmin, so asUser()
  // would add nothing here and would fail for gatecheck's caller.
  return asApp().requestJira(route`/rest/api/3/workflows?expand=workflows.transitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      projectAndIssueTypes: [{ projectId: String(projectId), issueTypeId: String(issueTypeId) }]
    })
  });
}
