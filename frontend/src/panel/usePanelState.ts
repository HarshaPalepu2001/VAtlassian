import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeIssueUpdates, type RefreshOptions } from '../lib/issueUpdates';
import { invoke } from '../lib/bridge';
import { assertResult, errorMessage } from '../lib/result';
import type { PanelSummary } from './types';

/** `loud` is true while anyone waiting on this flight asked for it directly. */
type Flight = { issueKey?: string; rerun: boolean; loud: boolean; done: Promise<void> };

/**
 * Share one in-flight panel:getSummary request per issue. Concurrent triggers
 * join that request and schedule at most one follow-up. A different issue
 * starts its own request. The sequence counter prevents old responses from
 * overwriting newer results or updating a disposed component.
 *
 * A failed background refresh preserves an existing summary. First loads and
 * refreshes started by a person or action report failures. The server checks
 * every decision against current content in approval.js challenge/submit, so
 * a stale summary can require a retry but cannot authorize the wrong record.
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
