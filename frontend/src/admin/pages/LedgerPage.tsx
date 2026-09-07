import { useEffect, useState } from 'react';
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
 *  was this signed, how many times was signing declined or blocked. Read
 *  from the issue's full ledger history server-side, not just the page on
 *  screen — see admin.js's admin:listLedger. */
function CountStrip({ counts }: { counts: Record<string, number> }) {
  const signed = counts['SIGNATURE_CONSUMED'] ?? 0;
  const declined = counts['SIGNATURE_DECLINED'] ?? 0;
  const denied = counts['TRANSITION_DENIED'] ?? 0;
  const changed = counts['CONTENT_CHANGED'] ?? 0;
  const rejects = counts['CHANGE_REJECTED'] ?? 0;
  const total = Object.values(counts).reduce((sum, c) => sum + c, 0);
  return (
    <div className="va-row" style={{ gap: '10px', flexWrap: 'wrap' }}>
      <Badge tone="success">{plural(signed, 'signature')}</Badge>
      <Badge tone={declined > 0 ? 'danger' : 'neutral'}>{plural(declined, 'decline')}</Badge>
      <Badge tone={rejects > 0 ? 'danger' : 'neutral'}>{plural(rejects, 'reject')}</Badge>
      <Badge tone={denied > 0 ? 'danger' : 'neutral'}>{plural(denied, 'blocked attempt')}</Badge>
      <Badge tone={changed > 0 ? 'warning' : 'neutral'}>{plural(changed, 'content change')}</Badge>
      <span className="va-muted" style={{ fontSize: '12px' }}>{plural(total, 'event')} recorded in total</span>
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
  const [searching, setSearching] = useState(false);
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
    const response = await invoke('admin:listLedger', {
      issueKey: issueKey ?? undefined,
      beforeSeq: beforeSeq ?? undefined
    }) as any;

    if (!response.success) {
      setMessage({ type: 'error', text: response.error || 'Failed to load the ledger.' });
      if (!append) { setEntries([]); setIssue(null); setCounts(null); setSignaturesSummary([]); }
      return;
    }

    setMessage(null);
    setIssue(response.issue ?? null);
    setCounts(response.counts ?? null);
    if (!append && response.signaturesSummary) setSignaturesSummary(response.signaturesSummary);
    setEntries((prev) => (append ? [...prev, ...response.entries] : response.entries));
    setHasMore(response.hasMore);
    setNextBeforeSeq(response.nextBeforeSeq);
  };

  // Recent activity across the site, on first load — before an admin has
  // typed anything an empty issue-lookup panel would otherwise look broken.
  useEffect(() => {
    runQuery(null, null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = async () => {
    const key = issueKeyInput.trim();
    setSearching(true);
    setScoped(key.length > 0);
    try {
      await runQuery(key || null, null, false);
    } finally {
      setSearching(false);
    }
  };

  const handleClear = async () => {
    setIssueKeyInput('');
    setScoped(false);
    setSearching(true);
    try {
      await runQuery(null, null, false);
    } finally {
      setSearching(false);
    }
  };

  const handleLoadMore = async () => {
    setLoadingMore(true);
    try {
      await runQuery(scoped ? issue?.issueKey ?? issueKeyInput.trim() : null, nextBeforeSeq, true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Page
      eyebrow="Evidence"
      title="Audit ledger"
      lead="Every signature, decline, blocked attempt, content change and configuration edit, in one hash-chained record. Look up a work item to see its full history in order, or browse recent activity across the site."
    >
      {message && (
        <div style={{ marginBottom: '20px' }}>
          <SectionMessage appearance={message.type}><p>{message.text}</p></SectionMessage>
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
          <Button appearance="primary" onClick={handleSearch} isDisabled={searching || !issueKeyInput.trim()}>
            {searching ? 'Searching…' : 'Show history'}
          </Button>
          {scoped && <Button appearance="subtle" onClick={handleClear} isDisabled={searching}>Clear</Button>}
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

      <Section title={scoped ? `History for ${issue?.issueKey ?? issueKeyInput.trim()}` : 'Recent activity, most recent first'}>
        <Card flush>
          {entries.length === 0 ? (
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
