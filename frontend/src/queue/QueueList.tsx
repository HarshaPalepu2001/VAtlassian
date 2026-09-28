import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/bridge';
import { subscribeIssueUpdates, type RefreshOptions } from '../lib/issueUpdates';
import { recordHarnessEvent } from '../lib/harness';
import Button from '@atlaskit/button';
import { Badge, Card, EmptyState, IssueLink, Loading, Page, Table } from '../ui/primitives';
import { Icon, Seal } from '../ui/brand';
import { openReview, type ReviewTab } from '../review/openReview';
import { Notice } from '../ui/feedback';
import { formatTimestamp, plural, relativeTime, waitingLabel } from '../ui/format';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';

type Item = {
  issueId: string;
  issueKey: string;
  summary: string;
  status: string;
  state: string;
  baselineVersion: number;
  driftCount: number;
  materialCount: number;
  lastDriftAt?: number;
  transitionName?: string | null;
  transitionLabel?: string | null;
  transitionCount?: number;
};

export default function QueueList() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [next, setNext] = useState<string | null>(null);

  const loadedOnce = useRef(false);
  // `background` is a refresh nobody asked for (lib/issueUpdates.ts): it
  // updates the list in place, without the busy state, and once the list has
  // loaded a failure is kept quiet — the next event or focus retries it.
  const load = useCallback(async (token?: string, { background = false }: RefreshOptions = {}) => {
    const quiet = background && loadedOnce.current;
    if (!quiet) { setLoading(true); setError(''); }
    try {
      const r = assertResult(await invoke<Result&{items:Item[];nextPageToken?:string|null}>('queue:list', token ? {nextPageToken: token} : {}));
      setItems(prev => token ? [...prev, ...r.items.filter(i => !prev.some(p => p.issueId === i.issueId))] : r.items);
      setNext(r.nextPageToken ?? null);
      loadedOnce.current = true;
      setError('');
      recordHarnessEvent('UI', 'queue:loaded', { itemCount: r.items?.length ?? 0 });
    } catch (e) {
      if (!quiet) setError(errorMessage(e));
      recordHarnessEvent('ERROR', 'queue:loadFailed', { background }, e);
    } finally { if (!quiet) setLoading(false); }
  }, []);

  // LIVE, LIKE THE PANEL.
  //
  // This loaded once on mount and then sat there until somebody pressed
  // Refresh, so a decision taken in the issue panel — or an edit made anywhere
  // in Jira — left this list showing work that was already done. The panel and
  // the context lozenge have subscribed to the same signals all along
  // (lib/issueUpdates.ts); the queue was the surface that never did.
  //
  // Reloading the FIRST page only is deliberate: re-requesting every page the
  // reviewer had scrolled through would reorder the list under their cursor.
  useEffect(() => {
    void load();
    return subscribeIssueUpdates(options => load(undefined, options));
  }, [load]);

  // THE SAME WINDOW AS THE PANEL. Review used to embed a whole issue panel in
  // a table row, which pushed every row below it off the screen. It now opens
  // the review window the panel opens, and the list re-reads when it closes.
  const review = (item: Item, tab: ReviewTab) => {
    recordHarnessEvent('UI', 'click:review', { issueKey: item.issueKey, tab });
    void openReview({ issueKey: item.issueKey, tab, onClose: () => void load(undefined, { background: true }) }).catch(() => {});
  };
  const now = Date.now();
  const drift = items.filter(i => i.driftCount > 0).length;
  const transitions = items.filter(i => !i.driftCount && (i.transitionCount ?? 0) > 0).length;
  const oldest = items.reduce<number | null>((min, i) => i.lastDriftAt && (min == null || i.lastDriftAt < min) ? i.lastDriftAt : min, null);
  const oldestDays = oldest == null ? 0 : Math.floor((now - oldest) / 86_400_000);

  return (
    <Page
      eyebrow="VAtlassian"
      title="My approvals"
      lead="Work items waiting on your signature, from the approval roles you hold."
      actions={<Button isDisabled={loading} onClick={() => { recordHarnessEvent('UI', 'click:refreshQueue'); void load(); }}>Refresh</Button>}
    >
      {error && <Notice danger>{error}</Notice>}
      {items.length > 0 && (
        <div className="va-tiles" role="group" aria-label="At a glance">
          <div className="va-tile"><span className="va-tile__label">Waiting on you</span><strong className="va-tile__value">{items.length}{next ? '+' : ''}</strong></div>
          <div className="va-tile"><span className="va-tile__label">Changes to decide</span><strong className="va-tile__value">{drift}</strong></div>
          <div className="va-tile"><span className="va-tile__label">Transitions to sign</span><strong className="va-tile__value">{transitions}</strong></div>
          <div className={oldestDays >= 5 ? 'va-tile va-tile--warning' : 'va-tile'}>
            <span className="va-tile__label">Oldest waiting</span>
            <strong className="va-tile__value">{oldest == null ? '—' : waitingLabel(now - oldest)}</strong>
          </div>
        </div>
      )}
      {loading && !items.length ? <Loading label="Finding work items that need you…" /> : (
        <Card flush>
          {!items.length ? (
            <EmptyState title="Nothing waits on your signature">
              <span className="va-stack va-stack--tight" style={{ alignItems: 'center' }}>
                <Seal hash="0f1e2d3c4b5a69788796a5b4c3d2e1f0" size={64} label="An untouched seal" />
                <span>When a signed work item changes, or a controlled transition needs approval, it appears here.</span>
                <span className="va-subtlest">Inbox zero, audit ready.</span>
              </span>
            </EmptyState>
          ) : (
            <Table columns={[
              { key: 'issue', label: 'Work item' },
              { key: 'status', label: 'Status' },
              { key: 'drift', label: 'Needs you for' },
              { key: 'when', label: 'Waiting' },
              { key: 'actions', label: '', align: 'right' }
            ]}>
              {items.map(item => (
                <tr key={item.issueId}>
                  <td><IssueLink issueKey={item.issueKey} summary={item.summary} /></td>
                  <td>
                    <Badge>{item.status}</Badge>
                    <div className="va-secondary">
                      {item.baselineVersion ? `Baseline version ${item.baselineVersion}` : 'No baseline yet'}
                    </div>
                  </td>
                  {/* The count leads and the qualifier follows, rather than
                      "11 changes · 3 material" — a reviewer triages on how
                      much needs deciding, not on the raw edit count. */}
                  <td>
                    {item.driftCount ? (
                      <>
                        <Badge tone={item.materialCount ? 'warning' : 'neutral'}>
                          {plural(item.driftCount, 'change')}
                        </Badge>
                        <div className="va-secondary">
                          {item.materialCount
                            ? `${plural(item.materialCount, 'change')} need${item.materialCount === 1 ? 's' : ''} a decision`
                            : 'Formatting only'}
                        </div>
                      </>
                    ) : (item.transitionCount ?? 0) > 0 ? (
                      <>
                        <Badge tone="brand">
                          {item.transitionLabel || item.transitionName || 'Approval required'}
                        </Badge>
                        <div className="va-secondary">Workflow transition</div>
                      </>
                    ) : (
                      <span className="va-muted">Up to date</span>
                    )}
                  </td>
                  {/* How long it has waited, with the exact time on hover. A
                      worklist column is for triage; the precise instant
                      belongs to the signed record. */}
                  <td>
                    {item.lastDriftAt
                      ? <time className={now - item.lastDriftAt >= 5 * 86_400_000 ? 'va-warning-text' : undefined} title={formatTimestamp(item.lastDriftAt) ?? undefined}>{relativeTime(item.lastDriftAt, now)}</time>
                      : <span className="va-muted">Not recorded</span>}
                  </td>
                  <td className="va-table__actions">
                    {/* Not primary. A column of filled blue buttons gives every
                        row the same urgency and leaves nothing for the actual
                        signing action to look more important than. */}
                    {item.driftCount > 0 && (
                      <button type="button" className="va-icon-button va-icon-button--discovery" aria-label={`AI summary for ${item.issueKey}`} title="AI summary"
                        onClick={() => review(item, 'summary')}><Icon name="sparkle" /></button>
                    )}
                    <Button onClick={() => review(item, item.driftCount ? 'changes' : 'record')}>Review</Button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      {next && (
        <div style={{ marginTop: 16 }}>
          <Button isDisabled={loading} onClick={() => load(next)}>Load more</Button>
        </div>
      )}
    </Page>
  );
}
