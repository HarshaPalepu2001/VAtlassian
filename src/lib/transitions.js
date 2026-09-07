import { route } from '@forge/api';

/**
 * Discovering and applying the transition out of review.
 *
 * The customer's requirement, in their words: "we will identify what is the
 * transition available from review in this project that we will take and
 * re-apply here… whatever required is provided".
 *
 * THE DECISIONS LIVE IN ./transitionPlan.js — which transitions are offered,
 * which required fields can be filled from the baseline, and which transition
 * is chosen. They are re-exported here so callers import one module, but they
 * are defined there because this file imports @forge/api and is therefore
 * unreachable from a test outside the Forge runtime. Same split as
 * restore/outcome.js versus restore/executor.js.
 */
export {
  outboundFromReview,
  requiredFieldPlan,
  chooseTransition,
  suggestReviewStatuses
} from './transitionPlan.js';

/**
 * Every transition Jira will currently let this user perform, with the fields
 * each one demands.
 *
 * `expand=transitions.fields` is the whole reason this is one call rather than
 * three: it returns the transition screen's field metadata inline, so the
 * required-field check costs nothing extra. Without it we would be guessing at
 * what a transition screen wants, and guessing wrong means an approve that
 * fails with Jira's own error at the last possible moment.
 *
 * Read AS THE USER, deliberately. `asApp` would return the transitions the APP
 * can perform, which is not the question — the reviewer is the one clicking,
 * and offering them a transition their permissions forbid produces a confusing
 * failure at exactly the wrong time.
 */
export async function availableTransitions(api, issueKey, { asApp = false } = {}) {
  // `asApp` is for the RECALL path only — see lib/recall.js. A scheduled job or
  // an event trigger has no user to act as, and asUser() there returns nothing
  // useful. Everywhere a reviewer is present, the default stands and the
  // reasoning above applies.
  const client = asApp ? api.asApp() : api.asUser();
  const res = await client.requestJira(
    route`/rest/api/3/issue/${issueKey}/transitions?expand=transitions.fields`
  );
  if (!res.ok) {
    throw new Error(`transitions: could not read transitions for ${issueKey} (status ${res.status})`);
  }
  const body = await res.json();
  return (body.transitions ?? []).map((t) => ({
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

/**
 * Perform the transition.
 *
 * AS THE USER, always. A transition performed by the app would be attributed to
 * the app in Jira's own history, and "who moved this item out of review" is
 * precisely the fact this product exists to keep straight. Restores are written
 * as the app because they are the app's own action; a transition is the
 * reviewer's.
 *
 * Returns a structured failure rather than throwing, because by this point the
 * caller has already recorded a decision and needs to report accurately what
 * did and did not happen. "Your approval was recorded, but Jira refused the
 * transition" is a true and useful sentence; a thrown error would make the
 * reviewer believe their approval was lost and approve again.
 */
export async function applyTransition(api, { issueKey, transitionId, fields = {}, asApp = false }) {
  const body = { transition: { id: String(transitionId) } };
  if (Object.keys(fields).length > 0) body.fields = fields;

  // ── THE ONE CASE THAT IS HONESTLY THE APP'S OWN MOVE ─────────────────────
  //
  // The rule above — always as the user, because "who moved this out of review"
  // is the fact this product keeps straight — is about a REVIEWER'S transition.
  // A recall is not one. Nobody asked for it; the app detected drift and pulled
  // the item back within reach of the gate on its own initiative, from a
  // trigger with no user in context.
  //
  // Attributing that to whoever happened to make the edit would be a false
  // statement in Jira's history: they edited a field, they did not send the
  // item back for review. Doing it as the app says exactly what happened, and
  // the ledger carries the same event with the drift that caused it.
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
    // Jira returns per-field messages here, which is exactly what the reviewer
    // needs to see — "Resolution is required" is actionable, "400" is not.
    errors: detail?.errors ?? null,
    messages: detail?.errorMessages ?? null
  };
}

/**
 * Every status this project's workflows use, discovered live rather than typed
 * in.
 *
 * An administrator who has to enter status ids by hand will get one wrong, and
 * a mistyped review status means the gate silently never fires — the worst
 * failure this app has, because nothing appears broken.
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
