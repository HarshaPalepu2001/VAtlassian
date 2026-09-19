import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Card, Field, Loading, Page, Select } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { Project } from '../types';
type ConfigData = Result & { config: { ai: { enabled: boolean }; policy?: { mode?: string } }; revision: string | null };
export default function SettingsPage({ projects }: { projects: Project[] }) {
  const [projectId, setProject] = useState('');
  const [saved, setSaved] = useState<ConfigData | null>(null);
  const [ai, setAi] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const seq = ++sequence.current;
    setSaved(null); setError('');
    if (!projectId) return;
    try {
      const r = assertResult(await invoke<ConfigData>('admin:getConfig', { projectId }));
      if (seq !== sequence.current) return;
      if (typeof r.config?.ai?.enabled !== 'boolean') throw new Error('Project settings are incomplete. Reload before making changes.');
      setSaved(r); setAi(r.config.ai.enabled);
    } catch (e) { if (seq === sequence.current) setError(errorMessage(e)); }
  }, [projectId]);
  useEffect(() => { setMessage(''); void load(); return () => { ++sequence.current; }; }, [load]);
  async function save() {
    if (!saved || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      assertResult(await invoke<Result>('admin:saveConfig', { projectId, expectedRevision: saved.revision,
        config: { ai: { enabled: ai }, ...(saved.config.policy?.mode === 'STRICT' ? { policy: { mode: 'DETECT' } } : {}) } }));
      await load(); setMessage('Settings saved. The current saved values are shown below.');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <Page eyebrow="Configuration" title="Settings" lead="Project preferences used by field classification and change reports."><div className="va-stack">
    <Field label="Project"><Select value={projectId} disabled={busy} onChange={setProject} placeholder="Choose a project" options={projects.map(p => ({ value: p.id, label: p.name }))} /></Field>
    {error && <Notice danger>{error} <Button isDisabled={busy} onClick={load}>Reload settings</Button></Notice>}{message && !error && <Notice>{message}</Notice>}
    {projectId && !saved && !error && <Loading label="Loading saved settings…" />}
    {saved && <><Card title="AI assistance"><label><input type="checkbox" disabled={busy} checked={ai} onChange={e => { setAi(e.target.checked); setMessage(''); }} /> Enable AI assistance</label><p>Used for field-classification suggestions and change reports. When disabled, rule-based results remain available. Approval and baseline decisions still require the configured reviewer and authentication.</p><Button appearance="primary" isDisabled={busy || (ai === saved.config.ai.enabled && saved.config.policy?.mode !== 'STRICT')} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</Button></Card>
      <Card title="Enforcement behavior"><p>Content changes are detected after they occur. Transition approval is enforced by the exact rules in Controlled transitions and their enabled Jira workflow validators.</p>
        {saved.config.policy?.mode === 'STRICT' && <Notice danger>This project has a legacy STRICT setting that does not enforce content locking. Save settings to replace it with the supported DETECT value. Review Jira workflow controls separately.</Notice>}
      </Card></>}
  </div></Page>;
}
