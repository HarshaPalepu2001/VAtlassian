import usePanelEvidence from './usePanelEvidence';
import { changedFieldCount } from './approvalModel';
import type { PanelEvidence, PanelSummary } from './types';

/** Drift totals as one evidence read states them, falling back to the summary. */
export function evidenceCounts(evidence: PanelEvidence | null, summary: PanelSummary | null) {
  if (!evidence) return { driftCount: 0, materialCount: 0 };
  const fieldCount = evidence.drift?.fields?.length ?? 0;
  // changedFieldCount(), not changedFields.length: the list is node-level and
  // this total is compared against, and falls back to, field-level counts.
  const structuralCount = changedFieldCount(evidence.drift)
    + (evidence.drift?.addedNodes?.length ?? 0) + (evidence.drift?.removedNodes?.length ?? 0)
    + (evidence.drift?.movedNodes?.length ?? 0);
  const materialFields = evidence.drift?.fields?.filter(field => field.semanticChange && field.materiality !== 'COSMETIC').length ?? 0;
  return {
    driftCount: Number(evidence.drift.count ?? (fieldCount || structuralCount || summary?.drift.count || 0)),
    materialCount: Number(evidence.drift.materialCount ?? (materialFields || summary?.drift.materialCount || 0))
  };
}

/**
 * The current record, read once and paired with the permissions that belong
 * to it — shared by the issue panel and the review window, so the two can
 * never disagree about how many changes there are or who may decide them.
 */
export default function useDecisionState(summary: PanelSummary | null, issueKey: string | undefined, refresh: () => unknown) {
  const { evidence, heldEvidence, loading: evidenceLoading, error: evidenceError, retry: retryEvidence } = usePanelEvidence({
    issueKey,
    // Evidence is the one current-record read shared by the clean banner,
    // control facts, and review workspace. It must not be keyed to a summary
    // action whose drift count may change after this read arrives.
    actionId: 'current-record',
    baselineVersion: summary?.baseline?.version ?? null,
    baselineId: summary?.baseline?.baselineId ?? null,
    evidenceVersion: summary?.evidenceVersion ?? null,
    contentHash: summary?.contentHash ?? null,
    enabled: Boolean(summary?.baseline),
    onStale: () => { void refresh(); }
  });
  const hasAuthoritativeEvidence = !summary?.baseline || Boolean(evidence);
  // What the informational sections show: the authoritative read, or — while
  // its replacement for the same baseline loads — the previous one, so a
  // background refresh updates in place instead of flashing "Checking…".
  const shownEvidence = evidence ?? heldEvidence;
  const evidenceReady = hasAuthoritativeEvidence || Boolean(evidenceError) || Boolean(heldEvidence);
  const { driftCount: evidenceDriftCount, materialCount: evidenceMaterialCount } = evidenceCounts(evidence, summary);
  // PERMISSION TRAVELS WITH THE COUNT IT BELONGS TO.
  //
  // Substituting the live re-diff's count for display while leaving
  // canApprove/canReject as the server computed them from the STORED counter is
  // what produced VJIRA-17: the panel entered drift-review mode on one number
  // (1 change) and refused on a verdict about another (0 recorded), then
  // explained the refusal by naming a role that had never been checked.
  //
  // `drift.eligible` is the viewer's own standing on this baseline, answered
  // independently of any count (panelSummary.js), so it is the right thing to
  // pair with whichever count is actually on screen.
  const canDecideShownDrift = evidenceDriftCount > 0 && summary?.drift.eligible === true;
  const displaySummary = summary && evidence
    ? { ...summary, drift: { ...summary.drift, count: evidenceDriftCount, materialCount: evidenceMaterialCount,
      canApprove: canDecideShownDrift, canReject: canDecideShownDrift,
      decidesDrift: canDecideShownDrift } }
    : summary;
  const authoritativeSummary = displaySummary ?? summary;
  // Counts that agree with the change list the Baseline card is drawing. Display only:
  // ApprovalControls keeps `authoritativeSummary`, whose permissions are
  // paired with the authoritative read and nothing else.
  const shownCounts = evidenceCounts(shownEvidence, summary);
  const shownDrift = summary && shownEvidence && !evidence
    ? { ...summary.drift, count: shownCounts.driftCount, materialCount: shownCounts.materialCount }
    : authoritativeSummary?.drift;

  return { evidence, heldEvidence, evidenceLoading, evidenceError, retryEvidence, hasAuthoritativeEvidence,
    shownEvidence, evidenceReady, authoritativeSummary, shownDrift };
}
