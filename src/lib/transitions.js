import { route } from '@forge/api';

/**
 * Discover and apply transitions out of review. Pure transition choices and
 * required-field planning live in transitionPlan.js because this module
 * imports @forge/api and requires the Forge runtime. Re-export them here
 * for existing callers.
 */
export {
  outboundFromReview,
  requiredFieldPlan,
  chooseTransition,
  suggestReviewStatuses
} from './transitionPlan.js';

/**
 * Read transitions available to the reviewer with expand=transitions.fields
 * so one request also supplies required screen fields. Use asUser by default;
 * asApp would expose transitions the reviewer may lack permission to perform.
 */
export async function availableTransitions(api, issueKey, { asApp = false } = {}) {
  // Use asApp only for automatic recall. Scheduled jobs and event triggers
  // have no reviewer context. See lib/recall.js.
  const client = asApp ? api.asApp() : api.asUser();
  const res = await client.requestJira(
    route`/rest/api/3/issue/${issueKey}/transitions?expand=transitions.fields`
  );
  if (!res.ok) {
    throw new Error(`transitions: could not read transitions for ${issueKey} (status ${res.status})`);
  }
  return transitionsFrom((await res.json()).transitions);
}

/**
 * Jira's transition list in the shape every caller reads. Shared with the
 * worklist, which gets the same list inline from one issue read
 * (`expand=transitions` returns exactly what the endpoint above does, less the
 * screen fields the worklist does not need).
 */
export function transitionsFrom(transitions) {
  return (transitions ?? []).map((t) => ({
    id: String(t.id),
    name: t.name,
    toStatusId: String(t.to?.id ?? ''),
    toStatusName: t.to?.name ?? '',
    toStatusCategory: t.to?.statusCategory?.key ?? null,
    hasScreen: !!t.hasScreen,
    isAvailable: t.isAvailable !== false,
    fields: t.fields ?? {}
  }));
}

/** Resolve one currently available Jira transition by its immutable id. */
export function exactAvailableTransition(transitions, { transitionId, toStatusId = null }) {
  if (transitionId == null) return null;
  const matches = (transitions ?? []).filter(transition => transition.isAvailable !== false
    && String(transition.id) === String(transitionId)
    && (toStatusId == null || String(transition.toStatusId) === String(toStatusId)));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Perform reviewer-requested transitions asUser so Jira records the person
 * who moved the item. Return structured failures because the approval may
 * already be durable and the caller must distinguish it from a refused move.
 */
export async function applyTransition(api, { issueKey, transitionId, fields = {}, asApp = false }) {
  const body = { transition: { id: String(transitionId) } };
  if (Object.keys(fields).length > 0) body.fields = fields;

  // Attribute automatic recall to the app. The person who edited a field
  // did not request that workflow move. Record its triggering drift in the ledger.
  const client = asApp ? api.asApp() : api.asUser();

  let res;
  try {
    res = await client.requestJira(route`/rest/api/3/issue/${issueKey}/transitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return { ok: false, status: 0, errors: null, messages: [String(e?.message ?? e)] };
  }

  if (res.status === 204 || res.status === 200) return { ok: true };

  let detail = null;
  try {
    detail = await res.json();
  } catch {
    // A non-JSON error body is not worth failing over; the status is the fact
    // that matters and the caller reports it either way.
  }

  return {
    ok: false,
    status: res.status,
    // Return Jira's field messages so the reviewer can resolve required values.
    errors: detail?.errors ?? null,
    messages: detail?.errorMessages ?? null
  };
}

/**
 * Discover the statuses used by this project's live workflows so
 * administrators do not need to enter status ids manually.
 */
export async function discoverStatuses(api, projectKeyOrId) {
  const res = await api.asUser().requestJira(route`/rest/api/3/project/${projectKeyOrId}/statuses`);
  if (!res.ok) return [];
  const body = await res.json();

  const seen = new Map();
  for (const issueType of body ?? []) {
    for (const status of issueType.statuses ?? []) {
      if (!seen.has(status.id)) {
        seen.set(status.id, {
          id: String(status.id),
          name: status.name,
          category: status.statusCategory?.key ?? null,
          issueTypes: []
        });
      }
      seen.get(status.id).issueTypes.push(issueType.id);
    }
  }
  return [...seen.values()];
}
