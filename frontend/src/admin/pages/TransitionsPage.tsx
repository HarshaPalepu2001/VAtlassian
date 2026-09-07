import { useState, useEffect } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Textfield from '@atlaskit/textfield';

import {
  Badge, Card, EmptyState, Field, Name, Page, ProjectLink, Section, Select, StatusFlow, Table
} from '../../ui/primitives';
import { AssuranceChip } from '../../ui/feedback';
import type { AssuranceLevel } from '../../lib/assurance';
import { ASSURANCE_LABELS } from '../../lib/assurance';
import { formatDate } from '../../ui/format';

type Project = { id: string; key: string; name: string };
type IssueType = { id: string; name: string };
type Status = { id: string; name: string };

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
  const [fromStatus, setFromStatus] = useState('');
  const [toStatus, setToStatus] = useState('');
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
    if (!projectId) { setIssueTypes([]); return; }
    invoke('admin:listStatusesForProject', { projectId, issueTypeId: '' })
      .then((r: any) => { if (r.success) setProjectStatuses(r.statuses ?? []); });
      
    invoke('admin:listIssueTypesForProject', { projectId })
      .then((r: any) => { if (r.success) setIssueTypes(r.issueTypes ?? []); });
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !issueTypeId) { setProjectStatuses([]); return; }
    invoke('admin:listStatusesForProject', { projectId, issueTypeId })
      .then((r: any) => { if (r.success) setProjectStatuses(r.statuses ?? []); });
  }, [projectId, issueTypeId]);

  useEffect(() => {
    if (!projectId || !issueTypeId) {
      setAvailableRoles([]);
      setRole('');
      return;
    }
    invoke('admin:listAvailableRoles', { projectId, issueTypeId })
      .then((r: any) => {
        if (r.success) {
          setAvailableRoles(r.roles ?? []);
          if (role && !(r.roles ?? []).includes(role)) setRole('');
        }
      });
  }, [projectId, issueTypeId]);

  const complete = projectId && issueTypeId && fromStatus && toStatus && role.trim() && meaning.trim();

  const handleCreate = async () => {
    setMessage(null);
    if (!complete) {
      setMessage({ type: 'error', text: 'Fill in every field except the optional decline destination.' });
      return;
    }
    setSaving(true);
    try {
      const result = await invoke('admin:createControlledTransition', {
        projectId, issueTypeId, fromStatusId: fromStatus, toStatusId: toStatus,
        requiredAssurance,captureBaseline,blockOnDrift,requiredRole: role.trim(), meaning: meaning.trim(), rejectToStatusId: rejectStatus || null
      }) as { success: boolean; error?: string };

      if (result.success) {
        const project = projects.find((p) => p.id === projectId);
        setMessage({
          type: 'success',
          text: `Approval now required${project ? ` in ${project.name}` : ''} for "${meaning.trim()}".`
        });
        setRole(''); setMeaning(''); setRejectStatus(''); setFromStatus(''); setToStatus('');
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

  const statusOptions = projectStatuses.map((s) => ({ value: s.id, label: s.name }));
  const fromStatusOptions = [
    { value: '*', label: 'Any status' },
    ...statusOptions
  ];

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
              onChange={(value) => { setProjectId(value); setIssueTypeId(''); setFromStatus(''); setToStatus(''); setRejectStatus(''); }}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
            />
          </Field>
          <Field label="Work item type">
            <Select
              placeholder="Choose a type…"
              value={issueTypeId}
              disabled={!projectId}
              onChange={(value) => { setIssueTypeId(value); setFromStatus(''); setToStatus(''); setRejectStatus(''); }}
              options={[{value:'*',label:'All work item types'},...issueTypes.map((t) => ({ value: t.id, label: t.name }))]}
            />
          </Field>
          <Field label="Moving from">
            <Select
              placeholder="Current status…"
              value={fromStatus}
              disabled={!issueTypeId}
              onChange={setFromStatus}
              options={fromStatusOptions}
            />
          </Field>
          <Field label="Moving to">
            <Select
              placeholder="New status…"
              value={toStatus}
              disabled={!issueTypeId}
              onChange={setToStatus}
              options={statusOptions}
            />
          </Field>
        </div>

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

        <div className="va-form-grid" style={{marginTop:16}}><Field label="Required assurance"><Select value={requiredAssurance} onChange={v=>setAssurance(v as AssuranceLevel)} placeholder="Choose assurance" options={Object.entries(ASSURANCE_LABELS).map(([value,label])=>({value,label:label+(['JSM_APPROVAL','BIOMETRIC'].includes(value)?' (not configured)':'')}))}/></Field><Field label="Capture approved baseline"><input type="checkbox" checked={captureBaseline} onChange={e=>setCapture(e.target.checked)}/></Field><Field label="Block transition on unresolved drift"><input type="checkbox" checked={blockOnDrift} onChange={e=>setBlock(e.target.checked)}/></Field></div>
        <div className="va-form-actions">
          <Button appearance="primary" onClick={handleCreate} isDisabled={saving || !complete}>
            {saving ? 'Adding…' : 'Add rule'}
          </Button>
          <span className="va-hint">
            {complete ? 'Takes effect immediately.' : 'Choose a project, type, both statuses, a role and a meaning.'}
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
