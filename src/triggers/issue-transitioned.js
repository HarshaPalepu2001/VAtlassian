import { captureBaseline } from '../lib/capture.js';
import { collect, DETECTED_VIA } from '../lib/collect.js';
import { getReview } from '../db/itemStateStore.js';

/**
 * avi:jira:transitioned:issue
 *
 * Two jobs, and which one runs depends entirely on where the item went:
 *
 *   OUT of a review status through a configured gate → capture a baseline.
 *   INTO a review status                             → let the collector
 *                                                      disarm the standing one.
 *   anywhere else                                    → nothing. Onward movement
 *                                                      through the workflow
 *                                                      does not touch a
 *                                                      baseline (see
 *                                                      lib/interception.js).
 *
 * NEVER THROWS. A trigger that throws is retried by the platform, and an item
 * that fails permanently would be retried forever, burning invocations and
 * filling the logs with the same error.
 */
export async function run(event) {
  const issue = event?.issue;
  const changelog = event?.changelog;

  if (!issue?.id || !issue?.key) {
    console.warn('transitioned: event has no issue', JSON.stringify(Object.keys(event ?? {})));
    return;
  }

  // WHICH EDGE THIS WAS, resolved from three sources rather than one.
  //
  // Everything downstream turns on from/to status ids: gatedTransition() looks
  // the edge up by them, and if either comes back empty the lookup finds
  // nothing, capture returns NOT_A_GATE — which is the ordinary case for most
  // transitions and is deliberately not logged — and NOTHING IS BASELINED WITH
  // NOTHING LOOKING BROKEN. That is the worst failure this app has, so the
  // resolution does not rest on one payload shape holding.
  const transition = resolveTransition(event);

  const issueId = Number(issue.id);
  const issueKey = String(issue.key);
  const now = Date.now();

  // The transition's own timestamp, not "now". This is the drift epoch every
  // later comparison is measured against, and taking it from the event rather
  // than the clock is what makes the rewind in lib/baseline.js meaningful — the
  // whole point is that the trigger ran LATER than the transition.
  const transitionAt = parseTime(event?.timestamp ?? changelog?.created) ?? now;

  const actorAccountId = event?.atlassianId
    ?? event?.associatedUsers?.[0]?.accountId
    ?? issue.fields?.reporter?.accountId
    ?? null;

  // Logged on every transition, at info, and worth the line: this is the only
  // place that says which edge the app THINKS it saw. A gate that is configured
  // and still not firing is almost always a status id that did not match, and
  // without this the investigation starts with no evidence at all.
  console.log('transitioned: edge', JSON.stringify({
    issueKey,
    fromStatusId: transition.from?.id ?? null,
    toStatusId: transition.to?.id ?? null,
    transitionId: transition.transitionId ?? null,
    resolvedFrom: transition.source
  }));

  try {
    const result = await captureBaseline({
      issueId,
      issueKey,
      transition,
      actorAccountId,
      transitionAt,
      now
    });

    if (result.captured) {
      console.log('transitioned: baselined', JSON.stringify({
        issueKey,
        version: result.version,
        fidelity: result.fidelity,
        retainedFields: result.retainedFields,
        reviewer: result.reviewer ? 'assigned' : 'NONE'
      }));
      return;
    }

    // NOT_A_GATE is the common case — most transitions are not review gates.
    // It still logs, but with the tuple that failed to match, because the one
    // way this app fails invisibly is a gate that is configured and never
    // matches: the transition succeeds, nothing is baselined, and there is no
    // error anywhere to look at. One line per workflow move is a cheap price
    // for that never being a mystery.
    console.log('transitioned: not baselined', JSON.stringify({
      issueKey,
      reason: result.reason,
      ...(result.lookup ? { lookup: result.lookup } : {})
    }));

    // The item moved somewhere that is not a gate. If it is being tracked, hand
    // it to the collector: moving INTO a review status is what disarms a
    // standing baseline, and the collector is the only place that rule lives.
    const review = await getReview(issueId);
    if (review && review.baseline_id != null) {
      await collect({
        issueId,
        issueKey,
        detectedVia: DETECTED_VIA.EVENT,
        actorAccountId,
        now
      });
    }
  } catch (e) {
    // Swallowed on purpose — see the header. Logged with enough context to find
    // the item, and never with field values.
    console.error('transitioned: handler failed', JSON.stringify({ issueKey }), e);
  }
}

/**
 * Normalise the event into { from: { id }, to: { id }, transitionId }.
 *
 * THREE SOURCES, IN ORDER OF DIRECTNESS:
 *
 *   1. `event.transition`, when the platform supplies it. Field names have
 *      varied across payload shapes (`from` / `fromStatus` / `from_status`),
 *      so all three are read rather than betting on one.
 *   2. The changelog's `status` item. A transition ALWAYS produces one, and its
 *      `from` / `to` are the numeric status ids — the same values the gate
 *      configuration stores. This is the reliable source and in practice the
 *      one that answers.
 *   3. `issue.fields.status.id` for the destination only. The issue on the
 *      event is post-transition, so its status is where the item landed. There
 *      is no equivalent fallback for the origin, which is why a missing origin
 *      is reported rather than guessed.
 *
 * `source` records which one answered, so a log line says whether the platform
 * payload is still carrying what it used to.
 */
export function resolveTransition(event) {
  const t = event?.transition ?? {};
  const from = t.from?.id ?? t.fromStatus?.id ?? t.from_status?.id ?? null;
  const to = t.to?.id ?? t.toStatus?.id ?? t.to_status?.id ?? null;
  const transitionId = t.transitionId ?? t.id ?? null;

  if (from != null && to != null) {
    return { from: { id: String(from) }, to: { id: String(to) }, transitionId, source: 'transition' };
  }

  const items = event?.changelog?.items ?? [];
  const statusItem = items.find((i) => i?.fieldId === 'status' || i?.field === 'status');
  const clFrom = statusItem?.from ?? null;
  const clTo = statusItem?.to ?? null;
  const landedOn = event?.issue?.fields?.status?.id ?? null;

  const resolvedFrom = from ?? clFrom;
  const resolvedTo = to ?? clTo ?? landedOn;

  return {
    from: resolvedFrom == null ? null : { id: String(resolvedFrom) },
    to: resolvedTo == null ? null : { id: String(resolvedTo) },
    transitionId,
    source: from != null || to != null ? 'mixed' : (clFrom != null ? 'changelog' : 'issue-status')
  };
}

function parseTime(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? parsed : null;
}
