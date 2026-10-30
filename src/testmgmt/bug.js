/**
 * Create one bug per fully signed Failed run under the test's parent and
 * link it to the test and execution, under owner decisions 5 and 10.
 *
 * Persist a run-keyed intent before calling Jira and claim each create by
 * compare-and-swap. Set the search marker label and confirming run property
 * in the create request. Concurrent callers reconcile the intent instead of
 * issuing another create.
 *
 * After a timeout or 5xx, wait SETTLE_MS for Jira indexing before searching.
 * Read back each match's property. Accept exactly one confirmed bug. Missing,
 * ambiguous, unconfirmed or unreadable matches require administrator repair.
 * A 4xx refusal immediately becomes NEEDS_REPAIR. Never retry an uncertain
 * create or alter its payload automatically.
 */

export const BUG_STATE = Object.freeze({ INTENT: 'INTENT', CREATED: 'CREATED', NEEDS_REPAIR: 'NEEDS_REPAIR' });

/** Longer than a resolver can run, so an intent this fresh may still be in flight. */
export const IN_FLIGHT_MS = 60_000;

/** How long after a lost create before its marker is searched for: Jira's search index lags behind a new issue. */
export const SETTLE_MS = 5 * 60_000;

/** The entity property set on the bug at create, naming its run. */
export const BUG_PROPERTY = 'va-tm-bug';

export function bugMarker(runId) {
  return `va-run-${String(runId).slice(0, 32)}`;
}

const paragraph = (text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text: String(text).slice(0, 3000) }] : [] });
const heading = (text) => ({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text }] });

/** The bug's description: what failed, against which signed version, with which evidence. */
export function bugDescription({ run, testKey, versionNo, executionKey, steps, signers }) {
  const failed = steps.filter(s => s.status === 'FAILED');
  const content = [
    paragraph(`Created automatically by VAtlassian when test run ${run.runId.slice(0, 8)} of ${testKey} v${versionNo} was signed off as Failed.`),
    paragraph(`Execution: ${executionKey}. Environment: ${run.environment || 'not stated'}. Configuration: ${run.configuration || 'not stated'}. Release: ${run.release?.name ?? 'not stated'}.`),
    paragraph(`Signed off by: ${signers.map(s => `${s.label}: ${s.printedName}`).join('; ')}.`),
    heading('Failed steps')
  ];
  for (const step of failed) {
    content.push(paragraph(`Step ${step.position}: ${step.action}`));
    content.push(paragraph(`Expected: ${step.expected}`));
    content.push(paragraph(`Actual: ${step.actual || '(not recorded)'}`));
    if (step.comment) content.push(paragraph(`Comment: ${step.comment}`));
    for (const e of step.evidence ?? []) content.push(paragraph(`Evidence: ${e.filename} (SHA-256 ${e.sha256})`));
  }
  return { type: 'doc', version: 1, content };
}

/**
 * Create the run's bug, or report where it stands. Safe to call again: the
 * intent row decides, never the caller.
 *
 * `unbuildable`, when given, is why no bug can be built for this run (the test
 * cannot be read): the intent row records it as NEEDS_REPAIR, so the run shows
 * it instead of waiting for a bug that will never come.
 *
 * deps: insertBugIntent, readBug, updateBug, createIssue(fields, properties) →
 * { id, key } (throws { status } on failure, status absent when the answer was
 * lost), searchByLabel(label) → { complete, issues }, readMarker(issueId) →
 * { projectId, runId }, linkIssue({ typeName, inwardId, outwardId }), now().
 */
export async function ensureBug({ run, parentIssueId, fields, links, unbuildable = null }, deps) {
  const marker = bugMarker(run.runId);
  const now = deps.now();
  const inserted = await deps.insertBugIntent({ runId: run.runId, projectId: run.projectId, parentIssueId, marker, now });
  const bug = await deps.readBug(run.runId);
  if (!bug) return { state: BUG_STATE.NEEDS_REPAIR, error: 'INTENT_UNREADABLE' };
  if (bug.state === BUG_STATE.CREATED || bug.state === BUG_STATE.NEEDS_REPAIR) return bug;
  if (unbuildable || !parentIssueId) {
    await deps.updateBug(run.runId, { from: BUG_STATE.INTENT, state: BUG_STATE.NEEDS_REPAIR,
      lastError: unbuildable ?? 'TEST_HAS_NO_PARENT', now });
    return deps.readBug(run.runId);
  }

  // Someone else wrote the intent and has not sent a create yet: they may be
  // about to. Their claim below would stop a second create anyway; this spares
  // the call.
  if (!inserted && bug.attempts === 0 && now - bug.updatedAt < IN_FLIGHT_MS) return bug;
  if (bug.attempts > 0) {
    // A create was sent and its answer never recorded. Too soon, and the
    // search could miss the bug it made.
    if (now - bug.updatedAt < SETTLE_MS) return bug;
    const found = await reconcile(run, marker, deps);
    if (found.repair) return markRepair(run.runId, found.repair, deps);
    if (found.issue) return markCreated(run.runId, found.issue, links, deps);
    return markRepair(run.runId, 'CREATE_ABSENCE_UNPROVEN', deps);
  }

  // Claim this attempt. A caller that loses the claim leaves the create to the winner.
  if (!await deps.updateBug(run.runId, { from: BUG_STATE.INTENT, state: BUG_STATE.INTENT, attempted: true,
    expectedAttempts: bug.attempts, lastError: bug.lastError, now: deps.now() })) return deps.readBug(run.runId);
  const body = { ...fields, parent: { id: String(parentIssueId) }, labels: [...(fields.labels ?? []), marker] };
  try {
    const created = await createWithThrottleRetry(body, run.runId, deps);
    return markCreated(run.runId, created, links, deps);
  } catch (error) {
    if (error?.status === 429) return markRepair(run.runId, 'RATE_LIMITED_RETRY_EXHAUSTED', deps);
    if (error?.status && error.status >= 400 && error.status < 500) {
      return markRepair(run.runId, `JIRA_REFUSED_${error.status}`, deps);
    }
    // The bug may exist. A later call looks for it, once search has caught up.
    await deps.updateBug(run.runId, { from: BUG_STATE.INTENT, state: BUG_STATE.INTENT, lastError: 'CREATE_ANSWER_LOST', now: deps.now() });
    return deps.readBug(run.runId);
  }
}

async function reconcile(run, marker, deps) {
  let search;
  try { search = await deps.searchByLabel(marker); } catch { return { repair: 'RECONCILE_SEARCH_FAILED' }; }
  if (!search?.complete) return { repair: 'RECONCILE_SEARCH_INCOMPLETE' };
  // A label is text any editor can add. Only the property set in the create,
  // read back from the issue itself, says the issue is this run's bug.
  const confirmed = [];
  for (const candidate of search.issues) {
    let mark;
    try { mark = await deps.readMarker(candidate.id); } catch { return { repair: 'RECONCILE_READ_FAILED' }; }
    if (mark?.runId === run.runId && String(mark?.projectId) === String(run.projectId)) confirmed.push(candidate);
  }
  if (confirmed.length > 1) return { repair: 'DUPLICATE_BUGS_FOUND' };
  if (confirmed.length === 1) return { issue: confirmed[0] };
  // The marker is on an issue that is not confirmed as this run's bug. It may
  // be the bug with its property lost; creating again could make a second.
  if (search.issues.length) return { repair: 'MARKER_NOT_CONFIRMED' };
  return {};
}

async function markCreated(runId, issue, links, deps) {
  if (deps.claimBugIssue && !await deps.claimBugIssue({ runId, issueId: issue.id, now: deps.now() })) {
    await deps.updateBug(runId, { from: BUG_STATE.INTENT, state: BUG_STATE.NEEDS_REPAIR,
      issueId: issue.id, issueKey: issue.key, lastError: 'BUG_ALREADY_ASSIGNED', now: deps.now() });
    return deps.readBug(runId);
  }
  // The issue identity is retained even when a required navigation link fails;
  // it must never trigger another create or release the Done guard.
  const missing = [];
  for (const link of links ?? []) {
    try { await deps.linkIssue({ ...link, inwardId: String(issue.id) }); }
    catch { missing.push(link.outwardId); }
  }
  await deps.updateBug(runId, { from: BUG_STATE.INTENT, state: missing.length ? BUG_STATE.NEEDS_REPAIR : BUG_STATE.CREATED,
    issueId: issue.id, issueKey: issue.key, lastError: missing.length ? `LINK_MISSING:${missing.join(',')}` : null, now: deps.now() });
  return deps.readBug(runId);
}

async function createWithThrottleRetry(body, runId, deps) {
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let retry = 0; ; retry++) {
    try { return await deps.createIssue(body, [{ key: BUG_PROPERTY, value: { runId } }]); }
    catch (error) {
      // Jira expressly refused a throttled request: there was no ambiguous
      // create. Keep retries within this claimed attempt and resolver budget.
      const delay = Math.max(1_000, Number(error?.retryAfterMs) || 1_000);
      if (error?.status !== 429 || retry >= 2 || delay > 5_000) throw error;
      await sleep(delay);
    }
  }
}

async function markRepair(runId, reason, deps) {
  await deps.updateBug(runId, { from: BUG_STATE.INTENT, state: BUG_STATE.NEEDS_REPAIR, lastError: reason, now: deps.now() });
  return deps.readBug(runId);
}
