/**
 * THE LINK DECISION WORKER — consumer of va-link-queue.
 *
 * An approval that decided a link change queues one job per other issue
 * (lib/approval/linkPropagation.js, from usecases/drift.js). This records the
 * decision on that other issue: a new baseline version with only its links
 * changed, authenticated by the same approval (db/derivedBaselineStore.js).
 * Off the approval's own 25-second budget, because the other issue may be a
 * tree whose whole record is copied.
 *
 * Idempotent: the other issue's standing record is read first, and a record
 * that already agrees is left alone, so a redelivered job writes nothing.
 * An other issue in the middle of its own decision or restore is retried
 * later, never written underneath it.
 */
import { applyLinkChanges, deriveFlatRecord, deriveTreeRecord, recordedLinks } from '../lib/approval/linkPropagation.js';
import { retryEvent } from '../triggers/retry.js';
import { EVENT } from '../lib/ledger.js';

async function defaultDeps() {
  const [baselines, trees, items, derived, ledger, collector, pending] = await Promise.all([
    import('../db/baselineStore.js'), import('../db/baselineTreeStore.js'), import('../db/itemStateStore.js'),
    import('../db/derivedBaselineStore.js'), import('../db/store.js'), import('../lib/collect.js'),
    import('../db/linkPendingStore.js')
  ]);
  return {
    activeBaseline: baselines.activeBaseline, readAllValues: baselines.readAllValues,
    readBaselineTree: trees.readBaselineTree,
    getReview: items.getReview, acquire: items.acquire, release: items.release, upsertBaselined: items.upsertBaselined,
    writeDerivedFlat: derived.writeDerivedFlat, writeDerivedTree: derived.writeDerivedTree,
    tryAppend: ledger.tryAppend,
    clearPending: pending.clearLinkDecisionPending,
    // Re-measure the other issue against its new record: whatever else was
    // undecided there is still undecided.
    recollect: ({ issueId, issueKey, tree }) => tree
      ? (issueKey ? collector.collectTree({ rootIssueId: issueId, rootIssueKey: issueKey }) : null)
      : collector.collect({ issueId, issueKey: issueKey ?? undefined }),
    now: Date.now
  };
}

const describe = changes => (changes ?? []).map(({ change, link }) => ({ change,
  type: link?.type?.name ?? link?.type?.id ?? null,
  otherIssue: (link?.inwardIssue ?? link?.outwardIssue)?.key ?? null }));

/**
 * The job, then its pending marker (db/linkPendingStore.js) cleared whatever
 * it concluded — recorded, already agreeing, or not recordable — so the other
 * issue stops saying a decision is on its way. A retry keeps it: the decision
 * is still coming. A thrown error keeps it too, and its age retires it.
 */
export async function runLinkWorker(eventOrBody, overrides = null) {
  const body = eventOrBody?.body ?? eventOrBody;
  const deps = overrides ?? await defaultDeps();
  const result = await recordLinkDecision(eventOrBody, body, deps);
  if (!result?._retry && result?.outcome !== 'MALFORMED') {
    await deps.clearPending({ issueId: Number(body.otherIssueId), decidedOnIssueId: Number(body.issueId) })
      .catch(error => console.error('linkWorker: could not clear the pending marker', error));
  }
  return result;
}

async function recordLinkDecision(eventOrBody, body, deps) {
  const issueId = Number(body?.otherIssueId);
  if (!Number.isSafeInteger(issueId) || issueId <= 0 || !Array.isArray(body?.changes)) return { outcome: 'MALFORMED' };
  const decidedOn = { id: String(body.issueId), key: String(body.issueKey) };
  const notRecorded = reason => deps.tryAppend({ actorAccountId: 'system', eventType: EVENT.LINK_DECISION_NOT_RECORDED,
    issueId, payload: { reason, decidedOn: decidedOn.key, changes: describe(body.changes) } }).catch(() => {});

  const source = await deps.activeBaseline(issueId);
  if (!source) return { outcome: 'NOT_GOVERNED' };
  let tree = null, values, record;
  if (source.tree_hash) {
    tree = await deps.readBaselineTree(source.baseline_id);
    const root = tree?.nodes?.find(node => node.parentLogicalNodeId == null);
    values = root ? tree.values?.[root.logicalNodeId] ?? {} : {};
    record = recordedLinks({ digests: root?.fieldDigests ?? null, values });
  } else {
    values = await deps.readAllValues(issueId, source.version);
    record = recordedLinks({ digests: source.field_digests, values });
  }
  if (!record.tracks) return { outcome: 'NOT_TRACKED' };
  if (!record.links) { await notRecorded('LINKS_NOT_RETAINED'); return { outcome: 'NOT_RETAINED' }; }

  const links = applyLinkChanges({ links: record.links, decidedOn, changes: body.changes });
  if (!links) return { outcome: 'AGREES' };

  const now = deps.now();
  const review = await deps.getReview(issueId);
  const lock = review
    ? await deps.acquire({ issueId, expectedVersion: review.version, state: 'DECIDING',
      allowedStates: ['BASELINED', 'DRIFTED', 'ERROR'], now })
    : { acquired: true };
  if (!lock?.acquired) {
    const retry = retryEvent(eventOrBody, 'OTHER_END_BUSY');
    if (!retry?.retryExhausted) return retry;
    await notRecorded('OTHER_END_BUSY');
    return { outcome: 'BUSY' };
  }

  const approval = { approvalId: Buffer.from(String(body.approvalId), 'base64'), accountId: body.approvedBy,
    displayName: body.approvedName, assuranceLevel: body.assuranceLevel, signerRole: body.signerRole ?? null };
  let written, contentHash, fieldDigests;
  try {
    if (tree) {
      const derived = deriveTreeRecord({ tree, links });
      written = await deps.writeDerivedTree({ source, derived, approval, now });
      contentHash = derived.treeHash;
      fieldDigests = '{}';
    } else {
      const derived = deriveFlatRecord({ values, digests: record.digests, links });
      written = await deps.writeDerivedFlat({ source, values: derived.values, digests: derived.digests,
        contentHash: derived.contentHash, approval, now });
      contentHash = derived.contentHash;
      fieldDigests = JSON.stringify(derived.digests);
    }
  } catch (error) {
    if (review) await deps.release({ issueId, state: review.state, now,
      counters: { driftCount: review.drift_count ?? 0, driftedFieldCount: review.drifted_field_count ?? 0,
        maxMateriality: review.max_materiality ?? null } }).catch(() => {});
    // The new evidence tables are not there yet: wait for the migration.
    if (error?.reason === 'SCHEMA_PENDING') {
      const retry = retryEvent(eventOrBody, 'SCHEMA_PENDING');
      if (!retry?.retryExhausted) return retry;
      await notRecorded('SCHEMA_PENDING');
    }
    throw error;
  }

  const issueKey = review?.issue_key ?? null;
  await deps.upsertBaselined({ issueId, issueKey: issueKey ?? String(issueId), projectId: Number(source.project_id),
    issueTypeId: String(source.issue_type_id), summary: review?.summary ?? '',
    reviewerAccountId: review?.reviewer_account_id ?? body.approvedBy, reviewerName: review?.reviewer_name ?? body.approvedName,
    baselineId: written.baselineId, baselineVersion: Number(written.version), contentHash, fieldDigests,
    lastChangelogId: null, now });
  await deps.tryAppend({ actorAccountId: body.approvedBy, eventType: EVENT.BASELINE_CAPTURED, issueId,
    approvalId: approval.approvalId,
    payload: { version: Number(written.version), assuranceLevel: body.assuranceLevel,
      linkDecision: { decidedOn: decidedOn.key, decidedOnIssueId: Number(decidedOn.id),
        fromVersion: Number(source.version), changes: describe(body.changes) } } });
  try {
    await deps.recollect({ issueId, issueKey, tree: Boolean(tree) });
  } catch (error) {
    console.error('linkWorker: re-measuring the other issue failed', JSON.stringify({ issueId }), error);
  }
  return { outcome: 'RECORDED', version: Number(written.version) };
}

export async function handler(event) {
  const { withRequestCache } = await import('../lib/cache.js');
  return withRequestCache(() => runLinkWorker(event));
}
