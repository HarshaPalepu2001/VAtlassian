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
 * Share the current record and its permissions between the issue panel and
 * review window so their change counts and decision controls agree.
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
  // Informational sections use authoritative evidence, or the previous
  // same-baseline read while its replacement loads, to avoid flashing "Checking…".
  const shownEvidence = evidence ?? heldEvidence;
  const evidenceReady = hasAuthoritativeEvidence || Boolean(evidenceError) || Boolean(heldEvidence);
  const { driftCount: evidenceDriftCount, materialCount: evidenceMaterialCount } = evidenceCounts(evidence, summary);
  // Pair permissions with the count they describe. VJIRA-17 displayed the live
  // re-diff count but used permissions derived from a stored count, causing a
  // refusal based on a different record state.
  // Use drift.eligible, which panelSummary.js computes independently of the
  // count, with the count displayed here.
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
