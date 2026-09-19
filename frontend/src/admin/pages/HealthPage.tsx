import { useCallback, useEffect, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Badge, Card, Field, Loading, Page, Select } from '../../ui/primitives';
import { Notice, When } from '../../ui/feedback';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { Project } from '../types';
type Finding = { findingKey: string; severity: string; type: string; projectName?: string; detail: string; lastSeenAt: number };
type Destination = Result & { projectId?: string; issueTypeId?: string; undelivered: number; configured: boolean };
export default function HealthPage({ projects }: { projects: Project[] }) {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [projectId, setProject] = useState('');
  const [issueTypeId, setType] = useState('');
  const [types, setTypes] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingTypes, setLoadingTypes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError(''); setMessage(''); setFindings(null); setDestination(null);
    try {
      const [f, a] = await Promise.all([invoke<Result & { findings: Finding[] }>('admin:listGateFindings'), invoke<Destination>('admin:getAlertDestination')]);
      assertResult(f); assertResult(a);
      setFindings(f.findings); setDestination(a); setProject(a.projectId ?? ''); setType(a.issueTypeId ?? '');
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let active = true; setTypes([]);
    if (!projectId) { setLoadingTypes(false); return; }
    setLoadingTypes(true);
    invoke<Result & { issueTypes: { id: string; name: string; subtask?: boolean }[] }>('admin:listIssueTypesForProject', { projectId }).then(assertResult)
      .then(r => { if (active) setTypes(r.issueTypes.filter(t => !t.subtask)); })
      .catch(e => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setLoadingTypes(false); });
    return () => { active = false; };
  }, [projectId]);
  async function save() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      assertResult(await invoke<Result>('admin:setAlertDestination', { projectId, issueTypeId }));
      const saved = assertResult(await invoke<Destination>('admin:getAlertDestination'));
      setDestination(saved); setProject(saved.projectId ?? ''); setType(saved.issueTypeId ?? '');
      setMessage('Security alert destination saved and reloaded.');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <Page eyebrow="Operations" title="Control health" actions={<Button isDisabled={busy || loading} onClick={load}>Refresh</Button>}><div className="va-stack">
    {error && <Notice danger>{error} <Button isDisabled={busy || loading} onClick={load}>Retry</Button></Notice>}{message && <Notice>{message}</Notice>}
    <Card title="Workflow findings">{loading ? <Loading label="Checking recorded workflow findings…" /> : findings === null ? <p>Workflow health is unavailable.</p> : findings.length ? findings.map(f => <div className="va-record-field" key={f.findingKey}><Badge tone={f.severity === 'CRITICAL' ? 'danger' : 'warning'}>{f.severity}</Badge> <strong>{f.type.replaceAll('_', ' ')}</strong><p>{f.projectName ?? 'Project unavailable'} · {f.detail}</p><When ms={f.lastSeenAt} /></div>) : <p>No open workflow findings recorded. This reflects the latest completed checks.</p>}</Card>
    <Card title="Security alerts">
      {destination ? <><p>{destination.undelivered} alerts awaiting delivery</p>{!destination.configured && <Notice>Alert delivery is not configured. Detected alerts remain queued until a destination is saved.</Notice>}</> : <p>Alert delivery status is unavailable.</p>}
      <div className="va-form-grid"><Field label="Project"><Select value={projectId} disabled={busy || loading || !destination} onChange={v => { setProject(v); setType(''); setMessage(''); }} placeholder="Choose a project" options={projects.map(p => ({ value: p.id, label: p.name }))} /></Field>
        <Field label="Work item type" hint={loadingTypes ? 'Loading work item types…' : 'Alerts require a standard work item type, not a subtask.'}><Select value={issueTypeId} disabled={busy || loadingTypes || !projectId} onChange={v => { setType(v); setMessage(''); }} placeholder="Choose a type" options={types.map(t => ({ value: t.id, label: t.name }))} /></Field></div>
      <Button appearance="primary" isDisabled={busy || loading || loadingTypes || !destination || !projectId || !types.some(t => t.id === issueTypeId)} onClick={save}>{busy ? 'Saving…' : 'Save destination'}</Button>
    </Card>
  </div></Page>;
}
