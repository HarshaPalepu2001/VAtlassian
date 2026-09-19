import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Badge, Card, Field, Loading, Page, Select } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { AvailableField, ControlledField, Project } from '../types';
import FieldClassification from './FieldClassification';
type Setup = Result & { controlled: (ControlledField & { pinned?: boolean; declared?: boolean })[]; excluded: AvailableField[]; available: AvailableField[]; storage?: { storedBytes: number; items: number } };
export default function FieldsPage({ projects }: { projects: Project[] }) {
  const [projectId, setProject] = useState('');
  const [data, setData] = useState<Setup | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    const seq = ++request.current;
    setData(null); setError('');
    if (!projectId) return;
    try {
      const r = assertResult(await invoke<Setup>('admin:fieldSetup', { projectId, issueTypeId: '*' }));
      if (seq === request.current) setData(r);
    } catch (e) { if (seq === request.current) setError(errorMessage(e)); }
  }, [projectId]);
  useEffect(() => { setAi(false); setMessage(''); void load(); return () => { ++request.current; }; }, [load]);
  async function mutate(action: () => Promise<Result>) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { const r = assertResult(await action()); await load(); setMessage(r.note ?? 'Change saved.'); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <Page eyebrow="Setup" title="Controlled fields" lead="Choose what future approved baselines capture. Existing baseline evidence keeps its original field policy.">
    <div className="va-stack">
      <Field label="Project"><Select value={projectId} disabled={busy || ai} onChange={setProject} placeholder="Choose a project" options={projects.map(p => ({ value: p.id, label: p.name }))} /></Field>
      {error && <Notice danger>{error} <Button isDisabled={busy} onClick={load}>Retry</Button></Notice>}
      {message && <Notice>{message}</Notice>}
      {projectId && !ai && <div className="va-row"><Button isDisabled={busy || !data} onClick={() => setAi(true)}>Classify fields with AI</Button><Button isDisabled={busy || !data} onClick={() => mutate(() => invoke<Result>('admin:syncFields', { projectId, issueTypeId: '*' }))}>Sync fields</Button></div>}
      {ai ? <FieldClassification key={projectId} projectId={projectId} onClose={() => setAi(false)} onSaved={note => { setMessage(note); setAi(false); void load(); }} /> : data ? <>
        <Card><div className="va-row"><Badge tone="brand">{data.controlled.length} tracked</Badge><Badge>{data.excluded.length} excluded</Badge><Badge tone="warning">{data.available.length} unreviewed</Badge></div>
          {data.storage && <p>Site-wide storage: {(data.storage.storedBytes / 1048576).toFixed(2)} MiB across {data.storage.items} work items</p>}
          <p className="va-muted">Retain contents enables field restoration. Digest-only evidence cannot restore the original value.</p>
        </Card>
        <Card title="Tracked fields">{data.controlled.map(f => <div className="va-record-field" key={f.field_id}><div className="va-row"><strong>{f.field_name}</strong><Badge>{f.field_kind}</Badge>{f.pinned && <Badge>Always tracked</Badge>}<span className="va-spacer" />
          <label><input type="checkbox" checked={!!f.store_values} disabled={busy} onChange={e => {
            const storeValues = e.target.checked;
            void mutate(() => invoke<Result>(f.declared === false ? 'admin:saveField' : 'admin:setRetention', { projectId, issueTypeId: '*', fieldId: f.field_id, storeValues }));
          }} /> Retain contents</label>
          {!f.pinned && <Button isDisabled={busy} onClick={() => mutate(() => invoke<Result>('admin:saveField', { projectId, issueTypeId: '*', fieldId: f.field_id, state: 'EXCLUDED' }))}>Exclude</Button>}
        </div></div>)}</Card>
        {[{ title: 'Deliberately excluded', fields: data.excluded }, { title: 'Not yet reviewed', fields: data.available }].map(group => <Card key={group.title} title={group.title}>{!group.fields.length ? <p className="va-muted">No fields in this group.</p> : group.fields.map(f => <div className="va-record-field va-row" key={f.fieldId}><strong>{f.fieldName}</strong><span className="va-spacer" /><Button isDisabled={busy} onClick={() => mutate(() => invoke<Result>('admin:trackField', { projectId, issueTypeId: '*', fieldId: f.fieldId }))}>Track</Button></div>)}</Card>)}
      </> : projectId && !error ? <Loading label="Loading controlled fields…" /> : null}
    </div>
  </Page>;
}
