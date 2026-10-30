import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Badge, Card, Field, Loading, Page, Select } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { AvailableField, ControlledField, Project } from '../types';
import FieldClassification from './FieldClassification';
import { searchFields, type FieldHit } from '../fieldSearch';
type Setup = Result & { controlled: (ControlledField & { pinned?: boolean; declared?: boolean })[]; excluded: AvailableField[]; available: AvailableField[]; storage?: { storedBytes: number; items: number } };
type SyncBatch = Result & { added?: number; screens?: { ok: boolean; total: number | null; nextOffset: number | null } | null };
// The server reads a project's Jira screens in batches so one request stays
// inside its time limit; each batch's fields are saved as it goes. Ask for the
// next batch until none is left. The cap only guards against a loop that never
// ends; 50 batches is 3,000 screens.
const MAX_SYNC_BATCHES = 50;
async function syncAllScreens(projectId: string): Promise<Result> {
  let added = 0;
  let screenOffset = 0;
  for (let batch = 0; batch < MAX_SYNC_BATCHES; batch++) {
    const r = assertResult(await invoke<SyncBatch>('admin:syncFields', { projectId, issueTypeId: '*', screenOffset }));
    added += r.added ?? 0;
    const screens = r.screens;
    const done = `${added} field${added === 1 ? '' : 's'} added.`;
    if (!screens?.ok) return { ...r, note: `${done} Jira's screens could not be read, so fields that appear only on edit, view or transition screens were not checked. Sync again shortly.` };
    if (screens.nextOffset == null) return { ...r, note: `${done} All ${screens.total ?? 0} Jira screens checked.` };
    screenOffset = screens.nextOffset;
  }
  return { ok: true, note: `${added} fields added. Stopped after ${MAX_SYNC_BATCHES} batches of screens; Sync again to continue.` } as Result;
}
export default function FieldsPage({ projects }: { projects: Project[] }) {
  const [projectId, setProject] = useState('');
  const [data, setData] = useState<Setup | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState(false);
  const [query, setQuery] = useState('');
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
  useEffect(() => { setAi(false); setMessage(''); setQuery(''); void load(); return () => { ++request.current; }; }, [load]);
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
      {projectId && !ai && <div className="va-row"><Button isDisabled={busy || !data} onClick={() => setAi(true)}>Classify fields with AI</Button><Button isDisabled={busy || !data} onClick={() => mutate(() => syncAllScreens(projectId))}>Sync fields</Button></div>}
      {ai ? <FieldClassification key={projectId} projectId={projectId} onClose={() => setAi(false)} onSaved={note => { setMessage(note); setAi(false); void load(); }} /> : data ? <>
        <Card><div className="va-row"><Badge tone="brand">{data.controlled.length} tracked</Badge><Badge>{data.excluded.length} excluded</Badge><Badge tone="warning">{data.available.length} unreviewed</Badge></div>
          {data.storage && <p>Site-wide storage: {(data.storage.storedBytes / 1048576).toFixed(2)} MiB across {data.storage.items} work items</p>}
          <p className="va-muted">Retain contents enables field restoration. Digest-only evidence cannot restore the original value.</p>
        </Card>
        <Field label="Find a field to track">
          <input type="search" className="va-input" value={query} placeholder="Search by name or id, e.g. Attachment or customfield_10015"
            aria-label="Find a field to track" onChange={e => setQuery(e.target.value)} />
        </Field>
        {query.trim() ? <SearchResults hits={searchFields(data, query)} query={query} busy={busy}
          onTrack={fieldId => mutate(() => invoke<Result>('admin:trackField', { projectId, issueTypeId: '*', fieldId, storeValues: true }))} /> : <>
        <Card title="Tracked fields">{data.controlled.map(f => <div className="va-record-field" key={f.field_id}><div className="va-row"><strong>{f.field_name}</strong><Badge>{f.field_kind}</Badge>{f.pinned && <Badge>Always tracked</Badge>}<span className="va-spacer" />
          <label><input type="checkbox" checked={!!f.store_values} disabled={busy} onChange={e => {
            const storeValues = e.target.checked;
            void mutate(() => invoke<Result>(f.declared === false ? 'admin:saveField' : 'admin:setRetention', { projectId, issueTypeId: '*', fieldId: f.field_id, storeValues }));
          }} /> Retain contents</label>
          {!f.pinned && <Button isDisabled={busy} onClick={() => mutate(() => invoke<Result>('admin:saveField', { projectId, issueTypeId: '*', fieldId: f.field_id, state: 'EXCLUDED' }))}>Exclude</Button>}
        </div></div>)}</Card>
        {[{ title: 'Deliberately excluded', fields: data.excluded }, { title: 'Not yet reviewed', fields: data.available }].map(group => <Card key={group.title} title={group.title}>{!group.fields.length ? <p className="va-muted">No fields in this group.</p> : group.fields.map(f => <div className="va-record-field va-row" key={f.fieldId}><strong>{f.fieldName}</strong><span className="va-spacer" /><Button isDisabled={busy} onClick={() => mutate(() => invoke<Result>('admin:trackField', { projectId, issueTypeId: '*', fieldId: f.fieldId, storeValues: true }))}>Track and retain</Button></div>)}</Card>)}
        </>}
      </> : projectId && !error ? <Loading label="Loading controlled fields…" /> : null}
    </div>
  </Page>;
}

const STATUS_LABEL: Record<FieldHit['status'], string> = { tracked: 'Tracked', excluded: 'Excluded', available: 'Not yet reviewed' };

function SearchResults({ hits, query, busy, onTrack }: { hits: FieldHit[]; query: string; busy: boolean; onTrack: (fieldId: string) => void }) {
  if (!hits.length) return <Card title="Search results"><p className="va-muted">
    No trackable field matches &quot;{query.trim()}&quot;. Comments, worklogs, watchers, status and updated
    can change without anyone editing the work item, so they are never tracked. A field is offered only once it is on one of this project's screens.
  </p></Card>;
  return <Card title="Search results">{hits.map(h => <div className="va-record-field va-row" key={h.fieldId}>
    <strong>{h.fieldName}</strong><span className="va-muted">{h.fieldId}</span>{h.kind && <Badge>{h.kind}</Badge>}
    <Badge tone={h.status === 'tracked' ? 'brand' : h.status === 'available' ? 'warning' : 'neutral'}>{STATUS_LABEL[h.status]}</Badge>
    {h.pinned && <Badge>Always tracked</Badge>}
    <span className="va-spacer" />
    {h.status !== 'tracked' && <Button isDisabled={busy} onClick={() => onTrack(h.fieldId)}>Track and retain</Button>}
  </div>)}</Card>;
}
