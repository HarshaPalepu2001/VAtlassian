import { useEffect, useState } from 'react';
import { invoke } from '../../lib/bridge';
import { Field, Page, Section, Select } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import type { Project } from '../types';

type ChainStep = { label: string; role: string; meaning: string };
type Chain = { steps: ChainStep[]; distinctSigners: boolean };
type Config = { enabled: boolean; testTypeId: string; executionTypeId: string; planTypeId: string | null;
  setTypeId: string | null; preconditionTypeId: string | null; defectTypeId: string;
  linkTypeName: string; sourceLinkTypeId: string | null; runChain: Chain; versionChain: Chain; revision: number };
type Loaded = { success: boolean; error?: string; config: Config | null;
  project: { style: string | null; issueTypes: { id: string; name: string; subtask: boolean }[] };
  linkTypes: { id: string; name: string }[];
  defaults: { runChain: Chain; versionChain: Chain; linkTypeName: string };
  repairs?: { items: { runId: string; issueKey: string | null; lastError: string | null }[]; complete: boolean };
  workflowHealth?: { readable: boolean; missingDoneRoutes: string[] } };

/**
 * Per project: which work types are tests, executions and bugs, and who signs
 * test versions and test runs. The client decides the chains; VAtlassian
 * enforces them with no override (owner decision 4).
 */
export default function TestManagementPage({ projects }: { projects: Project[] }) {
  const [projectId, setProjectId] = useState('');
  const [data, setData] = useState<Loaded | null>(null);
  const [form, setForm] = useState<Config | null>(null);
  const [message, setMessage] = useState<{ danger: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [repair, setRepair] = useState({ runId: '', bugKey: '', reason: '' });

  useEffect(() => {
    let cancelled = false;
    setData(null); setForm(null); setMessage(null); setRepair({ runId: '', bugKey: '', reason: '' });
    if (!projectId) return;
    invoke<Loaded>('admin:tm:get', { projectId }).then(res => {
      if (cancelled) return;
      if (!res.success) { setMessage({ danger: true, text: res.error ?? 'Could not load the configuration.' }); return; }
      setData(res);
      setForm(res.config ? { ...res.config, setTypeId: res.config.setTypeId ?? null, preconditionTypeId: res.config.preconditionTypeId ?? null, sourceLinkTypeId: res.config.sourceLinkTypeId ?? null }
        : { enabled: false, testTypeId: '', executionTypeId: '', planTypeId: null, setTypeId: null, preconditionTypeId: null, defectTypeId: '',
        linkTypeName: res.defaults.linkTypeName, sourceLinkTypeId: null, runChain: res.defaults.runChain, versionChain: res.defaults.versionChain, revision: 0 });
    }).catch(e => { if (!cancelled) setMessage({ danger: true, text: e?.message ?? 'Could not load the configuration.' }); });
    return () => { cancelled = true; };
  }, [projectId]);

  const save = async (enabled: boolean) => {
    if (!form) return;
    setBusy(true); setMessage(null);
    try {
      const res = await invoke<{ success: boolean; error?: string; config?: Config }>('admin:tm:save',
        { projectId, ...form, enabled, expectedRevision: form.revision });
      if (!res.success || !res.config) setMessage({ danger: true, text: res.error ?? 'Not saved.' });
      else { setForm(res.config); setMessage({ danger: false, text: enabled ? 'Saved. Test management is enabled for this project.' : 'Saved. Test management is off for this project.' }); }
    } catch (e) { setMessage({ danger: true, text: e instanceof Error ? e.message : 'Not saved.' }); }
    finally { setBusy(false); }
  };

  const repairBug = async () => {
    setBusy(true); setMessage(null);
    try {
      const res = await invoke<{ success: boolean; error?: string }>('admin:tm:repairBug', { projectId, ...repair });
      if (!res.success) { setMessage({ danger: true, text: res.error ?? 'The repair was not recorded.' }); return; }
      setMessage({ danger: false, text: 'Repair audited. The existing bug now has both required links.' });
      setData(current => current ? { ...current, repairs: current.repairs ? { ...current.repairs,
        items: current.repairs.items.filter(item => item.runId !== repair.runId) } : undefined } : current);
      setRepair({ runId: '', bugKey: '', reason: '' });
    } catch (e) { setMessage({ danger: true, text: e instanceof Error ? e.message : 'The repair was not recorded.' }); }
    finally { setBusy(false); }
  };

  const types = (data?.project.issueTypes ?? []).filter(t => !t.subtask).map(t => ({ value: t.id, label: t.name }));
  // Test versions are signed on the Test, runs on the Execution.
  const versionRoles = useGrantedRoles(projectId, form?.testTypeId || null);
  const runRoles = useGrantedRoles(projectId, form?.executionTypeId || null);
  const rolesError = versionRoles.error ?? runRoles.error;

  return (
    <Page eyebrow="Setup" title="Test management"
      lead="Choose the work types for tests, test executions and bugs, and the sign-off chains. A run counts only when the test version it used is signed and every step of the run chain is signed.">
      <Field label="Project">
        <Select value={projectId} onChange={setProjectId} disabled={busy} placeholder="Choose a project"
          options={projects.map(p => ({ value: p.id, label: `${p.name} (${p.key})` }))} />
      </Field>
      {message && <Notice danger={message.danger}>{message.text}</Notice>}
      {data && data.project.style !== 'classic' && <Notice danger>This is a team-managed project. Test management works on company-managed projects only.</Notice>}
      {data?.workflowHealth && (!data.workflowHealth.readable || data.workflowHealth.missingDoneRoutes.length > 0) && (
        <Notice danger>{data.workflowHealth.readable
          ? `Execution workflow is unenforced. Add the VAtlassian Approval validator to these Done routes: ${data.workflowHealth.missingDoneRoutes.join(', ')}.`
          : 'Execution workflow health could not be verified. Do not treat this project as continuously enforced until the workflow can be read.'}</Notice>
      )}
      {form && data && (
        <>
          <Section title="Work types">
            <div className="va-form-grid">
              {([['testTypeId', 'Test'], ['executionTypeId', 'Test Execution'], ['planTypeId', 'Test Plan (optional)'],
                ['setTypeId', 'Test Set (optional)'], ['preconditionTypeId', 'Precondition (optional)'], ['defectTypeId', 'Bug (created on a failed run)']] as const).map(([key, label]) => (
                <Field key={key} label={label}>
                  <Select value={form[key] ?? ''} onChange={v => setForm({ ...form, [key]: v || null })} disabled={busy}
                    placeholder="Choose a work type" options={types} />
                </Field>
              ))}
              <Field label="Link type for bugs" hint="The automatic bug is linked to its test and execution with this link type.">
                <Select value={form.linkTypeName} onChange={v => setForm({ ...form, linkTypeName: v })} disabled={busy}
                  placeholder="Choose a link type" options={data.linkTypes.map(l => ({ value: l.name, label: l.name }))} />
              </Field>
              <Field label="Verifies link type" hint="Signed Test source references use this dedicated outward Jira relationship. Existing source baselines keep their signed link policy until a new native approval.">
                <Select value={form.sourceLinkTypeId ?? ''} onChange={v => setForm({ ...form, sourceLinkTypeId: v || null })} disabled={busy}
                  placeholder="Not configured" options={data.linkTypes.filter(link => link.name !== form.linkTypeName).map(link => ({ value: link.id, label: link.name }))} />
              </Field>
            </div>
            <p className="va-subtlest" style={{ fontSize: 12 }}>
              Use work types that only test management uses. Tests, executions and their bugs sit outside their Epic's approved baseline, so creating them never holds the Epic.
            </p>
          </Section>
          {rolesError && <Notice danger>{rolesError}</Notice>}
          <ChainEditor title="Test version sign-off" scope="Test" chain={form.versionChain} roles={versionRoles.roles} busy={busy}
            onChange={c => setForm(f => f && { ...f, versionChain: c })} />
          <ChainEditor title="Test run sign-off" scope="Test Execution" chain={form.runChain} roles={runRoles.roles} busy={busy}
            onChange={c => setForm(f => f && { ...f, runChain: c })} />
          <div className="va-row" style={{ gap: 8 }}>
            <button className="va-button va-button--primary" disabled={busy} onClick={() => save(true)}>{form.enabled ? 'Save' : 'Save and enable'}</button>
            {form.enabled && <button className="va-button" disabled={busy} onClick={() => save(false)}>Turn off</button>}
          </div>
          <Notice>People need the roles in these chains for this project: assign them under Approver roles. A chain step nobody holds cannot be signed, and a run that needs it cannot start.</Notice>
          <Section title="Repair automatic bug">
            <p>Investigate the run and Jira history first. Choose the existing mapped Bug under the test's parent. The repair checks its project, work type, parent and exclusive run assignment, creates both navigation links, and records your reason.</p>
            {data.repairs?.items.map(item => <p key={item.runId}>
              <button className="va-button" disabled={busy} onClick={() => setRepair({ runId: item.runId, bugKey: item.issueKey ?? '', reason: '' })}>
                Select run {item.runId.slice(0, 8)}{item.issueKey ? ` · ${item.issueKey}` : ''}
              </button> <span>{item.lastError?.replaceAll('_', ' ')}</span>
            </p>)}
            {data.repairs?.complete === false && <Notice>Only the first 100 repairs are shown. Use a full run ID for another repair.</Notice>}
            <Field label="Run ID"><input className="va-input" aria-label="Run ID" value={repair.runId} disabled={busy}
              onChange={e => setRepair({ ...repair, runId: e.target.value.trim() })} /></Field>
            <Field label="Existing bug key"><input className="va-input" aria-label="Existing bug key" value={repair.bugKey} disabled={busy}
              onChange={e => setRepair({ ...repair, bugKey: e.target.value.trim() })} /></Field>
            <Field label="Repair reason"><textarea className="va-input" aria-label="Repair reason" value={repair.reason} disabled={busy}
              onChange={e => setRepair({ ...repair, reason: e.target.value })} /></Field>
            <button className="va-button" disabled={busy || !/^[0-9a-f]{32}$/.test(repair.runId) || !repair.bugKey || !repair.reason.trim()}
              onClick={repairBug}>Record repair</button>
          </Section>
        </>
      )}
    </Page>
  );
}

/**
 * Roles granted in Approver roles for this project and work type: the same
 * list a controlled transition's "Who must sign" picker offers. Null until a
 * work type is chosen and the list has loaded.
 */
function useGrantedRoles(projectId: string, issueTypeId: string | null) {
  const [state, setState] = useState<{ roles: string[] | null; error: string | null }>({ roles: null, error: null });
  useEffect(() => {
    let active = true;
    setState({ roles: null, error: null });
    if (!projectId || !issueTypeId) return;
    invoke<{ success: boolean; error?: string; roles?: string[] }>('admin:listAvailableRoles', { projectId, issueTypeId })
      .then(res => { if (active) setState(res.success ? { roles: res.roles ?? [], error: null } : { roles: null, error: res.error ?? 'Could not load the roles.' }); })
      .catch(e => { if (active) setState({ roles: null, error: e?.message ?? 'Could not load the roles.' }); });
    return () => { active = false; };
  }, [projectId, issueTypeId]);
  return state;
}

function ChainEditor({ title, scope, chain, roles, busy, onChange }: {
  title: string; scope: string; chain: Chain; roles: string[] | null; busy: boolean; onChange: (c: Chain) => void;
}) {
  const set = (i: number, patch: Partial<ChainStep>) => onChange({ ...chain, steps: chain.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  // A role nobody holds any more is cleared, as on controlled transitions, so
  // what is shown is what would be saved.
  useEffect(() => {
    if (roles && chain.steps.some(s => s.role && !roles.includes(s.role))) {
      onChange({ ...chain, steps: chain.steps.map(s => (roles.includes(s.role) ? s : { ...s, role: '' })) });
    }
  }, [roles]);
  return (
    <Section title={title}>
      <table className="va-table">
        <thead><tr><th>#</th><th>Label</th><th>Role</th><th>What the signer attests</th><th /></tr></thead>
        <tbody>{chain.steps.map((s, i) => (
          <tr key={i}>
            <td>{i + 1}</td>
            <td><input className="va-input" value={s.label} disabled={busy} onChange={e => set(i, { label: e.target.value })} /></td>
            <td><Select value={s.role} onChange={v => set(i, { role: v })} disabled={busy || !roles} placeholder="Choose a role…"
              options={(roles ?? []).map(r => ({ value: r, label: r }))} /></td>
            <td><textarea className="va-input" rows={2} value={s.meaning} disabled={busy} onChange={e => set(i, { meaning: e.target.value })} /></td>
            <td><button className="va-button" disabled={busy || chain.steps.length === 1}
              onClick={() => onChange({ ...chain, steps: chain.steps.filter((_, j) => j !== i) })}>Remove</button></td>
          </tr>
        ))}</tbody>
      </table>
      <p className="va-subtlest" style={{ fontSize: 12 }}>
        Roles defined in Approver roles. Create a grant there first to add new roles. Roles must be granted on the {scope} work type.
      </p>
      <div className="va-row" style={{ gap: 12, marginTop: 8, alignItems: 'center' }}>
        <button className="va-button" disabled={busy || chain.steps.length >= 6}
          onClick={() => onChange({ ...chain, steps: [...chain.steps, { label: '', role: '', meaning: '' }] })}>Add step</button>
        <label><input type="checkbox" checked={chain.distinctSigners} disabled={busy}
          onChange={e => onChange({ ...chain, distinctSigners: e.target.checked })} /> Each step must be signed by a different person</label>
      </div>
    </Section>
  );
}
