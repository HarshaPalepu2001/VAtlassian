import { useState } from 'react';
import { invoke } from '../lib/bridge';
import { Badge, Section } from '../ui/primitives';
import { Notice } from '../ui/feedback';

export type SummaryDownload = { filename: string; mimeType: string; content: string };
export type ExecutionSummaryModel = { summaryId: string; digest: string; completeness: 'COMPLETE' | 'INCOMPLETE';
  snapshot: { generatedAt: number; runCount: number; problems: string[]; runs: { hidden?: boolean; state?: string; result?: string }[] };
  downloads: { json: SummaryDownload; human: SummaryDownload } };
function download(file: SummaryDownload) {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function ExecutionSummary({ issueKey }: { issueKey: string }) {
  const [model, setModel] = useState<ExecutionSummaryModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generate = async () => {
    setBusy(true); setError(null); setModel(null);
    try {
      const result = await invoke<ExecutionSummaryModel & { error?: string }>('tm:summary:generate', { issueKey });
      if (result.error) setError(result.error); else setModel(result);
    } catch { setError('The execution summary could not be generated.'); } finally { setBusy(false); }
  };
  return <Section title="Execution summary">
    <p className="va-subtlest">Generate a frozen record of this execution, its signed versions, sign-offs, evidence checks and current source coverage.</p>
    <button className="va-button" disabled={busy} onClick={generate}>{busy ? 'Verifying records…' : 'Generate summary'}</button>
    {error && <Notice danger>{error}</Notice>}
    {model && <div style={{ marginTop: 12 }}>
      <p><Badge tone={model.completeness === 'COMPLETE' ? 'success' : 'danger'}>{model.completeness === 'COMPLETE' ? 'Complete' : 'Incomplete'}</Badge>{' '}
        {model.snapshot.runCount} runs · {new Date(model.snapshot.generatedAt).toLocaleString()}</p>
      {model.completeness === 'INCOMPLETE' && <Notice danger>Some records or evidence could not be verified. This export records those gaps and must not be treated as complete.</Notice>}
      <p style={{ fontSize: 12, overflowWrap: 'anywhere' }}>Snapshot SHA-256: <code>{model.digest}</code></p>
      <div className="va-row" style={{ gap: 8 }}>
        <button className="va-button" onClick={() => download(model.downloads.human)}>Download readable summary</button>
        <button className="va-button" onClick={() => download(model.downloads.json)}>Download JSON record</button>
      </div>
    </div>}
  </Section>;
}
