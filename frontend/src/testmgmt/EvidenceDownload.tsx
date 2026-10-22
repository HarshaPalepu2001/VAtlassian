import { useState } from 'react';
import { invoke } from '../lib/bridge';

type Evidence = { attachmentId: string; filename: string; sha256: string; size: number };
type Chunk = { filename: string; mimeType: string; sha256: string; totalBytes: number; offset: number;
  nextOffset: number; complete: boolean; dataBase64: string; error?: string };

export default function EvidenceDownload({ issueKey, runId, stepId, evidence, disabled = false }: {
  issueKey: string; runId: string; stepId: string; evidence: Evidence; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true); setProgress(0); setError(null);
    try {
      const chunks: Uint8Array<ArrayBuffer>[] = []; let offset = 0; let last: Chunk;
      do {
        last = await invoke<Chunk>('tm:run:getEvidence', { issueKey, runId, stepId, attachmentId: evidence.attachmentId, offset });
        if (last.error) throw new Error(last.error);
        if (last.sha256 !== evidence.sha256 || last.totalBytes !== evidence.size || last.totalBytes > 20 * 1024 * 1024
          || last.offset !== offset || !Number.isSafeInteger(last.nextOffset) || last.nextOffset < offset
          || last.nextOffset > last.totalBytes || (!last.complete && last.nextOffset === offset)) throw new Error('The evidence response did not match this saved record.');
        const bytes = Uint8Array.from(atob(last.dataBase64), character => character.charCodeAt(0));
        if (bytes.length !== last.nextOffset - offset) throw new Error('The evidence download was incomplete.');
        chunks.push(bytes); offset = last.nextOffset; setProgress(evidence.size ? Math.round(offset / evidence.size * 100) : 100);
      } while (!last.complete);
      if (offset !== evidence.size) throw new Error('The evidence download was incomplete.');
      const bytes = new Uint8Array(offset); let position = 0;
      for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (digest !== evidence.sha256) throw new Error('The downloaded evidence failed its SHA-256 integrity check.');
      const url = URL.createObjectURL(new Blob([bytes], { type: last.mimeType || 'application/octet-stream' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = last.filename || evidence.filename;
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setError(error instanceof Error ? error.message : 'The retained evidence could not be downloaded.'); }
    finally { setBusy(false); }
  };
  return <>
    <button className="va-button" disabled={busy || disabled} onClick={download}>{busy ? `Downloading ${progress}%…` : 'Download retained evidence'}</button>
    {error && <span role="alert" style={{ display: 'block' }}>{error}</span>}
  </>;
}
