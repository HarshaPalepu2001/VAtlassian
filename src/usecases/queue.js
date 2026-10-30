import api, { route } from '@forge/api';
import { actorFrom, respond, fail } from './panelAccess.js';
import { grantsFor } from '../lib/reviewer.js';
import { rowAuthorises } from '../lib/eligibility.js';
import { gatedReviewStatuses, gatedTransition } from '../db/configStore.js';
import { awaitingDecision } from '../db/itemStateStore.js';
import { activeBaselines } from '../db/baselineStore.js';
import { latestRestoresFor } from '../db/restoreStore.js';
import { pendingMovesFor } from '../db/approvalStore.js';
import { linkDecisionsPendingFor } from '../db/linkPendingStore.js';
import { transitionsFrom } from '../lib/transitions.js';
import { resolveActions } from '../lib/journey.js';
import { baselinePolicy } from '../lib/baselinePolicy.js';

/**
 * List work awaiting this person's roles under the same rules used by signing.
 *
 * CHANGES: Read signed items changed since approval from va_item_state, wherever
 *   they are in the workflow. Use the role stored in the baseline, as
 *   usecases/drift.js prepareApproval does, rather than today's transition rule.
 *   Removed rules and parent-approved children must remain reviewable while
 *   Jira holds them for an outstanding decision.
 * RESTORE: Include unfinished restoration of the current baseline. All holders
 *   of the required role may approve or reject again. Only the rejecting
 *   reviewer may retry (usecases/restore.js retry); canRetry identifies them.
 * TRANSITION: Read the issue's current status and user-offered transitions live.
 *   JQL results may still contain the status an issue has left.
 *
 * Show decisions first, oldest first. Never also offer a transition for an item
 * with an outstanding change decision, because gate.js holds those moves.
 */

/** A restore in one of these states stopped short of the approved record. */
const UNFINISHED_RESTORE = new Set(['PARTIAL', 'FAILED', 'QUEUING_FAILED']);
/** Actionable transitions a page aims for before it stops searching. */
const PAGE_TARGET = 20;
const SEARCH_PAGE = 50;
/** Bounds on filling one page, so a scope full of other people's work cannot run a resolver out of time. */
const MAX_SEARCH_PAGES = 4;
const SEARCH_BUDGET_MS = 12_000;
const READ_CONCURRENCY = 5;
/** Decisions per page, preserving the previous single-page size. */
const DECISIONS_PAGE = 200;
/**
 * Limit the outstanding decisions fetched by one call. Report
 * `decisionsOverflow` when this limit is reached. Previously, the default
 * store limit silently truncated scopes larger than DECISIONS_PAGE.
 */
const DECISIONS_HARD_CAP = 2000;

export async function list({ payload = {}, context }) { return respond(async () => {
  const actor = actorFrom(context);
  const grants = await grantsFor(actor.accountId);
  if (!grants.length) return { items: [], nextPageToken: null };
  const { decisionsCursor, transitionsToken } = decodeToken(payload.nextPageToken);

  // Recomputed on every page, not only while decisions are still being shown:
  // it is what keeps an item under decision from ever also showing as a
  // transition (gate.js holds it at the validator, but that does not remove
  // it from Jira's own transition list). Losing this set after decisions
  // finish paging would let such an item reappear once transitions resume.
  // Storage only, no Jira read, so paying for it again each call is cheap.
  const { items: all, overflow } = await decisionsFor(grants);
  const skip = new Set(all.map(({ row }) => Number(row.issue_id)));

  // A VALUE cursor, not a row position: re-filtered against this call's own
  // fresh fetch, so an item resolved or added between calls does not shift the cursor because
  // it only ever compares each row against the last one this viewer actually
  // saw. An offset/index cursor would skip or repeat rows whenever the set
  // changed shape between calls; this cannot, because "after" means after a
  // specific (last_drift_at, issue_id), never "past position N".
  const remaining = decisionsCursor === 'done' ? []
    : decisionsCursor === 'start' ? all
      : all.filter(({ row }) => isAfterCursor(row, decisionsCursor));
  const pageRows = remaining.slice(0, DECISIONS_PAGE);
  const decisionsDone = decisionsCursor === 'done' || remaining.length <= DECISIONS_PAGE;

  const [decisions, transitions] = await Promise.all([
    pageRows.length ? decisionItems(pageRows, actor) : [],
    decisionsDone
      ? transitionItems({ grants, actor, pageToken: transitionsToken ?? null, skip })
      : Promise.resolve({ items: [], nextPageToken: transitionsToken ?? null })
  ]);

  const last = pageRows[pageRows.length - 1];
  const nextPageToken = encodeToken({
    decisionsCursor: decisionsDone ? 'done' : { afterDriftAt: Number(last.row.last_drift_at), afterIssueId: Number(last.row.issue_id) },
    transitionsToken: transitions.nextPageToken
  });
  return { items: [...decisions, ...transitions.items], nextPageToken, ...(overflow ? { decisionsOverflow: true } : {}) };
}); }

function isAfterCursor(row, cursor) {
  const driftAt = Number(row.last_drift_at);
  const issueId = Number(row.issue_id);
  return driftAt > cursor.afterDriftAt || (driftAt === cursor.afterDriftAt && issueId > cursor.afterIssueId);
}

/**
 * Encode both decision and transition-search positions in the app's opaque
 * continuation string. Jira's token alone cannot preserve both positions.
 * The decision cursor records the last (last_drift_at, issue_id) shown, so
 * resolving or adding another item does not shift the cursor as an offset would.
 * `done` marks the end of decisions; the first call without a token starts at
 * `start`.
 */
function decodeToken(raw) {
  if (!raw) return { decisionsCursor: 'start', transitionsToken: null };
  try {
    const parsed = JSON.parse(raw);
    const o = parsed.o;
    const decisionsCursor = o === null ? 'done'
      : (o && Number.isFinite(o.d) && Number.isInteger(o.i)) ? { afterDriftAt: o.d, afterIssueId: o.i }
        : 'done'; // malformed: degrades to "already finished", never re-shows a decision
    return { decisionsCursor, transitionsToken: typeof parsed.t === 'string' ? parsed.t : null };
  } catch {
    return { decisionsCursor: 'done', transitionsToken: null };
  }
}
function encodeToken({ decisionsCursor, transitionsToken }) {
  if (decisionsCursor === 'done' && !transitionsToken) return null;
  const o = decisionsCursor === 'done' ? null : { d: decisionsCursor.afterDriftAt, i: decisionsCursor.afterIssueId };
  return JSON.stringify({ o, t: transitionsToken });
}

// ── Decisions: changes and unfinished restores ─────────────────────────────

/**
 * Every recorded item this person may decide, oldest first, and whether the
 * hard cap below was reached. Storage only; no Jira read. Bounded by
 * DECISIONS_HARD_CAP, not by one page's display size (DECISIONS_PAGE). The
 * caller pages the already-fetched list in memory rather than re-querying.
 */
async function decisionsFor(grants) {
  const siteWide = grants.some(g => g.project_id == null);
  const projectIds = siteWide ? [] : [...new Set(grants.map(g => Number(g.project_id)).filter(Number.isFinite))];
  const rows = await awaitingDecision({ projectIds, siteWide, limit: DECISIONS_HARD_CAP });
  const overflow = rows.length >= DECISIONS_HARD_CAP;
  if (!rows.length) return { items: [], overflow };
  const baselines = byIssue(await activeBaselines(rows.map(row => Number(row.issue_id))));
  const items = rows.flatMap(row => {
    const baseline = baselines.get(Number(row.issue_id));
    const role = frozenRole(baseline);
    return role && grants.some(g => rowAuthorises(g, { projectId: row.project_id, issueTypeId: row.issue_type_id, role }))
      ? [{ row, baseline }] : [];
  });
  return { items, overflow };
}

/** The role a change to this baseline needs, or null when it recorded no complete rule to decide it by. */
function frozenRole(baseline) {
  if (!baseline) return null;
  try { return baselinePolicy(baseline).requiredRole; } catch { return null; }
}

async function decisionItems(waiting, actor) {
  if (!waiting.length) return [];
  const ids = waiting.map(({ row }) => Number(row.issue_id));
  // The search is what proves this person may see each item: the app's record
  // of an issue hidden from them by issue security is never shown. It also
  // brings the status, for display only.
  const [visible, restores, linkPending] = await Promise.all([
    searchByIds(ids), latestRestoresFor(ids), linkDecisionsPendingFor(ids)
  ]);
  return waiting
    .filter(({ row }) => visible.has(Number(row.issue_id)))
    .map(({ row, baseline }) => {
      const issueId = Number(row.issue_id);
      const issue = visible.get(issueId);
      const version = Number(baseline.version);
      const item = { ...header(issue, row), state: row.state, baselineVersion: version,
        driftCount: Number(row.drift_count ?? 0), materialCount: Number(row.drifted_field_count ?? 0),
        maxMateriality: row.max_materiality ?? null, lastDriftAt: numberOrNull(row.last_drift_at) };
      const restore = restores.get(issueId);
      if (restore && UNFINISHED_RESTORE.has(restore.state) && Number(restore.baseline_version) === version) {
        return { ...item, kind: 'RESTORE', note: null, restoreId: restore.restore_id, restoreState: restore.state,
          canRetry: restore.actor_account_id === actor.accountId,
          waitingSince: numberOrNull(restore.finished_at ?? restore.started_at) };
      }
      return { ...item, kind: 'CHANGES', waitingSince: item.lastDriftAt,
        note: linkPending.has(issueId) ? 'LINK_RECORDING' : row.state === 'ERROR' ? 'DECISION_INCOMPLETE' : null };
    })
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || oldestFirst(a.waitingSince, b.waitingSince));
}

const KIND_ORDER = { CHANGES: 0, RESTORE: 1, TRANSITION: 2 };
const oldestFirst = (a, b) => (a ?? Infinity) - (b ?? Infinity);

/** Map(issueId -> issue) of the given ids this person can browse. */
async function searchByIds(ids) {
  const visible = new Map();
  let nextPageToken = null;
  do {
    const page = await search({ jql: `id in (${ids.join(',')})`, maxResults: 100, nextPageToken });
    for (const issue of page.issues ?? []) visible.set(Number(issue.id), issue);
    nextPageToken = page.nextPageToken ?? null;
  } while (nextPageToken);
  return visible;
}

// ── Transitions ─────────────────────────────────────────────────────────────

async function transitionItems({ grants, actor, pageToken, skip }) {
  const scopes = await gatedReviewStatuses();
  const clauses = [...new Set(scopes
    .filter(s => grants.some(g => rowAuthorises(g, { projectId: s.projectId, issueTypeId: scopeIssueTypeForGrant(s, g), role: s.role })))
    .map(jqlForScope).filter(Boolean))];
  if (!clauses.length) return { items: [], nextPageToken: null };

  // A search page is mostly other people's work, so one page can hold nothing
  // for this person while the next holds plenty. Keep reading until the page
  // is worth showing, within the bounds above, rather than returning an empty
  // list with more behind it.
  const jql = `(${clauses.join(' OR ')}) ORDER BY updated DESC`;
  const started = Date.now();
  const found = [];
  let token = pageToken;
  let pages = 0;
  do {
    const page = await search({ jql, maxResults: SEARCH_PAGE, nextPageToken: token });
    token = page.nextPageToken ?? null;
    pages += 1;
    const candidates = (page.issues ?? []).filter(issue => !skip.has(Number(issue.id)));
    for (let i = 0; i < candidates.length; i += READ_CONCURRENCY) {
      const batch = await Promise.all(candidates.slice(i, i + READ_CONCURRENCY).map(issue => liveActions(issue, grants)));
      found.push(...batch.filter(Boolean));
    }
  } while (token && found.length < PAGE_TARGET && pages < MAX_SEARCH_PAGES && Date.now() - started < SEARCH_BUDGET_MS);
  if (!found.length) return { items: [], nextPageToken: token };

  const ids = found.map(({ issue }) => Number(issue.id));
  const [baselines, moves] = await Promise.all([
    activeBaselines(ids).then(byIssue).catch(() => new Map()),
    pendingMovesFor({ accountId: actor.accountId, issueIds: ids }).catch(() => [])
  ]);
  const items = found.map(({ issue, actions }) => {
    const baseline = baselines.get(Number(issue.id));
    const statusId = String(issue.fields?.status?.id ?? '');
    return { ...header(issue), kind: 'TRANSITION', state: baseline ? 'BASELINED' : 'UNAPPROVED',
      baselineVersion: Number(baseline?.version ?? 0), driftCount: 0, materialCount: 0, maxMateriality: null,
      lastDriftAt: null, waitingSince: null, note: null,
      transitionName: actions[0]?.toStatusName ?? actions[0]?.name ?? null,
      transitionLabel: actions[0]?.label ?? null, transitionCount: actions.length,
      // Signed already, and Jira refused the move: what is left is to retry it.
      pendingMove: moves.some(move => Number(move.issue_id) === Number(issue.id)
        && String(move.from_status_id) === statusId
        && actions.some(action => String(action.transitionId) === String(move.transition_id))) };
  });
  return { items, nextPageToken: token };
}

/** The transitions this person may sign on this issue now, from one live read. */
async function liveActions(candidate, grants) {
  let issue;
  try {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/issue/${candidate.key}?fields=summary,status,project,issuetype&expand=transitions`);
    if (!response.ok) return null;
    issue = await response.json();
  } catch {
    return null;
  }
  const { projectId, issueTypeId, fromStatusId } = issueFacts(issue);
  if (!Number.isFinite(projectId) || !issueTypeId || !fromStatusId) return null;
  const offered = transitionsFrom(issue.transitions);
  const gates = await Promise.all(offered.map(transition =>
    gatedTransition({ projectId, issueTypeId, fromStatusId, toStatusId: transition.toStatusId, transitionId: transition.id })
      .catch(() => null)));
  const eligible = gates.map(gate => gate
    ? grants.some(g => rowAuthorises(g, { projectId, issueTypeId, role: gate.required_role }))
    : false);
  const { actions } = resolveActions({ offered, gates, eligible, surface: 'queue' });
  return actions.length ? { issue, actions } : null;
}

// ── Shared ──────────────────────────────────────────────────────────────────

async function search({ jql, maxResults, nextPageToken }) {
  const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql, fields: ['summary', 'status', 'project', 'issuetype'], maxResults,
      ...(nextPageToken ? { nextPageToken: String(nextPageToken) } : {}) })
  });
  if (!response.ok) fail('QUEUE_UNAVAILABLE');
  return response.json();
}

function header(issue, row = null) {
  return { issueId: String(issue.id), issueKey: issue.key, issue_id: String(issue.id), issue_key: issue.key,
    summary: issue.fields?.summary ?? row?.summary ?? '', status: issue.fields?.status?.name ?? '' };
}

/** activeBaselines() keyed by numeric issue id, whatever type storage returned. */
function byIssue(map) {
  return new Map([...(map ?? new Map())].map(([issueId, baseline]) => [Number(issueId), baseline]));
}

function numberOrNull(value) {
  return value == null ? null : Number(value);
}

function scopeIssueType(scope) {
  return String(scope.issueTypeId ?? scope.issue_type_id ?? '*');
}

function scopeStatus(scope) {
  return String(scope.statusId ?? scope.from_status_id ?? '*');
}

function scopeIssueTypeForGrant(scope, grant) {
  const issueTypeId = scopeIssueType(scope);
  return issueTypeId === '*' ? grant.issue_type_id : issueTypeId;
}

function jqlForScope(scope) {
  const projectId = Number(scope.projectId);
  if (!Number.isFinite(projectId)) return null;
  const parts = [`project = ${projectId}`];
  const issueTypeId = scopeIssueType(scope);
  if (/^\d+$/.test(issueTypeId)) parts.push(`issuetype = ${issueTypeId}`);
  const statusId = scopeStatus(scope);
  if (/^\d+$/.test(statusId)) parts.push(`status = ${statusId}`);
  return `(${parts.join(' AND ')})`;
}

function issueFacts(issue) {
  return {
    projectId: Number(issue.fields?.project?.id),
    issueTypeId: String(issue.fields?.issuetype?.id ?? ''),
    fromStatusId: String(issue.fields?.status?.id ?? '')
  };
}
