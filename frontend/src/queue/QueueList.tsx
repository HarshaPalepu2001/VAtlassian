import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/bridge';
import { subscribeIssueUpdates, type RefreshOptions } from '../lib/issueUpdates';
import { recordHarnessEvent } from '../lib/harness';
import Button from '@atlaskit/button';
import { Badge, Card, EmptyState, IssueLink, Loading, Page, Table } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { formatDate, formatTimestamp, plural } from '../ui/format';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
import IssuePanel from '../panel/IssuePanel';

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
  const [expanded, setExpanded] = useState('');
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

  return (
    <Page
      eyebrow="Approval and baseline"
      title="My approvals"
      lead="Work items waiting on a decision from you, based on the approval roles you hold."
      actions={<Button isDisabled={loading} onClick={() => { recordHarnessEvent('UI', 'click:refreshQueue'); void load(); }}>Refresh</Button>}
    >
      {error && <Notice danger>{error}</Notice>}
      {loading && !items.length ? <Loading label="Finding work items that need you…" /> : (
        <Card flush>
          {!items.length ? (
            <EmptyState title="Nothing is waiting on you">
              When a signed work item changes, or a controlled transition needs approval,
              it appears here.
            </EmptyState>
          ) : (
            <Table columns={[
              { key: 'issue', label: 'Work item' },
              { key: 'status', label: 'Status' },
              { key: 'drift', label: 'Changes since approval' },
              { key: 'when', label: 'Last changed' },
              { key: 'actions', label: '', align: 'right' }
            ]}>
              {items.flatMap(item => {
                const isOpen = expanded === item.issueId;
                const rows = [
                  <tr key={item.issueId} className={isOpen ? 'va-row--open' : undefined}>
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
                    {/* Date only, with the exact time on hover. A worklist column
                        is for triage; the precise instant belongs to the signed
                        record, and spelling it out here wrapped every cell. */}
                    <td>
                      {item.lastDriftAt
                        ? <time title={formatTimestamp(item.lastDriftAt) ?? undefined}>{formatDate(item.lastDriftAt)}</time>
                        : <span className="va-muted">Not recorded</span>}
                    </td>
                    <td className="va-table__actions">
                      {/* Not primary. A column of filled blue buttons gives every
                          row the same urgency and leaves nothing for the actual
                          signing action to look more important than. */}
                      <Button onClick={() => {
                        recordHarnessEvent('UI', 'click:toggleReview', { issueKey: item.issueKey, expanded: !isOpen });
                        setExpanded(isOpen ? '' : item.issueId);
                      }}>
                        {isOpen ? 'Close' : 'Review'}
                      </Button>
                    </td>
                  </tr>
                ];
                if (isOpen) {
                  rows.push(
                    <tr key={`${item.issueId}:review`} className="va-row--expansion">
                      <td colSpan={5}>
                        <IssuePanel issueKey={item.issueKey} onDone={() => void load()} />
                      </td>
                    </tr>
                  );
                }
                return rows;
              })}
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
