/**
 * Choosing a transition and preparing its screen — the decisions, with none of
 * the I/O.
 *
 * SEPARATE FROM transitions.js FOR THE SAME REASON restore/outcome.js is
 * separate from restore/executor.js: that file imports @forge/api and is
 * therefore unreachable from a test outside the Forge runtime. "Which
 * transitions may a reviewer take out of review" and "what will we put on the
 * screen" are rules, and rules belong somewhere a test can reach them.
 */

/**
 * ONLY the transitions that leave a review status.
 *
 * The filter the customer asked for by name, and it is deliberately expressed
 * as "the item is currently in a review status, so every transition from here
 * is an outbound review transition" rather than as a stored list of edges.
 * Storing edges goes stale the moment somebody adds a transition to the
 * workflow — and a governance app that silently stops covering a new route out
 * of review is worse than one that never claimed to.
 *
 * When the item is NOT in a review status there is nothing to offer, and saying
 * so plainly beats showing a reviewer a list of transitions that have nothing
 * to do with the approval they are giving.
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
 * Which fields a transition insists on, and which of those we can fill from the
 * approved baseline.
 *
 * "WHATEVER IS REQUIRED IS PROVIDED" HAS A LIMIT, AND THE LIMIT IS HONESTY. A
 * required field is filled ONLY from a value that was part of the approved
 * baseline. Inventing one to satisfy a screen would write data nobody approved
 * into the work item as a side effect of approving something else. Anything we
 * cannot fill is handed back for the reviewer to supply in the dialog.
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
 * Choose the transition to apply.
 *
 * One available transition is applied automatically — asking a reviewer to pick
 * from a list of one is noise. Several, and the reviewer picks, because
 * Baseline has no business deciding whether an approved item goes to Ready for
 * Dev or straight to Done.
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
 * A guess at which statuses mean "in review", for the setup screen only.
 *
 * NEVER USED AT RUNTIME — the gate reads the administrator's explicit
 * configuration and nothing else. Offering a good guess is the difference
 * between a five-minute setup and an abandoned one; acting on a guess would
 * mean an app that gates transitions nobody asked it to.
 */
export function suggestReviewStatuses(statuses) {
  const pattern = /\b(review|approval|approve|qa|sign[- ]?off|verification|verify)\b/i;
  return (statuses ?? []).filter((s) => pattern.test(s.name)).map((s) => s.id);
}
