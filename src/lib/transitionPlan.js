/**
 * Choose a transition and prepare required screen fields without I/O.
 *
 * transitions.js imports @forge/api, which cannot load in tests outside Forge.
 * Keep the transition-selection and field-preparation rules here so tests can
 * exercise them independently, as restore/outcome.js does for restore/executor.js.
 */

/**
 * Offer outbound transitions only while the item is in a configured review
 * status. Use Jira's current transitions instead of storing edges that could
 * become stale after workflow edits.
 */
export function outboundFromReview({ transitions, currentStatusId, reviewStatusIds }) {
  const reviewIds = (reviewStatusIds ?? []).map(String);
  const inReview = reviewIds.includes(String(currentStatusId));
  if (!inReview) return { inReview: false, transitions: [] };

  return {
    inReview: true,
    // Transitions that loop back into review are excluded: approving an item
    // and then sending it straight back to be reviewed again is not something
    // anybody means to do, and offering it invites a misclick that would
    // immediately supersede the baseline just created.
    transitions: (transitions ?? []).filter(
      (t) => t.isAvailable !== false && !reviewIds.includes(String(t.toStatusId))
    )
  };
}

/**
 * Fill required transition fields only from approved baseline values.
 * Return fields without approved values for the reviewer to supply. Never
 * invent content to satisfy the transition screen.
 */
export function requiredFieldPlan({ transition, baselineValues = {}, currentFields = {} }) {
  const required = Object.entries(transition?.fields ?? {})
    .filter(([, meta]) => meta.required === true);

  const prefilled = {};
  const askUser = [];

  for (const [fieldId, meta] of required) {
    // Already set on the issue: Jira accepts the transition without us
    // resending it, and resending would be a needless extra edit.
    if (hasValue(currentFields[fieldId])) continue;

    const fromBaseline = baselineValues[fieldId];
    if (hasValue(fromBaseline)) {
      prefilled[fieldId] = shapeForScreen(fromBaseline, meta);
      continue;
    }

    askUser.push({
      fieldId,
      name: meta.name ?? fieldId,
      schema: meta.schema ?? null,
      allowedValues: meta.allowedValues ?? null,
      operations: meta.operations ?? []
    });
  }

  return { prefilled, askUser, hasScreen: !!transition?.hasScreen };
}

function hasValue(v) {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

/**
 * Put a stored value into the shape a transition screen expects.
 *
 * Deliberately NOT the restore planner's full write-shape table. This only ever
 * handles the small set of types that appear on transition screens, and
 * coupling the two would drag the whole restore module into the approve path
 * for no benefit.
 */
function shapeForScreen(value, meta) {
  const type = meta?.schema?.type;
  const items = meta?.schema?.items;

  if (type === 'array') {
    const arr = Array.isArray(value) ? value : [value];
    if (items === 'string') return arr.map(String);
    if (items === 'user') {
      return arr.map((v) => ({ accountId: String(typeof v === 'object' ? v.accountId : v) }));
    }
    return arr.map((v) => ({ id: String(typeof v === 'object' ? (v.id ?? v.value ?? v) : v) }));
  }
  if (type === 'user') {
    return { accountId: String(typeof value === 'object' ? value.accountId : value) };
  }
  if (type === 'option' || type === 'priority' || type === 'resolution' || type === 'issuetype' || type === 'securitylevel') {
    return { id: String(typeof value === 'object' ? value.id : value) };
  }
  return value;
}

/**
 * Select the only available transition automatically. With multiple
 * transitions, require the reviewer to choose the destination.
 */
export function chooseTransition({ transitions, requestedId }) {
  const list = transitions ?? [];
  if (requestedId) {
    const match = list.find((t) => t.id === String(requestedId));
    return match ? { transition: match, needsChoice: false } : { transition: null, needsChoice: true };
  }
  if (list.length === 1) return { transition: list[0], needsChoice: false };
  return { transition: null, needsChoice: list.length > 1 };
}

/**
 * Suggest review statuses for setup only. Runtime gating uses the
 * administrator's explicit configuration.
 */
export function suggestReviewStatuses(statuses) {
  const pattern = /\b(review|approval|approve|qa|sign[- ]?off|verification|verify)\b/i;
  return (statuses ?? []).filter((s) => pattern.test(s.name)).map((s) => s.id);
}
