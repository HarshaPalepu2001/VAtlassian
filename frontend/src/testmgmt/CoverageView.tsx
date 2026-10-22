import { useEffect, useState } from 'react';
import { invoke } from '../lib/bridge';
import { Badge, EmptyState, Section } from '../ui/primitives';
import { Notice } from '../ui/feedback';

export type SourceReference = { issueId: string; issueKey: string; projectId: string; siteId: string; sourceDigest: string;
  linkTypeId?: string | null;
  baseline: { id: string; version: number; hash: string } | null; governedReady?: boolean; drifted?: boolean };
export type CoverageRow = { test: { id: string; key: string; summary: string }; source: SourceReference | null;
  runId: string | null; testVersionId: string; configuration: string; environment: string; release: { id: string; name: string } | null;
  state: string; result: string; operational: string; governed: string; suspect: boolean; reasons: string[] };
export type CoverageModel = { scope: 'TEST' | 'SOURCE'; issue: { id: string; key: string; summary: string };
  complete: boolean; problems: string[]; rows: CoverageRow[] };
type Failure = { error?: string; reason?: string };
const words = (value: string) => value.toLowerCase().replaceAll('_', ' ');
const tone = (value: string) => value === 'VERIFIED' ? 'success' as const : value === 'UNKNOWN' ? 'warning' as const : 'neutral' as const;
const reasonText: Record<string, string> = {
  SOURCE_CHANGED: 'The source changed after this test version was signed.', SOURCE_DRIFT: 'The source has changes awaiting approval.',
  TEST_CHANGED: 'The test definition changed; this result needs a new signed version and run.',
  SOURCE_UNAVAILABLE: 'A source is unavailable to you.', SOURCE_NOT_PINNED: 'This version has no complete signed source reference.',
  NO_SOURCE_ASSOCIATION: 'No source was included in the signed version.', RUN_LIST_INCOMPLETE: 'The run list is incomplete.',
  EVIDENCE_UNAVAILABLE: 'Evidence could not be verified.', SIGNATURE_PROOF_INCOMPLETE: 'Sign-off proof is incomplete.',
  UNRESOLVED_BLOCKING_DEFECT: 'A blocking defect is unresolved.', DEFECT_STATUS_UNAVAILABLE: 'Defect status could not be verified.',
  EXECUTION_UNAVAILABLE: 'An execution is unavailable to you.', TEST_UNAVAILABLE: 'A test is unavailable to you.',
  PLAN_CHANGED: 'The plan changed after this run was created.', DATASET_CHANGED: 'The dataset changed after this run was created.',
  SOURCE_ASSOCIATIONS_INCOMPLETE: 'Signed source associations are incomplete.',
  SOURCE_LINK_PROOF_UNAVAILABLE: 'Governed coverage needs a complete matching Jira Verifies link projection.'
};

export default function CoverageView({ issueKey, scope = 'TEST', initialModel }: { issueKey: string; scope?: 'TEST' | 'SOURCE'; initialModel?: CoverageModel }) {
  const [model, setModel] = useState<CoverageModel | null>(initialModel ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true; setBusy(true); setModel(null);
    invoke<CoverageModel & Failure>(scope === 'SOURCE' ? 'tm:coverage:source' : 'tm:coverage:test', { issueKey }).then(result => {
      if (!active) return;
      if (result.error) { setError(result.error); setModel(null); } else { setModel(result); setError(null); }
    }).catch(() => { if (active) { setError('Coverage could not be loaded.'); setModel(null); } }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [issueKey, scope]);
  return <Section title="Source coverage">
    {busy && <p role="status">Checking the latest results and signed sources…</p>}
    {error && <Notice danger>{error}</Notice>}
    {model && <>
      {!model.complete && <Notice danger>This view is incomplete. Unavailable records cannot count as verified.</Notice>}
      <p className="va-subtlest">Operational coverage uses signed test results. Governed coverage also requires a current approved source baseline. Each row uses the latest terminal run for its configuration, release and environment.</p>
      {model.rows.length === 0 && <EmptyState title="No coverage records">Add source references to a signed test version, then execute it.</EmptyState>}
      {model.rows.map((row, index) => <div className="va-card" style={{ padding: 12, marginBottom: 8 }} key={`${row.runId ?? 'none'}-${row.source?.issueId ?? 'hidden'}-${index}`}>
        <p><strong>{row.test.key}</strong>{' → '}{row.source?.issueKey ?? 'Source unavailable or not associated'}{' '}{row.suspect && <Badge tone="warning">Suspect</Badge>}</p>
        <p style={{ fontSize: 12 }}>{[row.configuration, row.release?.name, row.environment].filter(Boolean).join(' · ') || 'No execution context'}{row.source?.baseline ? ` · source baseline v${row.source.baseline.version}` : ' · no source baseline'}</p>
        <p>Operational: <Badge tone={tone(row.operational)}>{words(row.operational)}</Badge>{' '}Governed: <Badge tone={tone(row.governed)}>{words(row.governed)}</Badge></p>
        <p style={{ fontSize: 12 }}>{words(row.state)} · {words(row.result)}{row.runId ? ` · run ${row.runId.slice(0, 8)}` : ''}</p>
        {row.reasons.length > 0 && <ul>{row.reasons.map(reason => <li key={reason}>{reasonText[reason] ?? words(reason)}</li>)}</ul>}
      </div>)}
      {model.problems.length > 0 && model.rows.length === 0 && <Notice>{model.problems.map(reason => reasonText[reason] ?? words(reason)).join(' ')}</Notice>}
    </>}
  </Section>;
}

/** The authoring form receives server-resolved references, never client-generated digests or baseline identities. */
export function SourceSelection({ issueKey, references, onChange, disabled = false }: {
  issueKey: string; references: SourceReference[]; onChange: (references: SourceReference[]) => void; disabled?: boolean;
}) {
  const [sourceKey, setSourceKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true); setError(null);
    try {
      const result = await invoke<{ sources: SourceReference[] } & Failure>('tm:sources:resolve', { issueKey, sourceKey: sourceKey.trim() });
      if (result.error) setError(result.error);
      else { onChange([...references, ...result.sources.filter(source => !references.some(prior => prior.issueId === source.issueId))]); setSourceKey(''); }
    } catch { setError('The source could not be read.'); } finally { setBusy(false); }
  };
  return <div>
    {error && <Notice danger>{error}</Notice>}
    <p className="va-subtlest">Source references are approved with this test version. Updating a test's references leaves the source's baseline unchanged.</p>
    {references.map(source => <p key={source.issueId}>{source.issueKey}{source.baseline ? ` · baseline v${source.baseline.version}` : ' · operational source'}{' '}
      <button className="va-button" disabled={disabled || busy} onClick={() => onChange(references.filter(ref => ref.issueId !== source.issueId))}>Remove</button></p>)}
    <div className="va-row" style={{ gap: 8 }}>
      <label className="va-field"><span className="va-label">Source work item key</span><input className="va-input" value={sourceKey} disabled={disabled || busy}
        placeholder="e.g. VAT-21" onChange={event => setSourceKey(event.target.value.toUpperCase())} /></label>
      <button className="va-button" disabled={disabled || busy || !sourceKey.trim() || references.length >= 50} onClick={add}>Add source</button>
    </div>
  </div>;
}
