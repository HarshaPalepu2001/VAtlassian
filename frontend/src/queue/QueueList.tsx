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

/** What a work item needs from this reviewer (src/usecases/queue.js). */
type Kind = 'CHANGES' | 'RESTORE' | 'TRANSITION';

type Item = {
  issueId: string;
  issueKey: string;
  summary: string;
  status: string;
  state: string;
  baselineVersion: number;
  driftCount: number;
  materialCount: number;
  lastDriftAt?: number | null;
  transitionName?: string | null;
  transitionLabel?: string | null;
  transitionCount?: number;
  kind?: Kind;
  /** When this started waiting on a decision; null when it is not recorded. */
  waitingSince?: number | null;
  note?: 'LINK_RECORDING' | 'DECISION_INCOMPLETE' | null;
  restoreId?: string;
  restoreState?: string;
  /** Only the reviewer who rejected may retry a restore. */
  canRetry?: boolean;
  /** Signed already; Jira refused the move. */
  pendingMove?: boolean;
};

/** Items from before the server named their kind still sort into a section. */
const kindOf = (item: Item): Kind => item.kind ?? (item.driftCount > 0 ? 'CHANGES' : 'TRANSITION');
const waitingSince = (item: Item) => item.waitingSince !== undefined ? item.waitingSince : item.lastDriftAt ?? null;

/** Most urgent first: a changed item is held by Jira on every move until it is decided. */
const SECTIONS: { kind: Kind; title: string; subtitle: string }[] = [
  { kind: 'CHANGES', title: 'Changes to decide',
    subtitle: 'Signed work items edited since approval. Jira holds each one until the changes are approved or rejected.' },
  { kind: 'RESTORE', title: 'Restores to finish',
    subtitle: 'Rejected changes that were not fully put back.' },
  { kind: 'TRANSITION', title: 'Transitions to sign',
    subtitle: 'Controlled workflow moves your role can approve.' }
];

const NOTE: Record<string, string> = {
  LINK_RECORDING: 'A linked work item\'s approval is being recorded here.',
  DECISION_INCOMPLETE: 'The last decision on this work item did not finish. Review it and decide again.'
};

export default function QueueList() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [next, setNext] = useState<string | null>(null);
  const [retrying, setRetrying] = useState('');

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

  // THE SAME WINDOW AS THE PANEL. Review opens the review window the panel
  // opens, and the list re-reads when it closes.
  const review = (item: Item, tab: ReviewTab) => {
    recordHarnessEvent('UI', 'click:review', { issueKey: item.issueKey, tab });
    void openReview({ issueKey: item.issueKey, tab, onClose: () => void load(undefined, { background: true }) }).catch(() => {});
  };

  // A restore the reviewer rejected is retried from here, as on the panel.
  async function retry(item: Item) {
    if (!item.restoreId || retrying) return;
    recordHarnessEvent('RESTORE', 'click:retryRestore', { issueKey: item.issueKey, restoreId: item.restoreId, surface: 'queue' });
    setRetrying(item.issueId); setError('');
    try {
      assertResult(await invoke<Result>('restore:retry', { issueKey: item.issueKey, restoreId: item.restoreId }));
      await load(undefined, { background: true });
    } catch (e) {
      setError(errorMessage(e));
      recordHarnessEvent('ERROR', 'retryRestore:failed', { issueKey: item.issueKey, surface: 'queue' }, e);
    } finally { setRetrying(''); }
  }

  const now = Date.now();
  const count = (kind: Kind) => items.filter(i => kindOf(i) === kind).length;
  const oldest = items.reduce<number | null>((min, i) => {
    const at = waitingSince(i);
    return at && (min == null || at < min) ? at : min;
  }, null);
  const oldestDays = oldest == null ? 0 : Math.floor((now - oldest) / 86_400_000);

  return (
    <Page
      eyebrow="VAtlassian"
      title="My approvals"
      lead="Everything waiting on you, from the approval roles you hold: changes to decide, restores to finish and transitions to sign."
      actions={<Button isDisabled={loading} onClick={() => { recordHarnessEvent('UI', 'click:refreshQueue'); void load(); }}>Refresh</Button>}
    >
      {error && <Notice danger>{error}</Notice>}
      {items.length > 0 && (
        <div className="va-tiles" role="group" aria-label="At a glance">
          <div className="va-tile"><span className="va-tile__label">Waiting on you</span><strong className="va-tile__value">{items.length}{next ? '+' : ''}</strong></div>
          <div className="va-tile"><span className="va-tile__label">Changes to decide</span><strong className="va-tile__value">{count('CHANGES')}</strong></div>
          <div className="va-tile"><span className="va-tile__label">Restores to finish</span><strong className="va-tile__value">{count('RESTORE')}</strong></div>
          <div className="va-tile"><span className="va-tile__label">Transitions to sign</span><strong className="va-tile__value">{count('TRANSITION')}{next ? '+' : ''}</strong></div>
          <div className={oldestDays >= 5 ? 'va-tile va-tile--warning' : 'va-tile'}>
            <span className="va-tile__label">Oldest waiting</span>
            <strong className="va-tile__value">{oldest == null ? '—' : waitingLabel(now - oldest)}</strong>
          </div>
        </div>
      )}
      {loading && !items.length ? <Loading label="Finding work items that need you…" /> : !items.length ? (
        // Nothing yet, but the search stopped short: never claim the list is
        // empty while there is more to look through.
        next ? (
          <Card>
            <p className="va-secondary">Nothing for you in the work items searched so far. There are more to search.</p>
          </Card>
        ) : (
          <Card flush>
            <EmptyState title="Nothing waits on your signature">
              <span className="va-stack va-stack--tight" style={{ alignItems: 'center' }}>
                <Seal hash="0f1e2d3c4b5a69788796a5b4c3d2e1f0" size={64} label="An untouched seal" />
                <span>When a signed work item changes, a restore needs finishing, or a controlled transition needs approval, it appears here.</span>
                <span className="va-subtlest">Inbox zero, audit ready.</span>
              </span>
            </EmptyState>
          </Card>
        )
      ) : SECTIONS.filter(section => count(section.kind) > 0).map(section => (
        <div key={section.kind} style={{ marginBottom: 16 }}>
          <Card flush title={section.title} subtitle={section.subtitle}>
            <Table columns={[
              { key: 'issue', label: 'Work item' },
              { key: 'status', label: 'Status' },
              { key: 'need', label: 'Needs you for' },
              { key: 'when', label: 'Waiting' },
              { key: 'actions', label: '', align: 'right' }
            ]}>
              {items.filter(item => kindOf(item) === section.kind).map(item => (
                <Row key={item.issueId} item={item} now={now} retrying={retrying === item.issueId}
                  onReview={tab => review(item, tab)} onRetry={() => void retry(item)} />
              ))}
            </Table>
          </Card>
        </div>
      ))}
      {next && (
        <div style={{ marginTop: 16 }}>
          <Button isDisabled={loading} onClick={() => load(next)}>{items.length ? 'Load more' : 'Keep looking'}</Button>
        </div>
      )}
    </Page>
  );
}

function Row({ item, now, retrying, onReview, onRetry }: { item: Item; now: number; retrying: boolean;
  onReview: (tab: ReviewTab) => void; onRetry: () => void }) {
  const kind = kindOf(item);
  const since = waitingSince(item);
  return (
    <tr>
      <td><IssueLink issueKey={item.issueKey} summary={item.summary} /></td>
      <td>
        <Badge>{item.status}</Badge>
        <div className="va-secondary">
          {item.baselineVersion ? `Baseline version ${item.baselineVersion}` : 'No baseline yet'}
        </div>
      </td>
      <td><Need item={item} kind={kind} /></td>
      {/* How long it has waited, with the exact time on hover. A worklist
          column is for triage; the precise instant belongs to the record. */}
      <td>
        {since
          ? <time className={now - since >= 5 * 86_400_000 ? 'va-warning-text' : undefined} title={formatTimestamp(since) ?? undefined}>{relativeTime(since, now)}</time>
          : <span className="va-muted">Not recorded</span>}
      </td>
      <td className="va-table__actions">
        {/* Not primary. A column of filled blue buttons gives every row the
            same urgency and leaves nothing for the signing action to look more
            important than. */}
        {kind === 'CHANGES' && item.driftCount > 0 && (
          <button type="button" className="va-icon-button va-icon-button--discovery" aria-label={`AI summary for ${item.issueKey}`} title="AI summary"
            onClick={() => onReview('summary')}><Icon name="sparkle" /></button>
        )}
        {kind === 'RESTORE' && item.canRetry && (
          <Button isDisabled={retrying} onClick={onRetry}>{retrying ? 'Retrying…' : 'Retry restore'}</Button>
        )}
        <Button onClick={() => onReview(kind === 'TRANSITION' ? 'record' : 'changes')}>Review</Button>
      </td>
    </tr>
  );
}

/** What the reviewer is being asked for: the count leads, the qualifier follows. */
function Need({ item, kind }: { item: Item; kind: Kind }) {
  const note = item.note ? NOTE[item.note] : null;
  if (kind === 'RESTORE') {
    return <>
      <Badge tone="danger">Restore didn't finish</Badge>
      <div className="va-secondary">
        {item.canRetry
          ? 'You rejected these changes. Retry the restore, or decide again.'
          : 'Only the reviewer who rejected can retry it. You can approve or reject the changes again.'}
      </div>
    </>;
  }
  if (kind === 'TRANSITION') {
    return <>
      <Badge tone="brand">{item.transitionLabel || item.transitionName || 'Approval required'}</Badge>
      <div className="va-secondary">{item.pendingMove ? 'Approved — retry the move' : 'Workflow transition'}</div>
    </>;
  }
  return <>
    {item.driftCount > 0 && (
      <Badge tone={item.materialCount ? 'warning' : 'neutral'}>{plural(item.driftCount, 'change')}</Badge>
    )}
    {item.driftCount > 0 && (
      <div className="va-secondary">
        {item.materialCount
          ? `${plural(item.materialCount, 'change')} need${item.materialCount === 1 ? 's' : ''} a decision`
          : 'Formatting only'}
      </div>
    )}
    {note && <div className="va-secondary">{note}</div>}
    {!item.driftCount && !note && <span className="va-muted">Changes to review</span>}
  </>;
}
