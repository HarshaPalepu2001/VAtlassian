import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Card, Field, Loading, Page, Select } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { Project } from '../types';

/**
 * Every control on this page maps to a setting some module reads. The module
 * is named in a comment beside each one, so a reader can confirm the promise
 * the label makes is one the runtime keeps. Settings with no reader were
 * retired in fieldsValidation.js rather than shown as inert controls.
 */
type RestoreConfig = { actAs?: string; notifyUsers?: boolean; perFieldRetries?: number };
type ConfigData = Result & {
  config: {
    enabled?: boolean;
    queueThreshold?: string;
    reviewStatusIds?: string[];
    ai?: { enabled: boolean; maxCompletionTokens?: number; models?: Record<string, string> };
    restore?: RestoreConfig;
    policy?: { mode?: string };
  };
  revision: string | null;
};
type Status = { id: string; name: string; category?: string };

const THRESHOLDS = ['COSMETIC', 'MINOR', 'MAJOR', 'CRITICAL'];
const THRESHOLD_HINT: Record<string, string> = {
  COSMETIC: 'Every detected change reaches a reviewer, including formatting-only edits.',
  MINOR: 'Formatting-only changes stay out of the queue.',
  MAJOR: 'Only substantive and critical changes reach the queue.',
  CRITICAL: 'Only critical changes reach the queue. Major changes are recorded but not queued.'
};

export default function SettingsPage({ projects }: { projects: Project[] }) {
  const [projectId, setProject] = useState('');
  const [saved, setSaved] = useState<ConfigData | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  // Form state, one entry per saved setting.
  const [enabled, setEnabled] = useState(true);
  const [threshold, setThreshold] = useState('MINOR');
  const [statusIds, setStatusIds] = useState<string[]>([]);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [tokens, setTokens] = useState('4096');
  const [actAs, setActAs] = useState('app');
  const [notifyUsers, setNotify] = useState(false);
  const [retries, setRetries] = useState('2');

  const [statuses, setStatuses] = useState<Status[]>([]);
  const [statusError, setStatusError] = useState('');
  const [loadingStatuses, setLoadingStatuses] = useState(false);
  const sequence = useRef(0);
  const statusSequence = useRef(0);

  function syncForm(data: ConfigData) {
    const c = data.config;
    setEnabled(c.enabled !== false);
    setThreshold(THRESHOLDS.includes(c.queueThreshold ?? '') ? c.queueThreshold! : 'MINOR');
    setStatusIds((c.reviewStatusIds ?? []).map(String));
    setAiEnabled(c.ai?.enabled !== false);
    setTokens(String(c.ai?.maxCompletionTokens ?? 4096));
    setActAs(c.restore?.actAs === 'user' ? 'user' : 'app');
    setNotify(c.restore?.notifyUsers === true);
    setRetries(String(c.restore?.perFieldRetries ?? 2));
  }

  const load = useCallback(async () => {
    const seq = ++sequence.current;
    setSaved(null); setError(''); setMessage('');
    try {
      const r = assertResult(await invoke<ConfigData>('admin:getConfig', { projectId: projectId || undefined }));
      if (seq !== sequence.current) return false;
      if (!r.config || typeof r.config.ai?.enabled !== 'boolean') throw new Error('Configuration is incomplete. Reload before making changes.');
      setSaved(r); syncForm(r); return true;
    } catch (e) { if (seq === sequence.current) setError(errorMessage(e)); return false; }
  }, [projectId]);
  useEffect(() => { void load(); return () => { ++sequence.current; }; }, [load]);

  // Review statuses are Jira ids, so they can only be chosen against a real
  // project. A late reply from a previously selected project is discarded.
  useEffect(() => {
    const seq = ++statusSequence.current;
    setStatuses([]); setStatusError('');
    if (!projectId) { setLoadingStatuses(false); return; }
    setLoadingStatuses(true);
    invoke<Result & { statuses: Status[] }>('admin:listStatusesForProject', { projectId, issueTypeId: '*' })
      .then(assertResult)
      .then(r => { if (seq === statusSequence.current) setStatuses(r.statuses ?? []); })
      // Kept separate from the page-level error: a failed status lookup must
      // not read as "this project has no statuses", and it does not stop the
      // other settings on this page from being edited and saved.
      .catch(e => { if (seq === statusSequence.current) setStatusError(errorMessage(e)); })
      .finally(() => { if (seq === statusSequence.current) setLoadingStatuses(false); });
    return () => { ++statusSequence.current; };
  }, [projectId]);

  const c = saved?.config;
  const was = {
    enabled: c?.enabled !== false,
    threshold: THRESHOLDS.includes(c?.queueThreshold ?? '') ? c!.queueThreshold! : 'MINOR',
    statusIds: (c?.reviewStatusIds ?? []).map(String),
    aiEnabled: c?.ai?.enabled !== false,
    tokens: c?.ai?.maxCompletionTokens ?? 4096,
    actAs: c?.restore?.actAs === 'user' ? 'user' : 'app',
    notifyUsers: c?.restore?.notifyUsers === true,
    retries: c?.restore?.perFieldRetries ?? 2
  };

  // Mirrors the resolver's own bounds (fieldsValidation.js) so an unsavable
  // value is refused here rather than after a round trip.
  const validTokens = /^\d+$/.test(tokens) && Number(tokens) >= 256 && Number(tokens) <= 16384;
  const validRetries = /^\d+$/.test(retries) && Number(retries) >= 0 && Number(retries) <= 10;
  const sameStatuses = statusIds.length === was.statusIds.length && statusIds.every(id => was.statusIds.includes(id));
  // Stored review statuses the project no longer lists. They still drive
  // collect.js, so they are shown and preserved rather than quietly dropped.
  const orphanStatusIds = statuses.length ? statusIds.filter(id => !statuses.some(s => s.id === id)) : [];
  const legacyStrict = c?.policy?.mode === 'STRICT';
  const dirty = !!saved && (
    enabled !== was.enabled || threshold !== was.threshold || !sameStatuses ||
    aiEnabled !== was.aiEnabled || Number(tokens) !== was.tokens ||
    actAs !== was.actAs || notifyUsers !== was.notifyUsers || Number(retries) !== was.retries ||
    legacyStrict
  );
  const touch = () => setMessage('');

  async function save() {
    if (!saved || busy || !dirty || !validTokens || !validRetries) return;
    setBusy(true); setError(''); setMessage('');
    // Only actual edits are sent. Copying an inherited site default into a
    // project would silently stop that project inheriting later changes.
    const config: Record<string, unknown> = {};
    if (enabled !== was.enabled) config.enabled = enabled;
    if (threshold !== was.threshold) config.queueThreshold = threshold;
    if (!sameStatuses) config.reviewStatusIds = statusIds;
    const ai: { enabled?: boolean; maxCompletionTokens?: number } = {};
    if (aiEnabled !== was.aiEnabled) ai.enabled = aiEnabled;
    if (Number(tokens) !== was.tokens) ai.maxCompletionTokens = Number(tokens);
    if (Object.keys(ai).length) config.ai = ai;
    const restore: RestoreConfig = {};
    if (actAs !== was.actAs) restore.actAs = actAs;
    if (notifyUsers !== was.notifyUsers) restore.notifyUsers = notifyUsers;
    if (Number(retries) !== was.retries) restore.perFieldRetries = Number(retries);
    if (Object.keys(restore).length) config.restore = restore;
    // A STRICT value stored by an older build is replaced with the mode the
    // runtime actually implements; saveConfig refuses STRICT outright.
    if (legacyStrict) config.policy = { mode: 'DETECT' };
    try {
      assertResult(await invoke<Result>('admin:saveConfig', { projectId: projectId || undefined, expectedRevision: saved.revision, config }));
      if (await load()) setMessage(projectId ? 'Project settings saved. The latest values are shown.' : 'Site-wide default settings saved. The latest values are shown.');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  const saveRow = <div className="va-row">
    <Button appearance="primary" isDisabled={busy || !dirty || !validTokens || !validRetries} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</Button>
    {dirty && <Button isDisabled={busy} onClick={() => { syncForm(saved!); setMessage('Unsaved changes discarded.'); }}>Discard changes</Button>}
  </div>;

  return <Page eyebrow="Operations" title="Settings" lead="Preferences that change how this app captures baselines, queues drift and restores content." actions={<Button isDisabled={busy} onClick={load}>Reload settings</Button>}>
    <div className="va-stack">
      <Field label="Scope" hint={projectId ? 'Changes override only the edited preferences for this project.' : 'Site defaults apply wherever a project has no override.'}>
        <Select value={projectId} disabled={busy} onChange={setProject} placeholder="Site-wide default settings (All projects)" options={projects.map(p => ({ value: p.id, label: `${p.name} (${p.key})` }))} />
      </Field>
      {error && <Notice danger>{error} <Button isDisabled={busy} onClick={load}>Retry</Button></Notice>}
      {message && !error && <Notice>{message}</Notice>}
      {!saved && !error && <Loading label="Loading configuration…" />}
      {saved && <>
        {/* src/lib/collect.js:119, capture.js:77, panelAccess.js:69 */}
        <Card title="Content processing" subtitle="Baseline capture and drift detection">
          <div className="va-stack">
            <label><input type="checkbox" disabled={busy} checked={enabled} onChange={e => { setEnabled(e.target.checked); touch(); }} /> Capture baselines and detect content changes</label>
            {!enabled && <Notice danger>Turned off, no new baselines are captured and content changes are not detected. Controlled transitions still require approval: their Jira workflow validators are unaffected by this setting.</Notice>}
            {/* src/lib/collect.js:293 shouldQueue(), diff/index.js, panelAccess.js:91 */}
            <Field label="Queue threshold" hint={THRESHOLD_HINT[threshold]}>
              <Select value={threshold} disabled={busy || !enabled} onChange={v => { setThreshold(v); touch(); }} placeholder="Choose a threshold" options={THRESHOLDS.map(t => ({ value: t, label: t.charAt(0) + t.slice(1).toLowerCase() }))} />
            </Field>
            <p className="va-muted">Changes below the threshold are still recorded as evidence. The threshold decides what enters a reviewer's queue, not what is detected.</p>
          </div>
        </Card>

        {/* src/lib/collect.js:97, transitionPlan.js, interception.js */}
        <Card title="Review statuses" subtitle="Statuses that count as under review">
          {!projectId ? <p className="va-muted">Review statuses are Jira status ids, so they are chosen per project. Select a project above to set them.</p>
            : loadingStatuses ? <Loading label="Loading project statuses…" />
              : statusError ? <Notice danger>Project statuses could not be loaded, so they cannot be edited here: {statusError} The stored review statuses are unchanged, and the other settings on this page can still be saved.</Notice>
                : !statuses.length ? <p className="va-muted">No statuses were returned for this project.</p>
                  : <div className="va-stack">
                    {statuses.map(s => <label key={s.id}>
                      <input type="checkbox" disabled={busy} checked={statusIds.includes(s.id)}
                        onChange={e => { setStatusIds(prev => e.target.checked ? [...prev, s.id] : prev.filter(id => id !== s.id)); touch(); }} /> {s.name}
                    </label>)}
                    {/* A stored id the project no longer lists is still used by
                        the runtime, so it is disclosed rather than hidden — and
                        preserved on save rather than silently dropped. */}
                    {orphanStatusIds.length > 0 && <Notice danger>
                      {orphanStatusIds.length} stored {orphanStatusIds.length === 1 ? 'status is' : 'statuses are'} not in this project's current status list ({orphanStatusIds.join(', ')}).
                      {' '}They are still treated as under review. Saving keeps them; remove them below if they are obsolete.
                      <Button isDisabled={busy} onClick={() => { setStatusIds(prev => prev.filter(id => !orphanStatusIds.includes(id))); touch(); }}>Remove unlisted statuses</Button>
                    </Notice>}
                    <p className="va-muted">Leaving every status unselected means no status is treated as under review, so a prior approval is never superseded on re-entry.</p>
                  </div>}
        </Card>

        {/* src/lib/restore/executor.js:99, :100, :159 */}
        <Card title="Restoration" subtitle="How rejected changes are written back to Jira">
          <div className="va-stack">
            <Field label="Restore as" hint={actAs === 'app' ? 'Writes are attributed to the app: one clean audit line, and no per-user permission surprises mid-rejection.' : 'Writes are attributed to the acting user, who must be able to edit every restored field.'}>
              <Select value={actAs} disabled={busy} onChange={v => { setActAs(v); touch(); }} placeholder="Choose an identity" options={[{ value: 'app', label: 'The app' }, { value: 'user', label: 'The acting user' }]} />
            </Field>
            <label><input type="checkbox" disabled={busy} checked={notifyUsers} onChange={e => { setNotify(e.target.checked); touch(); }} /> Notify watchers of restored fields</label>
            <Field label="Retries per field" hint="A whole number from 0 to 10. Each restored field is retried this many times before it is reported as unrestored.">
              <input className="va-input" type="number" min="0" max="10" step="1" disabled={busy} value={retries} onChange={e => { setRetries(e.target.value); touch(); }} />
            </Field>
            {!validRetries && <Notice danger>Enter a whole number from 0 to 10.</Notice>}
          </div>
        </Card>

        {/* src/lib/aiClassification.js:331, report.js:238 */}
        <Card title="AI assistance" subtitle="Field-classification suggestions and change reports">
          <div className="va-stack">
            <label><input type="checkbox" disabled={busy} checked={aiEnabled} onChange={e => { setAiEnabled(e.target.checked); touch(); }} /> Enable AI assistance</label>
            <p>When disabled, rule-based results remain available. Approval and baseline decisions still require the configured reviewer and authentication.</p>
            <Field label="Maximum response tokens" hint="A whole number from 256 to 16,384. This limit applies to AI classification and report requests.">
              <input className="va-input" type="number" min="256" max="16384" step="1" disabled={busy || !aiEnabled} value={tokens} onChange={e => { setTokens(e.target.value); touch(); }} />
            </Field>
            {!validTokens && <Notice danger>Enter a whole number from 256 to 16,384.</Notice>}
            {/* Shown, not edited: which model produced a classification or a
                report is part of reading that evidence later, but a free-text
                model id is not something to hand an administrator. */}
            {saved.config.ai?.models && <div>
              <p className="va-muted">Models in use for AI evidence:</p>
              <ul className="va-muted">{Object.entries(saved.config.ai.models).map(([tier, id]) => <li key={tier}>{tier}: <code>{id}</code></li>)}</ul>
            </div>}
          </div>
        </Card>

        {saveRow}

        <Card title="Configured elsewhere">
          <p>Approval rules are set in Controlled transitions, signer access in Approver roles, baseline contents in Controlled fields, and security alert delivery in Control health.</p>
          <p className="va-muted">Content changes are detected after they occur. Transition approval is enforced by the exact rules in Controlled transitions and their enabled Jira workflow validators.</p>
          {legacyStrict && <Notice danger>A STRICT policy value stored by an earlier build is present. It does not lock content: the locking architecture it refers to is not implemented, and saving replaces it with DETECT, the mode this runtime enforces.</Notice>}
        </Card>
      </>}
    </div>
  </Page>;
}
