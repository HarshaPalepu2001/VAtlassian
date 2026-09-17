import { useState, useEffect, useRef } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Textfield from '@atlaskit/textfield';

import {
  Badge, Card, EmptyState, Facts, Field, Name, Page, ProjectLink, Section, Select, StatusFlow, Table
} from '../../ui/primitives';
import { AssuranceChip } from '../../ui/feedback';
import type { AssuranceLevel } from '../../lib/assurance';
import { CONTROLLED_TRANSITION_ASSURANCE_OPTIONS } from '../../lib/assurance';
import { formatDate } from '../../ui/format';

type Project = { id: string; key: string; name: string };
type IssueType = { id: string; name: string };
type Status = { id: string; name: string };

/**
 * One exact edge from admin:listWorkflowTransitions — Jira's live workflow,
 * read fresh every time project or work item type changes. Nothing here is
 * typed in by an administrator; it is exactly what workflowSource.js read.
 */
type WorkflowTransition = {
  transitionId: string;
  name: string;
  fromStatusId: string;
  fromStatusName: string | null;
  toStatusId: string;
  toStatusName: string | null;
  global: boolean;
  hasScreen: boolean;
  validatorAttached: boolean;
  jiraRules: { conditions: boolean; otherValidators: number; postFunctions: number };
};

/** Two Jira transitions can share a destination status (and, for a DIRECTED
 *  transition reachable from several statuses, even a transition id) — see
 *  transitionsValidation.js's "exact Jira transition" doc. `transitionId`
 *  alone is not a unique option key; the pair is. */
const optionKey = (t: WorkflowTransition) => `${t.transitionId}:${t.fromStatusId}`;

/**
 * Note what is NOT on this type: project_id, issue_type_id, from_status_id,
 * to_status_id. admin:listControlledTransitions resolves those to names
 * server-side and no longer returns the ids at all, so there is nothing for
 * this screen to accidentally print. `ctId` is the exception — revoking a
 * rule has to name one — and it is never rendered.
 */
type ControlledTransition = {
  ctId: string;
  requiredAssurance: AssuranceLevel;
  captureBaseline: boolean;
  blockOnDrift: boolean;
  projectKey: string | null;
  projectName: string | null;
  issueTypeName: string | null;
  fromStatusName: string | null;
  toStatusName: string | null;
  rejectConfigured: boolean;
  rejectToStatusName: string | null;
  requiredRole: string;
  meaning: string;
  createdAt: number | null;
  createdByName: string | null;
};

const COLUMNS = [
  { key: 'scope', label: 'Applies to' },
  { key: 'transition', label: 'Transition' },
  { key: 'meaning', label: 'Signature means' },
  { key: 'role', label: 'Signed by' },
  { key: 'reject', label: 'If declined' },
  { key: 'actions', label: '', align: 'right' as const }
];

export default function TransitionsPage({ projects }: { projects: Project[] }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [transitions, setTransitions] = useState<ControlledTransition[]>([]);
  const [issueTypes, setIssueTypes] = useState<IssueType[]>([]);
  const [projectStatuses, setProjectStatuses] = useState<Status[]>([]);

  const [projectId, setProjectId] = useState('');
  const [issueTypeId, setIssueTypeId] = useState('');

  // The exact edge picker. Discovery re-reads Jira's live workflow every time
  // project or work item type changes; nothing here is carried over from an
  // earlier read once either scope input changes.
  const [workflowTransitions, setWorkflowTransitions] = useState<WorkflowTransition[]>([]);
  const [discovery, setDiscovery] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [selectedKey, setSelectedKey] = useState('');
  const discoverySeq = useRef(0);
  const statusSeq = useRef(0);

  const [role, setRole] = useState('');
  const [meaning, setMeaning] = useState('');
  const [requiredAssurance,setAssurance]=useState<AssuranceLevel>('ESIGNATURE');
  const [captureBaseline,setCapture]=useState(true);
  const [blockOnDrift,setBlock]=useState(true);
  const [rejectStatus, setRejectStatus] = useState('');
  const [availableRoles, setAvailableRoles] = useState<string[]>([]);

  const loadTransitions = async () => {
    try {
      const response = await invoke('admin:listControlledTransitions') as
        { success: boolean; transitions?: ControlledTransition[]; error?: string };

      if (response.success) setTransitions(response.transitions ?? []);
      else setMessage({ type: 'error', text: response.error || 'Failed to load controlled transitions.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to load data.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadTransitions(); }, []);

  useEffect(() => {
    let active = true;
    const seq = ++statusSeq.current;
    if (!projectId) { setIssueTypes([]); setProjectStatuses([]); return () => { active = false; }; }
    setIssueTypes([]);
    invoke('admin:listStatusesForProject', { projectId, issueTypeId: '' })
      .then((r: any) => { if (active && seq === statusSeq.current && r.success) setProjectStatuses(r.statuses ?? []); });
    invoke('admin:listIssueTypesForProject', { projectId })
      .then((r: any) => { if (active && r.success) setIssueTypes(r.issueTypes ?? []); });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    if (!projectId) { ++statusSeq.current; setProjectStatuses([]); return () => { active = false; }; }
    if (!issueTypeId) return () => { active = false; };
    const seq = ++statusSeq.current;
    invoke('admin:listStatusesForProject', { projectId, issueTypeId })
      .then((r: any) => { if (active && seq === statusSeq.current && r.success) setProjectStatuses(r.statuses ?? []); });
    return () => { active = false; };
  }, [projectId, issueTypeId]);

  useEffect(() => {
    let active = true;
    if (!projectId || !issueTypeId) {
      setAvailableRoles([]);
      setRole('');
      return () => { active = false; };
    }
    setAvailableRoles([]);
    invoke('admin:listAvailableRoles', { projectId, issueTypeId })
      .then((r: any) => {
        if (!active) return;
        if (r.success) {
          const roles = r.roles ?? [];
          setAvailableRoles(roles);
          setRole(cur => (cur && !roles.includes(cur) ? '' : cur));
        }
      });
    return () => { active = false; };
  }, [projectId, issueTypeId]);

  // The transition picker. A change to either scope input invalidates
  // whatever was selected — Jira's workflow for a different project or work
  // item type may not even have the same transition ids — so the selection
  // and the offered options are cleared before the new read starts, never
  // after it lands, so nothing stale can be picked while a newer read is in
  // flight. `discoverySeq` drops a response overtaken by a later one; save
  // stays disabled for the whole of `loading`, so an overtaken response
  // cannot be told apart from one that is simply slow.
  useEffect(() => {
    const seq = ++discoverySeq.current;
    setSelectedKey('');
    setWorkflowTransitions([]);
    if (!projectId || !issueTypeId) { setDiscovery('idle'); return; }
    setDiscovery('loading');
    invoke('admin:listWorkflowTransitions', { projectId, issueTypeId })
      .then((r: any) => {
        if (discoverySeq.current !== seq) return;
        if (r.success) { setWorkflowTransitions(r.transitions ?? []); setDiscovery('loaded'); }
        else { setDiscovery('error'); setMessage({ type: 'error', text: r.error || 'Could not read the live Jira workflow.' }); }
      })
      .catch((err: any) => {
        if (discoverySeq.current !== seq) return;
        setDiscovery('error');
        setMessage({ type: 'error', text: err.message || 'Could not read the live Jira workflow.' });
      });
  }, [projectId, issueTypeId]);

  const selectedTransition = workflowTransitions.find((t) => optionKey(t) === selectedKey) ?? null;
  // A transition with no enabled va-gate of ours cannot be enforced no matter
  // what is saved — Jira would never call this app on it. That is a blocking
  // finding, not a soft warning: saving must stay disabled until it clears.
  const blockingFinding = selectedTransition != null && !selectedTransition.validatorAttached;

  const transitionOptions = workflowTransitions.map((t) => ({
    value: optionKey(t),
    label: `${t.global ? 'Any status' : t.fromStatusName} -> ${t.toStatusName} - ${t.name} (#${t.transitionId})`
  }));
  const statusOptions = projectStatuses.map((s) => ({ value: s.id, label: s.name }));

  const complete = Boolean(projectId && issueTypeId && selectedTransition && role.trim() && meaning.trim());
  const canSave = complete && discovery === 'loaded' && !blockingFinding;

  const handleCreate = async () => {
    setMessage(null);
    if (!canSave || !selectedTransition) {
      setMessage({ type: 'error', text: 'Choose a project, type, an exact transition, a role and a meaning.' });
      return;
    }
    setSaving(true);
    try {
      const result = await invoke('admin:createControlledTransition', {
        projectId, issueTypeId,
        transitionId: selectedTransition.transitionId,
        fromStatusId: selectedTransition.fromStatusId,
        toStatusId: selectedTransition.toStatusId,
        requiredAssurance,captureBaseline,blockOnDrift,requiredRole: role.trim(), meaning: meaning.trim(), rejectToStatusId: rejectStatus || null
      }) as { success: boolean; error?: string };

      if (result.success) {
        const project = projects.find((p) => p.id === projectId);
        setMessage({
          type: 'success',
          text: `Approval now required${project ? ` in ${project.name}` : ''} for "${meaning.trim()}".`
        });
        setRole(''); setMeaning(''); setRejectStatus(''); setSelectedKey('');
        await loadTransitions();
      } else {
        setMessage({ type: 'error', text: result.error || 'Failed to add the rule.' });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to add the rule.' });
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (rule: ControlledTransition) => {
    const result = await invoke('admin:revokeControlledTransition', { ctId: rule.ctId }) as
      { success: boolean; error?: string };
    if (result.success) {
      setMessage({ type: 'success', text: `"${rule.meaning}" no longer requires approval.` });
      await loadTransitions();
    } else {
      setMessage({ type: 'error', text: result.error || 'Failed to remove the rule.' });
    }
  };

  return (
    <Page eyebrow="Setup" title="Controlled transitions">
      {message && (
        <div style={{ marginBottom: '20px' }}>
          <SectionMessage appearance={message.type}>
            <p>{message.text}</p>
          </SectionMessage>
        </div>
      )}

      <Card
        title="Require an approval"
        subtitle="Company-managed projects only — team-managed projects cannot express segregation of duties."
      >
        <div className="va-form-grid">
          <Field label="Project">
            <Select
              placeholder="Choose a project…"
              value={projectId}
              onChange={(value) => { setProjectId(value); setIssueTypeId(''); setRejectStatus(''); }}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
            />
          </Field>
          <Field label="Work item type">
            <Select
              placeholder="Choose a type…"
              value={issueTypeId}
              disabled={!projectId}
              onChange={(value) => { setIssueTypeId(value); setRejectStatus(''); }}
              options={issueTypes.map((t) => ({ value: t.id, label: t.name }))}
            />
          </Field>
          <Field
            label="Exact transition"
            hint={
              discovery === 'loading' ? 'Reading the live Jira workflow…'
              : discovery === 'error' ? 'Could not read the live Jira workflow.'
              : discovery === 'loaded' && transitionOptions.length === 0 ? 'This workflow has no controllable transitions.'
              : 'Read live from Jira — the exact edge, not a status guess.'
            }
          >
            <Select
              placeholder="Choose the exact transition…"
              value={selectedKey}
              disabled={!issueTypeId || discovery !== 'loaded'}
              onChange={setSelectedKey}
              options={transitionOptions}
            />
          </Field>
        </div>

        {selectedTransition && (
          <div style={{ marginTop: '12px' }}>
            <Facts items={[
              { label: 'Has a transition screen', value: selectedTransition.hasScreen ? 'Yes' : 'No' },
              {
                label: 'Signature validator',
                value: selectedTransition.validatorAttached
                  ? 'Attached and enabled'
                  : <span className="va-unknown">Not attached — this edge cannot be enforced yet</span>
              },
              {
                label: 'Other Jira rules on this edge',
                value: `${selectedTransition.jiraRules.otherValidators} other validator(s), ${selectedTransition.jiraRules.postFunctions} post function(s)${selectedTransition.jiraRules.conditions ? ', has conditions' : ''}`
              }
            ]} />
          </div>
        )}

        <div className="va-form-grid va-form-grid--wide" style={{ marginTop: '16px' }}>
          <Field label="Who must sign" hint="Roles defined in Approver roles. Create a grant there first to add new roles.">
            <Select
              placeholder="Choose a role…"
              value={role}
              onChange={setRole}
              disabled={!projectId || !issueTypeId}
              options={availableRoles.map(r => ({ value: r, label: r }))}
            />
          </Field>
          <Field
            label="What the signature means"
            hint="Shown to the signer as the statement they are attesting to. Write it as a declaration."
          >
            <Textfield
              placeholder="Approved for release"
              value={meaning}
              maxLength={32}
              onChange={(e: any) => setMeaning(e.target.value)}
            />
          </Field>
          <Field
            label="If declined, send back to"
            hint="Optional. Leave empty to leave a declined work item exactly where it is."
          >
            <Select
              placeholder="Stay where it is"
              value={rejectStatus}
              disabled={!issueTypeId}
              onChange={setRejectStatus}
              options={statusOptions}
            />
          </Field>
        </div>

        <div className="va-form-grid" style={{marginTop:16}}><Field label="Required assurance" hint={requiredAssurance==='BIOMETRIC'
          ? 'Add the "Biometric Authentication" field to this transition screen.'
          : 'Add the "Electronic Signature" field to this transition screen.'}><Select value={requiredAssurance} onChange={v=>setAssurance(v as AssuranceLevel)} placeholder="Choose assurance" options={CONTROLLED_TRANSITION_ASSURANCE_OPTIONS}/></Field><Field label="Capture approved baseline"><input type="checkbox" checked={captureBaseline} onChange={e=>setCapture(e.target.checked)}/></Field><Field label="Block transition on unresolved drift"><input type="checkbox" checked={blockOnDrift} onChange={e=>setBlock(e.target.checked)}/></Field></div>
        <div className="va-form-actions">
          <Button appearance="primary" onClick={handleCreate} isDisabled={saving || !canSave}>
            {saving ? 'Adding…' : 'Add rule'}
          </Button>
          <span className="va-hint">
            {blockingFinding
              ? 'Attach the signature validator to this transition in Jira before it can be controlled.'
              : canSave ? 'Takes effect immediately.' : 'Choose a project, type, exact transition, a role and a meaning.'}
          </span>
        </div>
      </Card>

      <Section title={`Active rules${transitions.length ? ` (${transitions.length})` : ''}`}>
        <Card flush>
          {loading ? (
            <EmptyState title="Loading rules…" />
          ) : transitions.length === 0 ? (
            <EmptyState title="No transitions are controlled yet">
              Until a rule exists here, no workflow transition requires approval and the
              validator has nothing to enforce.
            </EmptyState>
          ) : (
            <Table columns={COLUMNS}>
              {transitions.map((rule) => (
                <tr key={rule.ctId}>
                  <td>
                    <div className="va-primary">
                      <ProjectLink projectKey={rule.projectKey} name={rule.projectName} />
                    </div>
                    <div className="va-secondary">
                      <Name value={rule.issueTypeName} noun="work item type" />
                    </div>
                  </td>
                  <td>
                    <StatusFlow
                      from={<Badge tone="neutral"><Name value={rule.fromStatusName} noun="status" /></Badge>}
                      to={<Badge tone="brand"><Name value={rule.toStatusName} noun="status" /></Badge>}
                    />
                  </td>
                  <td>
                    <div className="va-primary">{rule.meaning}</div><AssuranceChip level={rule.requiredAssurance}/><p className="va-secondary">{rule.captureBaseline?'Captures baseline':'No baseline capture'} · {rule.blockOnDrift?'Blocks drift':'Allows unresolved drift'}</p>
                    {rule.createdAt != null && (
                      <div className="va-secondary">
                        Added {formatDate(rule.createdAt)}
                        {rule.createdByName ? ` by ${rule.createdByName}` : ''}
                      </div>
                    )}
                  </td>
                  <td><Badge tone="neutral">{rule.requiredRole}</Badge></td>
                  <td className="va-muted">
                    {rule.rejectConfigured
                      ? <StatusFlow from={<span />} to={<Name value={rule.rejectToStatusName} noun="status" />} />
                      : <>Stays at <Name value={rule.fromStatusName} noun="status" /></>}
                  </td>
                  <td className="va-table__actions">
                    <Button appearance="subtle" onClick={() => handleRevoke(rule)}>Remove</Button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </Section>
    </Page>
  );
}
