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
    ai?: { enabled: boolean; maxCompletionTokens?: number; models?: Record<string, string> };
    restore?: RestoreConfig;
    policy?: { mode?: string };
    vault?: { lockAttachmentDeletion?: boolean };
  };
  revision: string | null;
};
/** src/usecases/vaultStatus.js getVaultStatus */
type VaultStatus = Result & {
  vault: { storage: string | null };
  lockdown: { enabled: boolean; lockedAt: number | null; lockedSchemeId: string | null };
  appDelete: { grantedAt: number | null; refusedAt: number | null };
  scheme: { id: number | string | null; name: string | null } | null;
  schemeError: string | null;
  sharedWith: string[] | null;
};
const when = (ms: number) => new Date(ms).toLocaleString();

export default function SettingsPage({ projects }: { projects: Project[] }) {
  const [projectId, setProject] = useState('');
  const [saved, setSaved] = useState<ConfigData | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  // Form state, one entry per saved setting.
  const [enabled, setEnabled] = useState(true);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [tokens, setTokens] = useState('4096');
  const [actAs, setActAs] = useState('app');
  const [notifyUsers, setNotify] = useState(false);
  const [retries, setRetries] = useState('2');
  const [lockDeletion, setLockDeletion] = useState(false);

  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [vaultError, setVaultError] = useState('');
  const [checkingShare, setCheckingShare] = useState(false);
  const vaultSequence = useRef(0);

  const sequence = useRef(0);

  function syncForm(data: ConfigData) {
    const c = data.config;
    setEnabled(c.enabled !== false);
    setAiEnabled(c.ai?.enabled !== false);
    setTokens(String(c.ai?.maxCompletionTokens ?? 4096));
    setActAs(c.restore?.actAs === 'user' ? 'user' : 'app');
    setNotify(c.restore?.notifyUsers === true);
    setRetries(String(c.restore?.perFieldRetries ?? 2));
    setLockDeletion(c.vault?.lockAttachmentDeletion === true);
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

  // Attachment protection is per project: the lockdown edits one project's
  // permission scheme, so there is nothing to show for the site defaults.
  const loadVault = useCallback(async (checkSharing = false) => {
    const seq = ++vaultSequence.current;
    setVaultError('');
    if (!projectId) { setVaultStatus(null); return; }
    if (checkSharing) setCheckingShare(true);
    try {
      const r = assertResult(await invoke<VaultStatus>('admin:getVaultStatus', { projectId, checkSharing }));
      if (!r.vault || !r.lockdown || !r.appDelete) throw new Error('The vault status is incomplete.');
      if (seq === vaultSequence.current) setVaultStatus(r);
    } catch (e) { if (seq === vaultSequence.current) setVaultError(errorMessage(e)); }
    finally { if (seq === vaultSequence.current) setCheckingShare(false); }
  }, [projectId]);
  useEffect(() => { setVaultStatus(null); void loadVault(); return () => { ++vaultSequence.current; }; }, [loadVault]);



  const c = saved?.config;
  const was = {
    enabled: c?.enabled !== false,
    aiEnabled: c?.ai?.enabled !== false,
    tokens: c?.ai?.maxCompletionTokens ?? 4096,
    actAs: c?.restore?.actAs === 'user' ? 'user' : 'app',
    notifyUsers: c?.restore?.notifyUsers === true,
    retries: c?.restore?.perFieldRetries ?? 2,
    lockDeletion: c?.vault?.lockAttachmentDeletion === true
  };

  // Mirrors the resolver's own bounds (fieldsValidation.js) so an unsavable
  // value is refused here rather than after a round trip.
  const validTokens = /^\d+$/.test(tokens) && Number(tokens) >= 256 && Number(tokens) <= 16384;
  const validRetries = /^\d+$/.test(retries) && Number(retries) >= 0 && Number(retries) <= 10;
  const legacyStrict = c?.policy?.mode === 'STRICT';
  const dirty = !!saved && (
    enabled !== was.enabled ||
    aiEnabled !== was.aiEnabled || Number(tokens) !== was.tokens ||
    actAs !== was.actAs || notifyUsers !== was.notifyUsers || Number(retries) !== was.retries ||
    (!!projectId && lockDeletion !== was.lockDeletion) || legacyStrict
  );
  const touch = () => setMessage('');

  async function save() {
    if (!saved || busy || !dirty || !validTokens || !validRetries) return;
    setBusy(true); setError(''); setMessage('');
    // Only actual edits are sent. Copying an inherited site default into a
    // project would silently stop that project inheriting later changes.
    const config: Record<string, unknown> = {};
    if (enabled !== was.enabled) config.enabled = enabled;
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
    if (projectId && lockDeletion !== was.lockDeletion) config.vault = { lockAttachmentDeletion: lockDeletion };
    try {
      const r = assertResult(await invoke<Result & { note?: string }>('admin:saveConfig', { projectId: projectId || undefined, expectedRevision: saved.revision, config }));
      const done = projectId ? 'Project settings saved. The latest values are shown.' : 'Site-wide default settings saved. The latest values are shown.';
      if (await load()) setMessage(r.note ? `${done} ${r.note}` : done);
      if (config.vault) void loadVault();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  const saveRow = <div className="va-row">
    <Button appearance="primary" isDisabled={busy || !dirty || !validTokens || !validRetries} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</Button>
    {dirty && <Button isDisabled={busy} onClick={() => { syncForm(saved!); setMessage('Unsaved changes discarded.'); }}>Discard changes</Button>}
  </div>;

  return <Page eyebrow="Operations" title="Settings" lead="Preferences that change how this app captures baselines, detects changes and restores content." actions={<Button isDisabled={busy} onClick={load}>Reload settings</Button>}>
    <div className="va-stack">
      <Field label="Scope" hint={projectId ? 'Changes override only the edited preferences for this project.' : 'Site defaults apply wherever a project has no override.'}>
        <Select value={projectId} disabled={busy} onChange={setProject} placeholder="Site-wide default settings (All projects)" options={projects.map(p => ({ value: p.id, label: `${p.name} (${p.key})` }))} />
      </Field>
      {error && <Notice danger>{error} <Button isDisabled={busy} onClick={load}>Retry</Button></Notice>}
      {message && !error && <Notice>{message}</Notice>}
      {!saved && !error && <Loading label="Loading configuration…" />}
      {saved && <>
        {/* src/lib/capture.js, collect.js, gate.js (drift hold), panelAccess.js */}
        <Card title="Content processing" subtitle="Baseline capture and change detection">
          <div className="va-stack">
            <label><input type="checkbox" disabled={busy} checked={enabled} onChange={e => { setEnabled(e.target.checked); touch(); }} /> Capture baselines and detect content changes</label>
            {!enabled && <Notice danger>
              Turned off, signing a controlled transition no longer captures a baseline, and content changes are not detected.
              Items with changes are no longer held at transitions, and the panel refuses change decisions and change reports.
              Controlled transitions still require a signature: their Jira workflow validators are unaffected.
            </Notice>}
          </div>
        </Card>

        {/* src/lib/restore/executor.js (single-issue restores only) */}
        <Card title="Restoration" subtitle="How rejected changes are written back to Jira">
          <div className="va-stack">
            <p className="va-muted">These apply when the rejected baseline covers one work item. A baseline that includes child work items is always restored as the app, notifies watchers, and is not retried field by field.</p>
            <Field label="Restore as" hint={actAs === 'app' ? 'Writes are attributed to the app, which can also write fields hidden from the edit screen.' : 'Writes are attributed to the acting user, who must be able to edit every restored field.'}>
              <Select value={actAs} disabled={busy} onChange={v => { setActAs(v); touch(); }} placeholder="Choose an identity" options={[{ value: 'app', label: 'The app' }, { value: 'user', label: 'The acting user' }]} />
            </Field>
            <label><input type="checkbox" disabled={busy} checked={notifyUsers} onChange={e => { setNotify(e.target.checked); touch(); }} /> Notify watchers of restored fields</label>
            <Field label="Retries per field" hint="A whole number from 0 to 10. A field Jira refuses with a server error or rate limit is retried this many times before it is reported as unrestored. Any other refusal is reported at once.">
              <input className="va-input" type="number" min="0" max="10" step="1" disabled={busy} value={retries} onChange={e => { setRetries(e.target.value); touch(); }} />
            </Field>
            {!validRetries && <Notice danger>Enter a whole number from 0 to 10.</Notice>}
          </div>
        </Card>

        {/* src/lib/vaultProvision.js provisionVault, usecases/vaultStatus.js */}
        <Card title="Attachment protection" subtitle="This project's vaulted files, and who may delete them">
          {!projectId ? <p className="va-muted">Attachment protection is set per project, because the lockdown edits that project's Jira permission scheme. Select a project above.</p>
            : <div className="va-stack">
              {vaultError && <Notice danger>The vault status could not be read: {vaultError} <Button isDisabled={busy} onClick={() => void loadVault()}>Retry</Button></Notice>}
              {!vaultStatus && !vaultError && <Loading label="Loading attachment protection…" />}
              {vaultStatus && <>
                <p>
                  Approved files are copied to the Forge Object Store. A rejection puts a removed file back from its vaulted copy.
                </p>
                <p className="va-muted">{vaultStatus.appDelete.grantedAt
                  ? 'The app can delete attachments here, so a rejection can remove files added after approval.'
                  : vaultStatus.appDelete.refusedAt
                    ? `Jira refused the app the right to delete attachments (${when(vaultStatus.appDelete.refusedAt)}). A rejection cannot remove files added after approval until it is granted.`
                    : 'The app\'s right to delete attachments is not confirmed yet.'}</p>
              </>}
              <label><input type="checkbox" disabled={busy} checked={lockDeletion} onChange={e => { setLockDeletion(e.target.checked); touch(); }} /> Lock attachment deletion for people in this project</label>
              <p className="va-muted">Removes Delete own attachments and Delete all attachments from every person and group on the project's permission scheme{vaultStatus?.scheme?.name ? <> (<strong>{vaultStatus.scheme.name}</strong>)</> : ''}. The app keeps its own. Off by default: with it off, anyone permitted can delete a file, and a rejection restores it from the vault.</p>
              {lockDeletion && !was.lockDeletion && <Notice danger>
                Permission schemes are often shared. Every project on this scheme loses these grants, not only this one.
                {vaultStatus?.sharedWith == null
                  ? <> <Button isDisabled={busy || checkingShare || !vaultStatus?.scheme} onClick={() => void loadVault(true)}>{checkingShare ? 'Checking…' : 'Check which projects share it'}</Button></>
                  : vaultStatus.sharedWith.length ? <> Shared with: {vaultStatus.sharedWith.join(', ')}.</> : <> No other project uses it.</>}
              </Notice>}
              {!lockDeletion && was.lockDeletion && <Notice danger>Turning this off does not put removed grants back. Re-add them in the project's permission scheme if people should delete attachments again. The audit ledger names who held each removed grant.</Notice>}
              {vaultStatus?.lockdown.lockedAt != null && !vaultStatus.lockdown.enabled && <Notice>
                Delete grants were removed from this project's scheme on {when(vaultStatus.lockdown.lockedAt)}, when the lockdown was applied. They stay removed until someone re-adds them in Jira.
              </Notice>}
              {vaultStatus?.lockdown.enabled && vaultStatus.lockdown.lockedAt != null && <p className="va-muted">Locked since {when(vaultStatus.lockdown.lockedAt)}.</p>}
              {vaultStatus?.lockdown.enabled && vaultStatus.lockdown.lockedAt == null && <p className="va-muted">Not applied yet: it is applied once this project has a controlled transition that captures a baseline, and retried every hour.</p>}
              {vaultStatus?.schemeError && <p className="va-muted">The permission scheme could not be read: {vaultStatus.schemeError}</p>}
            </div>}
        </Card>

        {/* src/lib/aiClassification.js classifyFields, report.js generateReport */}
        <Card title="AI assistance" subtitle="Field-classification suggestions and change reports">
          <div className="va-stack">
            <label><input type="checkbox" disabled={busy} checked={aiEnabled} onChange={e => { setAiEnabled(e.target.checked); touch(); }} /> Enable AI assistance</label>
            <p className="va-muted">When disabled, field classification suggestions and change reports are rule-based.</p>
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

        {legacyStrict && <Notice danger>A STRICT policy value stored by an earlier build is present. It does not lock content: the locking it refers to is not implemented, and saving replaces it with DETECT, the mode this runtime enforces.</Notice>}
      </>}


      <Card title="Configured elsewhere">
        <p>Approval rules are set in Controlled transitions, signer access in Approver roles, baseline contents in Controlled fields, and security alert delivery in Control health.</p>
      </Card>
    </div>
  </Page>;
}
