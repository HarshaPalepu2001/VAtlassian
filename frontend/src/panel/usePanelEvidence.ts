import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/bridge';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
import type { PanelEvidence } from './types';

type Options = {
  issueKey?: string;
  /** Stable record identity for the current baseline evidence read. */
  actionId: string;
  /** The summary's latest baseline version; null when there is no baseline. */
  baselineVersion: number | null;
  baselineId?: string | null;
  /** The review row version from the compact summary; advances on same-baseline drift updates. */
  evidenceVersion?: number | null;
  /** The tracked content's own hash. Moves on every edit, including ones the
   *  collector has not recorded yet, so the diff never lags the summary. */
  contentHash?: string | null;
  enabled: boolean;
  /** Called when evidence proves the summary's baseline is no longer current. */
  onStale?: () => void | Promise<void>;
};

type Loaded = { cacheKey: string; evidence: PanelEvidence | null; loading: boolean; error: string };

export const STALE_EVIDENCE_MESSAGE = 'The evidence changed while it was loading. Reload it to see the current baseline.';

/**
 * Read panel:getEvidence once for the current record and baseline id/version.
 * Workflow action selection does not create a separate evidence read.
 * Sequence checks discard late responses for old keys.
 *
 * Discard STALE_EVIDENCE and mismatched versions before display. onStale
 * refreshes the summary to obtain the current baseline. If the refreshed
 * summary still has the same key, stop with an error and manual retry.
 */
export default function usePanelEvidence({ issueKey, actionId, baselineVersion, baselineId = null, evidenceVersion = null, contentHash = null, enabled, onStale }: Options) {
  const cacheKey = baselineVersion == null ? null : `${actionId}::${baselineVersion}::${baselineId ?? ''}::${evidenceVersion ?? ''}::${contentHash ?? ''}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The last evidence that loaded cleanly, and the baseline it was read
  // against. Display-only: see `heldEvidence` below.
  const lastGood = useRef<{ baselineVersion: number; baselineId: string | null; evidence: PanelEvidence } | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const staleKeys = useRef(new Set<string>());
  const onStaleRef = useRef(onStale);
  useEffect(() => { onStaleRef.current = onStale; }, [onStale]);

  const load = useCallback(async () => {
    if (baselineVersion == null || cacheKey == null) return;
    const ticket = ++sequence.current;
    staleKeys.current.delete(cacheKey);
    setLoaded({ cacheKey, evidence: null, loading: true, error: '' });
    try {
      const raw = await invoke<PanelEvidence & Result>('panel:getEvidence', {
        issueKey,
        expectedBaselineVersion: baselineVersion,
        ...(baselineId ? { expectedBaselineId: baselineId } : {})
      });
      if (!mounted.current || ticket !== sequence.current) return;
      const otherBaseline = !!raw && !raw.error && (Number(raw.baselineVersion) !== baselineVersion
        || (!!baselineId && !!raw.baselineId && raw.baselineId !== baselineId));
      if (raw?.reason === 'STALE_EVIDENCE' || otherBaseline) {
        staleKeys.current.add(cacheKey);
        setLoaded({ cacheKey, evidence: null, loading: false, error: STALE_EVIDENCE_MESSAGE });
        void onStaleRef.current?.();
        return;
      }
      const evidence = assertResult(raw ?? ({ error: 'The evidence could not be loaded.' } as PanelEvidence & Result));
      lastGood.current = { baselineVersion, baselineId, evidence };
      setLoaded({ cacheKey, evidence, loading: false, error: '' });
    } catch (e) {
      if (mounted.current && ticket === sequence.current) setLoaded({ cacheKey, evidence: null, loading: false, error: errorMessage(e) });
    }
  }, [issueKey, cacheKey, baselineVersion, baselineId]);

  useEffect(() => {
    if (enabled && cacheKey && !staleKeys.current.has(cacheKey)) void load();
    return () => { ++sequence.current; };
  }, [enabled, cacheKey, load]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const retry = useCallback(() => { void load(); }, [load]);
  const current = loaded && loaded.cacheKey === cacheKey ? loaded : null;
  const loading = current ? current.loading : enabled && cacheKey != null;
  // Keep the previous same-baseline read visible while contentHash changes and
  // replacement evidence loads. This is display-only. Decisions must wait for
  // the authoritative evidence. A different baseline or failed read gets no
  // fallback.
  const held = lastGood.current;
  const heldEvidence = loading && !current?.evidence && held
    && held.baselineVersion === baselineVersion && held.baselineId === baselineId
    ? held.evidence : null;
  return {
    evidence: current?.evidence ?? null,
    heldEvidence,
    loading,
    error: current?.error ?? '',
    retry
  };
}
