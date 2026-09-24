import { useEffect, useRef, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Textfield from '@atlaskit/textfield';

import {
  Badge, Card, EmptyState, Facts, Field, IssueLink, Name, Page, Section, Table
} from '../../ui/primitives';
import type { Tone } from '../../ui/primitives';
import { formatTimestamp, plural } from '../../ui/format';

type Issue = {
  issueId: string;
  issueKey: string;
  summary: string | null;
  statusName: string | null;
  issueTypeName: string | null;
  projectKey: string | null;
};

type LedgerEntry = {
  seq: number;
  occurredAt: number;
  actorName: string | null;
  eventType: string;
  entryHash: string;
  payload: Record<string, unknown>;
  label: string;
  tone: Tone;
  detail: string | null;
  explanation?: string;
};

type VerifyResult = {
  ok: boolean;
  checked: number;
  terminalSeq?: number;
  terminalHash?: string;
  brokenAt?: number;
  reason?: string;
};

const COLUMNS = [
  { key: 'when', label: 'When' },
  { key: 'event', label: 'Event' },
  { key: 'who', label: 'Who' },
  { key: 'detail', label: 'Detail' },
  { key: 'expand', label: '', align: 'right' as const }
];

/** The audit-relevant counts a JIRA admin actually asks for: how many times
 *  was this signed, approved, declined, rejected or blocked. Read from the
 *  issue's full ledger history server-side, not just the page on screen —
 *  see admin.js's admin:listLedger.
 *
 *  The badges must add up to the total beside them. An issue records plenty
 *  of events that belong to none of these categories — baselines captured,
 *  supersessions, first observations — and leaving them as an unexplained
 *  gap between "2 signatures" and "7 events in total" reads like a
 *  miscount. Whatever is not named above is named in `other`, which lists
 *  what it consists of. */
const NAMED_COUNTS: [key: string, noun: string, tone: (n: number) => Tone][] = [
  ['SIGNATURE_CONSUMED', 'signature', () => 'success'],
  ['CHANGE_APPROVED', 'approved change', () => 'success'],
  ['SIGNATURE_DECLINED', 'decline', n => (n > 0 ? 'danger' : 'neutral')],
  ['CHANGE_REJECTED', 'reject', n => (n > 0 ? 'danger' : 'neutral')],
  ['TRANSITION_DENIED', 'blocked attempt', n => (n > 0 ? 'danger' : 'neutral')],
  ['CONTENT_CHANGED', 'content change', n => (n > 0 ? 'warning' : 'neutral')]
];

function CountStrip({ counts }: { counts: Record<string, number> }) {
  const total = Object.values(counts).reduce((sum, c) => sum + c, 0);
  const named = new Set(NAMED_COUNTS.map(([key]) => key));
  const rest = Object.entries(counts).filter(([key, c]) => !named.has(key) && c > 0);
  const other = rest.reduce((sum, [, c]) => sum + c, 0);
  const breakdown = rest
    .map(([key, c]) => `${c} ${key.replaceAll('_', ' ').toLowerCase()}`)
    .join(', ');
  return (
    <div className="va-row" style={{ gap: '10px', flexWrap: 'wrap' }}>
      {NAMED_COUNTS.map(([key, noun, tone]) => {
        const value = counts[key] ?? 0;
        return <Badge key={key} tone={tone(value)}>{plural(value, noun)}</Badge>;
      })}
      {other > 0 && <Badge tone="neutral"><span title={breakdown}>{plural(other, 'other event')}</span></Badge>}
      <span className="va-muted" style={{ fontSize: '12px' }}>{plural(total, 'event')} recorded in total</span>
      {other > 0 && <span className="va-muted" style={{ fontSize: '12px', width: '100%' }}>{breakdown}</span>}
    </div>
  );
}

function SignaturesSummary({ summary }: { summary: any[] }) {
  if (!summary || summary.length === 0) return null;

  return (
    <div style={{ marginTop: '16px', borderTop: '1px solid var(--va-border)', paddingTop: '12px' }}>
      <h4 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--va-text-subtle)', margin: '0 0 8px 0', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Signature Log</h4>
      <ul style={{ listStyleType: 'none', padding: 0, margin: 0 }}>
        {summary.map((s, i) => {
          let actionLabel = '';
          let tone = 'var(--va-text)';
          if (s.eventType === 'SIGNATURE_CONSUMED') { actionLabel = 'Signed'; tone = 'var(--va-success)'; }
          else if (s.eventType === 'SIGNATURE_DECLINED') { actionLabel = 'Declined'; tone = 'var(--va-danger)'; }
          else if (s.eventType === 'CHANGE_REJECTED') { actionLabel = 'Rejected changes'; tone = 'var(--va-danger)'; }
          else if (s.eventType === 'CHANGE_APPROVED') { actionLabel = 'Approved changes'; tone = 'var(--va-success)'; }

          return (
            <li key={i} style={{ fontSize: '13px', marginBottom: '6px', lineHeight: '1.4' }}>
              <strong style={{ color: 'var(--va-text)' }}>{s.actorName || 'Unknown'}</strong>{' '}
              <span style={{ color: tone, fontWeight: 500 }}>{actionLabel}</span>{' '}
              {s.payload?.meaning ? `— ${s.payload.meaning}` : ''}
              <span className="va-muted" style={{ marginLeft: '8px', fontSize: '12px' }}>
                {formatTimestamp(s.occurredAt)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function VerifyPanel() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ result?: VerifyResult; empty?: boolean; windowFrom?: number; windowTo?: number; error?: string } | null>(null);

  const run = async () => {
    setChecking(true);
    setResult(null);
    try {
      const response = await invoke('admin:verifyLedger', { windowSize: 2000 }) as any;
      if (response.success) setResult(response);
      else setResult({ error: response.error || 'Verification failed.' });
    } catch (err: any) {
      setResult({ error: err.message || 'Verification failed.' });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card
      title="Chain integrity"
      subtitle="Walks the hash chain and reports the first break, if any — the discern-tampering guarantee 21 CFR 11.10(a) asks for."
    >
      <div className="va-row" style={{ justifyContent: 'space-between' }}>
        <Button appearance="primary" onClick={run} isDisabled={checking}>
          {checking ? 'Verifying…' : 'Verify recent ledger'}
        </Button>
        {result?.windowFrom != null && result?.windowTo != null && (
          <span className="va-hint">Checked entries {result.windowFrom.toLocaleString()}–{result.windowTo.toLocaleString()}</span>
        )}
      </div>

      {result?.error && (
        <div style={{ marginTop: '14px' }}>
          <SectionMessage appearance="error"><p>{result.error}</p></SectionMessage>
        </div>
      )}
      {result?.empty && (
        <div style={{ marginTop: '14px' }}>
          <SectionMessage appearance="information"><p>The ledger has no entries yet.</p></SectionMessage>
        </div>
      )}
      {result?.result && (
        <div style={{ marginTop: '14px' }}>
          <SectionMessage appearance={result.result.ok ? 'success' : 'error'}>
            {result.result.ok ? (
              <p>Verified {plural(result.result.checked, 'entry', 'entries')}. Every hash chains to the one before it — nothing in this window has been altered or removed.</p>
            ) : (
              <p>
                Chain break at seq {result.result.brokenAt} ({result.result.reason}). Treat every entry from that point on
                as unverified evidence and escalate — a hash-chained ledger cannot repair itself, only detect this.
              </p>
            )}
          </SectionMessage>
        </div>
      )}
    </Card>
  );
}

function EntryRow({ entry }: { entry: LedgerEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className={open ? 'va-row--open' : undefined}>
        <td className="va-muted">{formatTimestamp(entry.occurredAt)}</td>
        <td><Badge tone={entry.tone}>{entry.label}</Badge></td>
        <td><Name value={entry.actorName} noun="actor" /></td>
        <td className="va-primary">{entry.detail ?? <span className="va-muted">—</span>}</td>
        <td className="va-table__actions">
          <Button appearance="subtle" spacing="compact" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Details'}
          </Button>
        </td>
      </tr>
      {open && (
        <tr className="va-row--expansion">
          <td colSpan={COLUMNS.length} style={{ padding: '16px 20px' }}>
            {entry.explanation && <p style={{ margin: '0 0 12px', fontSize: '13px' }}>{entry.explanation}</p>}
            <Facts
              items={[
                { label: 'Sequence', value: entry.seq },
                { label: 'Entry hash', value: <span className="va-secondary" style={{ fontFamily: 'var(--va-font-mono)' }}>{entry.entryHash}</span> },
                ...(Object.keys(entry.payload ?? {}).length > 0
                  ? [{ label: 'Recorded payload', value: (
                      <pre style={{ margin: 0, fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {JSON.stringify(entry.payload, null, 2)}
                      </pre>
                    ) }]
                  : [])
              ]}
            />
          </td>
        </tr>
      )}
    </>
  );
}

export default function LedgerPage() {
  const [issueKeyInput, setIssueKeyInput] = useState('');
  const [staleView, setStaleView] = useState(false);
  const [searching, setSearching] = useState(true);
  const [queryKey, setQueryKey] = useState<string | null>(null);
  const sequence = useRef(0);
  const [message, setMessage] = useState<{ type: 'error' | 'information'; text: string } | null>(null);

  const [issue, setIssue] = useState<Issue | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [signaturesSummary, setSignaturesSummary] = useState<any[]>([]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextBeforeSeq, setNextBeforeSeq] = useState<number | null>(null);
  const [scoped, setScoped] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const runQuery = async (issueKey: string | null, beforeSeq: number | null, append: boolean) => {
    const seq = ++sequence.current;
    if (append) setLoadingMore(true);
    else { setSearching(true); setQueryKey(issueKey); setEntries([]); setIssue(null); setCounts(null); setSignaturesSummary([]); }
    setHasMore(false); setMessage(null); setStaleView(false);
    try {
      const response = await invoke('admin:listLedger', { issueKey: issueKey ?? undefined, beforeSeq: beforeSeq ?? undefined }) as any;
      if (seq !== sequence.current) return;
      if (!response.success) throw new Error(response.error || 'Failed to load the ledger.');
      setIssue(response.issue ?? null); setCounts(response.counts ?? null);
      if (!append) setSignaturesSummary(response.signaturesSummary ?? []);
      setEntries(prev => append ? [...prev, ...response.entries] : response.entries);
      setHasMore(response.hasMore === true); setNextBeforeSeq(response.nextBeforeSeq ?? null);
    } catch (e) {
      if (seq !== sequence.current) return;
      setHasMore(false); setNextBeforeSeq(null);
      setMessage({type:'error',text:e instanceof Error ? e.message : 'Failed to load the ledger.'});
    } finally {
      if (seq === sequence.current) { setSearching(false); setLoadingMore(false); }
    }
  };

  // Recent activity across the site, on first load — before an admin has
  // typed anything an empty issue-lookup panel would otherwise look broken.
  useEffect(() => {
    void runQuery(null, null, false);
    return () => { ++sequence.current; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = async () => {
    if (searching || loadingMore) return;
    const key = issueKeyInput.trim(); setScoped(key.length > 0);
    await runQuery(key || null, null, false);
  };
  const handleClear = async () => {
    if (searching || loadingMore) return;
    setIssueKeyInput(''); setScoped(false); await runQuery(null, null, false);
  };
  const handleLoadMore = async () => {
    if (searching || loadingMore) return;
    await runQuery(queryKey, nextBeforeSeq, true);
  };

  // Ledger sequence numbers only increase and rows are never deleted, so a
  // head above the newest entry on screen means activity was recorded after
  // this view loaded.
  //
  // Checked when the reader comes back to the tab, never on a timer: this app
  // does not poll (frontend/test/panel.test.mjs enforces that), and an admin
  // page left open in a background tab should cost nothing.
  //
  // It is announced, not applied. Re-ordering rows under somebody reading an
  // audit record is how a reader loses their place, so an evidence view
  // changes only when its reader asks it to. A failed check leaves the view
  // alone rather than implying it is current.
  useEffect(() => {
    let active = true;
    const check = async () => {
      if (!active || document.visibilityState === 'hidden') return;
      if (searching || loadingMore || staleView) return;
      try {
        const head = await invoke('admin:ledgerHead', { issueId: issue?.issueId ?? undefined }) as any;
        if (!active || !head?.success) return;
        const newest = entries.length ? Math.max(...entries.map(e => Number(e.seq) || 0)) : 0;
        if (Number(head.maxSeq) > newest) setStaleView(true);
      } catch { /* left for the next return; never reported as up to date */ }
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [searching, loadingMore, staleView, issue?.issueId, entries]);

  return (
    <Page
      eyebrow="Evidence"
      title="Audit ledger"
      lead="Every signature, decline, blocked attempt, content change and configuration edit, in one hash-chained record. Look up a work item to see its full history in order, or browse recent activity across the site."
    >
      {message && (
        <div style={{ marginBottom: '20px' }}>
          <SectionMessage appearance={message.type}><p>{message.text}</p><Button isDisabled={searching||loadingMore} onClick={()=>runQuery(queryKey,null,false)}>Retry loading ledger</Button></SectionMessage>
        </div>
      )}
      {staleView && (
        <div style={{ marginBottom: '20px' }}>
          <SectionMessage appearance="information">
            <p>New activity has been recorded since this view loaded. The record below is unchanged until you refresh it.</p>
            <Button isDisabled={searching || loadingMore} onClick={() => runQuery(queryKey, null, false)}>Refresh</Button>
          </SectionMessage>
        </div>
      )}

      <Card title="Look up a work item">
        <div className="va-row" style={{ alignItems: 'flex-end', gap: '12px' }}>
          <div style={{ minWidth: '220px' }}>
            <Field label="Issue key" hint="e.g. AUT-142">
              <Textfield
                placeholder="AUT-142"
                value={issueKeyInput}
                onChange={(e: any) => setIssueKeyInput(e.target.value.toUpperCase())}
                onKeyDown={(e: any) => { if (e.key === 'Enter') handleSearch(); }}
              />
            </Field>
          </div>
          <Button appearance="primary" onClick={handleSearch} isDisabled={searching || loadingMore || !issueKeyInput.trim()}>
            {searching ? 'Searching…' : 'Show history'}
          </Button>
          {scoped && <Button appearance="subtle" onClick={handleClear} isDisabled={searching||loadingMore}>Clear</Button>}
        </div>
      </Card>

      {issue && (
        <div style={{ marginTop: '20px' }}>
          <Card>
            <div className="va-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
              <div>
                <div className="va-primary" style={{ fontSize: '15px' }}>
                  <IssueLink issueKey={issue.issueKey} summary={issue.summary} />
                </div>
                <div className="va-secondary">
                  <Name value={issue.issueTypeName} noun="work item type" /> · currently <Name value={issue.statusName} noun="status" />
                </div>
              </div>
              {counts && <CountStrip counts={counts} />}
            </div>
            {signaturesSummary && signaturesSummary.length > 0 && <SignaturesSummary summary={signaturesSummary} />}
          </Card>
        </div>
      )}

      <Section title={scoped ? `History for ${issue?.issueKey ?? queryKey}` : 'Recent activity, most recent first'}>
        <Card flush>
          {searching ? <EmptyState title="Loading ledger…" /> : message ? <EmptyState title="Ledger unavailable" /> : entries.length === 0 ? (
            <EmptyState title={scoped ? 'No ledger entries for this work item' : 'Nothing recorded yet'}>
              {scoped
                ? 'Either this work item has never come under a controlled transition, or the key does not exist.'
                : 'Signatures, declines and configuration changes will appear here as they happen.'}
            </EmptyState>
          ) : (
            <Table columns={COLUMNS}>
              {entries.map((entry) => <EntryRow key={entry.seq} entry={entry} />)}
            </Table>
          )}
        </Card>
        {hasMore && (
          <div style={{ marginTop: '12px', textAlign: 'center' }}>
            <Button appearance="subtle" onClick={handleLoadMore} isDisabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </Section>

      <Section title="Verification">
        <VerifyPanel />
      </Section>
    </Page>
  );
}
