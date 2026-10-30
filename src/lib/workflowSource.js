/**
 * Read the workflow Jira currently enforces for a project and issue type.
 *
 * jobs/gatecheck.js compares this data with va_controlled_transition on a
 * schedule through lib/gateDrift.js. The admin transition picker in
 * usecases/adminDirectory.js#listWorkflowTransitions reads it on demand so
 * administrators can select an exact transition instead of typing status IDs.
 * Both callers use the same response contract.
 *
 * Read one project/issue-type pair per request. The bulk-get response does not
 * map workflows back to input pairs. A live check on 2026-08-31 returned one
 * unattributed workflow for four issue types.
 *
 * readWorkflowForPair returns null for errors, missing data and exceptions.
 * Treat null as an unread workflow, never an empty transition list. Failed
 * reads must neither clear drift findings nor offer unverified transitions.
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
    // A single pair must resolve to exactly one workflow. More than one means
    // the response can no longer be attributed safely, so never select one by
    // position and risk configuring or clearing findings against the wrong
    // workflow.
    if (workflows.length > 1) {
      console.error(`workflowSource: ambiguous response (${workflows.length} workflows) for one pair ${projectId}/${issueTypeId}`);
      return null;
    }
    if (!Array.isArray(data.statuses) || data.statuses.length === 0 || !Array.isArray(workflows[0].transitions)) {
      console.error(`workflowSource: incomplete workflow response for ${projectId}/${issueTypeId}`);
      return null;
    }
    // Jira returns the reference-to-id table at the response root. Workflow
    // transitions point at those references, which can be UUIDs rather than
    // the numeric status ids used by issue reads and our controlled rows.
    const statusIds = new Map((data.statuses ?? [])
      .filter(status => status?.statusReference != null && status?.id != null)
      .map(status => [String(status.statusReference), String(status.id)]));
    const transitions = [];
    for (const transition of workflows[0].transitions ?? []) {
      const toStatusId = statusIds.get(String(transition.toStatusReference));
      const links = [];
      for (const link of transition.links ?? []) {
        // Jira includes a layout-only link such as `{ toPort: 1 }` on an
        // INITIAL transition. Creation has no source status to resolve, and
        // the admin picker never offers INITIAL transitions, so preserve the
        // layout link instead of treating its intentionally absent source as
        // an incomplete directed edge.
        if (transition.type === 'INITIAL' && link?.fromStatusReference == null) {
          links.push(link);
          continue;
        }
        const fromStatusId = statusIds.get(String(link.fromStatusReference));
        if (!fromStatusId) {
          console.error(`workflowSource: unknown source status reference for ${projectId}/${issueTypeId}`);
          return null;
        }
        links.push({ ...link, fromStatusReference: fromStatusId });
      }
      if (!toStatusId) {
        console.error(`workflowSource: unknown destination status reference for ${projectId}/${issueTypeId}`);
        return null;
      }
      transitions.push({ ...transition, toStatusReference: toStatusId, links });
    }
    return { ...workflows[0], transitions };
  } catch (e) {
    console.error(`workflowSource: workflow read threw for ${projectId}/${issueTypeId}`, e);
    return null;
  }
}

export async function defaultRequest({ projectId, issueTypeId }, { asApp: appClient = asApp, route: jiraRoute = route } = {}) {
  // asApp(), not asUser(): reading workflow configuration needs admin
  // authority. gatecheck runs from a scheduled trigger with no user in
  // context at all; the admin picker runs from a request that already
  // rechecked admin authority in adminRuntime.js#requireAdmin, so asUser()
  // would add nothing here and would fail for gatecheck's caller.
  return appClient().requestJira(jiraRoute`/rest/api/3/workflows?useTransitionLinksFormat=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      projectAndIssueTypes: [{ projectId: String(projectId), issueTypeId: String(issueTypeId) }]
    })
  });
}
