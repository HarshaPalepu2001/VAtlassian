import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Loading, Page, Select } from '../../ui/primitives';
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

  const saveRow = <div className="va-settings__save">
    {legacyStrict && <span className="va-subtlest va-grow">An outdated policy value from an earlier build is replaced when you save.</span>}
    {dirty && <Button appearance="subtle" isDisabled={busy} onClick={() => { syncForm(saved!); setMessage('Unsaved changes discarded.'); }}>Discard</Button>}
    <Button appearance="primary" isDisabled={busy || !dirty || !validTokens || !validRetries} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
  </div>;

  // ONE ROW PER SETTING, the way Jira's own settings read: the label on the
  // left, the control on the right, a hint only where the choice is risky,
  // and a warning only once the risky value is actually chosen.
  // A switch's whole row is its label, so the words switch it too.
  // Its hint sits outside the label, so a link in the hint never flips the switch.
  const row = (label: string, control: ReactNode, hint?: ReactNode, switchRow = false) => switchRow ? (
    <div className="va-setrow">
      <label className="va-setrow__switch">
        <span className="va-setrow__label">{label}</span>
        <span className="va-setrow__control">{control}</span>
      </label>
      {hint && <span className="va-setrow__hint va-setrow__hint--below">{hint}</span>}
    </div>
  ) : (
    <div className="va-setrow">
      <span className="va-setrow__label">{label}</span>
      <span className="va-setrow__control">{control}{hint && <span className="va-setrow__hint">{hint}</span>}</span>
    </div>
  );
  const toggle = (checked: boolean, onChange: (value: boolean) => void, disabled = false) => (
    <span className="va-toggle"><input type="checkbox" role="switch" disabled={busy || disabled} checked={checked} onChange={e => { onChange(e.target.checked); touch(); }} /><span aria-hidden /></span>
  );

  return <Page title="Settings" actions={
    <Select value={projectId} disabled={busy} onChange={setProject} placeholder="All projects (defaults)" options={projects.map(p => ({ value: p.id, label: `${p.name} (${p.key})` }))} />
  }>
    <div className="va-settings">
      {error && <Notice danger>{error} <Button isDisabled={busy} onClick={load}>Retry</Button></Notice>}
      {message && !error && <Notice>{message}</Notice>}
      {!saved && !error && <Loading label="Loading settings…" />}
      {saved && <>
        <p className="va-subtlest">{projectId ? 'Only the settings you change here override the defaults for this project.' : 'Defaults for every project that has not overridden them.'}</p>

        {/* src/lib/capture.js, collect.js, gate.js (drift hold), panelAccess.js */}
        <h3 className="va-settings__group">Change detection</h3>
        {row('Capture baselines and detect changes', toggle(enabled, setEnabled),
          !enabled && <span className="va-warning-text">While this is off, controlled transitions are blocked and no changes are detected. Approval rules are not bypassed.</span>, true)}

        {/* src/lib/restore/executor.js (single-issue restores only) */}
        <h3 className="va-settings__group">Restoring rejected changes</h3>
        {row('Write restored values as',
          <Select value={actAs} disabled={busy} onChange={v => { setActAs(v); touch(); }} placeholder="Choose an identity" options={[{ value: 'app', label: 'VAtlassian app' }, { value: 'user', label: 'The person who rejected' }]} />,
          actAs === 'app' ? 'The app can also restore fields that are not on the edit screen.' : 'That person must be able to edit every restored field.')}
        {row('Notify watchers', toggle(notifyUsers, setNotify), undefined, true)}
        {row('Retries per field',
          <input className="va-input va-input--short" type="number" min="0" max="10" step="1" aria-label="Retries per field" disabled={busy} value={retries} onChange={e => { setRetries(e.target.value); touch(); }} />,
          !validRetries ? <span className="va-warning-text">Enter a whole number from 0 to 10.</span> : undefined)}
        <p className="va-subtlest">These apply to a single work item. A baseline with child work items is always restored by the app.</p>

        {/* src/lib/vaultProvision.js provisionVault, usecases/vaultStatus.js */}
        <h3 className="va-settings__group">Attachments</h3>
        {!projectId ? <p className="va-subtlest">Attachment protection is set per project. Choose a project above.</p> : <>
          <p className="va-subtlest">Approved files are copied to the Forge Object Store, so a rejection can put a removed file back.</p>
          {vaultError && <Notice danger>The vault status could not be read: {vaultError} <Button isDisabled={busy} onClick={() => void loadVault()}>Retry</Button></Notice>}
          {row('Only VAtlassian may delete attachments', toggle(lockDeletion, setLockDeletion), <>
            {!lockDeletion && !was.lockDeletion && vaultStatus?.scheme?.name && <>Removes the delete permissions from everyone on <strong>{vaultStatus.scheme.name}</strong>.</>}
            {lockDeletion && !was.lockDeletion && <span className="va-warning-text">
              Every project on {vaultStatus?.scheme?.name ? <strong>{vaultStatus.scheme.name}</strong> : 'this permission scheme'} loses the delete permissions, not only this one.
              {' '}{vaultStatus?.sharedWith == null
                ? <button type="button" className="va-link-button" disabled={busy || checkingShare || !vaultStatus?.scheme} onClick={() => void loadVault(true)}>{checkingShare ? 'Checking…' : 'Which projects share it?'}</button>
                : vaultStatus.sharedWith.length ? <>Shared with {vaultStatus.sharedWith.join(', ')}.</> : <>No other project uses it.</>}
            </span>}
            {!lockDeletion && was.lockDeletion && <span className="va-warning-text">Turning this off does not give the delete permissions back. Re-add them in the permission scheme.</span>}
            {lockDeletion === was.lockDeletion && vaultStatus?.lockdown.enabled && (vaultStatus.lockdown.lockedAt != null
              ? `Locked since ${when(vaultStatus.lockdown.lockedAt)}.`
              : 'Applied once this project has a controlled transition that captures a baseline.')}
            {lockDeletion === was.lockDeletion && !vaultStatus?.lockdown.enabled && vaultStatus?.lockdown.lockedAt != null && `Delete permissions were removed on ${when(vaultStatus.lockdown.lockedAt)} and stay removed until someone re-adds them.`}
          </>, true)}
          {vaultStatus && !vaultStatus.appDelete.grantedAt && (
            <p className="va-warning-text">{vaultStatus.appDelete.refusedAt
              ? `Jira refused the app permission to delete attachments (${when(vaultStatus.appDelete.refusedAt)}), so a rejection can't remove files added after approval.`
              : "The app's permission to delete attachments is not confirmed yet."}</p>
          )}
          {vaultStatus?.schemeError && <p className="va-subtlest">The permission scheme could not be read: {vaultStatus.schemeError}</p>}
        </>}

        {/* src/lib/aiClassification.js classifyFields, report.js generateReport */}
        <h3 className="va-settings__group">AI</h3>
        {row('Summaries and field suggestions', toggle(aiEnabled, setAiEnabled),
          !aiEnabled ? 'Field suggestions fall back to rules, and no summaries are written.' : undefined, true)}
        {row('Longest response',
          <input className="va-input va-input--short" type="number" min="256" max="16384" step="1" aria-label="Maximum response tokens" disabled={busy || !aiEnabled} value={tokens} onChange={e => { setTokens(e.target.value); touch(); }} />,
          !validTokens ? <span className="va-warning-text">Enter a whole number from 256 to 16,384.</span> : 'Tokens, per request.')}
        {/* Shown, not edited: which model produced a report is part of reading that evidence later. */}
        {saved.config.ai?.models && <p className="va-subtlest">Models: {Object.entries(saved.config.ai.models).map(([tier, id]) => `${tier} ${id}`).join(' · ')}</p>}

        {saveRow}
      </>}
    </div>
  </Page>;
}
