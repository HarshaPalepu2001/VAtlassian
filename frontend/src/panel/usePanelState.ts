import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeIssueUpdates, type RefreshOptions } from '../lib/issueUpdates';
import { invoke } from '../lib/bridge';
import { assertResult, errorMessage } from '../lib/result';
import type { PanelSummary } from './types';

/** `loud` is true while anyone waiting on this flight asked for it directly. */
type Flight = { issueKey?: string; rerun: boolean; loud: boolean; done: Promise<void> };

/**
 * THE COMPACT READ — one in-flight `panel:getSummary` request per issue.
 *
 * Concurrent triggers for the same issue (a Jira event landing right after a
 * manual Refresh, or `focus` and `visibilitychange` firing back to back)
 * coalesce onto the request already running. Any number of triggers that
 * arrive mid-flight schedule exactly one follow-up once it settles, so a
 * change made after the request was dispatched is never missed and a refresh
 * storm cannot grow.
 *
 * A different issue key is never queued behind the old one: it starts its own
 * flight at once, and `sequence` guarantees the old response — however late —
 * can never overwrite the newer result or a disposed component.
 *
 * BACKGROUND REFRESHES ARE SILENT. A refresh nobody asked for (a Jira event,
 * focus, the replica-lag follow-ups — see lib/issueUpdates.ts) that fails
 * while a summary is already on screen keeps that summary and shows nothing;
 * the next one replaces it. The first load, and any refresh a person or an
 * action started, still reports its failure. This hides no authority: every
 * decision is re-derived and re-checked server-side against current content
 * (approval.js's challenge/submit), so a summary a few seconds old can make a
 * signer retry, never sign the wrong thing.
 */
export default function usePanelState(issueKey?: string) {
  const [state, setState] = useState<PanelSummary | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const sequence = useRef(0);
  const active = useRef(false);
  const flight = useRef<Flight | null>(null);
  const hasState = useRef(false);

  const dispatch = useCallback(async (loud: () => boolean) => {
    const ticket = ++sequence.current;
    if (loud()) setRefreshing(true);
    try {
      const result = assertResult(await invoke<PanelSummary>('panel:getSummary', issueKey ? { issueKey } : {}));
      if (active.current && ticket === sequence.current) { hasState.current = true; setState(result); setError(''); }
    } catch (e) {
      if (active.current && ticket === sequence.current && (loud() || !hasState.current)) setError(errorMessage(e));
    } finally {
      if (active.current && ticket === sequence.current) setRefreshing(false);
    }
  }, [issueKey]);

  const refresh = useCallback((options?: RefreshOptions): Promise<void> => {
    const loud = options?.background !== true;
    const current = flight.current;
    if (current && current.issueKey === issueKey) {
      current.rerun = true;
      // Someone asked directly: the flight they joined reports for them.
      if (loud) current.loud = true;
      return current.done;
    }
    const mine: Flight = { issueKey, rerun: false, loud, done: Promise.resolve() };
    flight.current = mine;
    mine.done = (async () => {
      try {
        do {
          mine.rerun = false;
          await dispatch(() => mine.loud);
        } while (mine.rerun && flight.current === mine && active.current);
      } finally {
        if (flight.current === mine) flight.current = null;
      }
    })();
    return mine.done;
  }, [dispatch, issueKey]);

  useEffect(() => {
    active.current = true; hasState.current = false; setState(null); setError(''); void refresh();
    const unsubscribe = subscribeIssueUpdates(refresh);
    return () => { active.current = false; ++sequence.current; flight.current = null; unsubscribe(); };
  }, [refresh]);

  return { state, error, refresh, refreshing };
}
