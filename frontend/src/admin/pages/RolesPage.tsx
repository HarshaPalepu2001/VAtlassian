import { useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Textfield from '@atlaskit/textfield';
import UserPicker from '../UserPicker';
import { assertResult, errorMessage } from '../../lib/result';

import {
  Badge, Card, EmptyState, Field, Name, Page, Person, Section, Select, Table
} from '../../ui/primitives';
import { formatDate } from '../../ui/format';
import { useConfigurationUpdates } from '../../lib/configurationUpdates';

type Project = { id: string; key: string; name: string };
type IssueType = { id: string; name: string };
type JiraUser = { accountId: string; displayName: string; emailAddress?: string };

/**
 * The server resolves account and issue type ids to names and omits the ids
 * from its response. This screen must not expose signers' account ids.
 */
type EligibilityGrant = {
  elId: string;
  signerName: string | null;
  signerActive: boolean;
  issueTypeName: string | null;
  role: string;
  scope: string;
  grantedAt: number | null;
  grantedByName: string | null;
};

const COLUMNS = [
  { key: 'signer', label: 'Signer' },
  { key: 'role', label: 'May sign as' },
  { key: 'issueType', label: 'On work item type' },
  { key: 'scope', label: 'Project scope' },
  { key: 'granted', label: 'Granted' },
  { key: 'actions', label: '', align: 'right' as const }
];

export default function RolesPage({ projects }: { projects: Project[] }) {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [grants, setGrants] = useState<EligibilityGrant[]>([]);
  const [issueTypes, setIssueTypes] = useState<IssueType[]>([]);

  const [projectId, setProjectId] = useState('');
  const [issueTypeId, setIssueTypeId] = useState('');
  const [role, setRole] = useState('');

  const [selectedUser, setSelectedUser] = useState<JiraUser | null>(null);

  const [filter, setFilter] = useState('');
  const grantsSequence = useRef(0);

  // A background refresh keeps the grants and the form usable, replacing the
  // list only on success; it never disables Grant while the person is typing.
  const loadGrants = async (quiet?: unknown) => {
    const background = quiet === true;
    const seq = ++grantsSequence.current;
    if (!background) { setLoading(true); setLoaded(false); setGrants([]); }
    try {
      const response = await invoke('admin:listEligibility', {}) as
        { success: boolean; grants?: EligibilityGrant[]; error?: string };
      if (seq !== grantsSequence.current) return;
      if (response.success) {setGrants(response.grants ?? []);setLoaded(true);}
      else if (!background) setMessage({ type: 'error', text: response.error || 'Failed to load approver eligibility.' });
    } catch (err: any) {
      if (seq !== grantsSequence.current || background) return;
      setMessage({ type: 'error', text: err.message || 'Failed to load approver eligibility.' });
    } finally {
      if (seq === grantsSequence.current && !background) setLoading(false);
    }
  };

  useEffect(() => { void loadGrants(); return () => { ++grantsSequence.current; }; }, []);
  // Quiet over a loaded page; during a load it simply supersedes it.
  useConfigurationUpdates(() => { if (!saving) return loadGrants(!loading); });

  useEffect(() => {
    let active = true;
    setIssueTypes([]);
    if (projectId) invoke('admin:listIssueTypesForProject', { projectId })
      .then((r: any) => { assertResult(r); if (active) setIssueTypes(r.issueTypes ?? []); })
      .catch(e => { if (active) setMessage({ type: 'error', text: errorMessage(e) }); });
    return () => { active = false; };
  }, [projectId]);

  const isSiteWide = projectId === '*';
  const complete = Boolean(loaded && selectedUser && projectId && issueTypeId && role.trim());

  const handleGrant = async () => {
    setMessage(null);
    if (!complete) {
      setMessage({ type: 'error', text: 'Choose a person, a work item type, and the role they may sign as.' });
      return;
    }
    setSaving(true);
    try {
      const result = await invoke('admin:grantEligibility', {
        targetAccountId: selectedUser!.accountId,
        issueTypeId,
        role: role.trim(),
        projectId: isSiteWide ? '*' : projectId
      }) as { success: boolean; error?: string };

      if (result.success) {
        setMessage({
          type: 'success',
          text: `${selectedUser!.displayName} may now sign as "${role.trim()}"${isSiteWide ? ' across all projects' : ''}.`
        });
        setSelectedUser(null); setRole('');
        await loadGrants();
      } else {
        setMessage({ type: 'error', text: result.error || 'Failed to grant eligibility.' });
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to grant eligibility.' });
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (grant: EligibilityGrant) => {
    if (saving) return;
    setSaving(true); setMessage(null);
    try {
      assertResult(await invoke('admin:revokeEligibility', { elId: grant.elId }) as any);
      await loadGrants();
    } catch (e) { setMessage({ type: 'error', text: errorMessage(e) }); }
    finally { setSaving(false); }
  };

  // Filtering is client-side against the names already on screen. The previous
  // version refetched with an issueTypeId filter driven by the same selector
  // the grant form used, so choosing who to grant a role to silently changed
  // which grants were listed below.
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return grants;
    return grants.filter((grant) =>
      [grant.signerName, grant.role, grant.issueTypeName]
        .some((value) => (value ?? '').toLowerCase().includes(needle))
    );
  }, [grants, filter]);

  const deactivated = grants.filter((grant) => !grant.signerActive).length;

  return (
    <Page eyebrow="Setup" title="Approver roles" actions={<Button isDisabled={saving || loading} onClick={loadGrants}>Refresh roles</Button>}>
      {message && (
        <div style={{ marginBottom: '20px' }}>
          <SectionMessage appearance={message.type}>
            <p>{message.text}</p>{message.type==='error'&&<Button isDisabled={saving} onClick={loadGrants}>Retry loading roles</Button>}
          </SectionMessage>
        </div>
      )}

      {deactivated > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <SectionMessage appearance="warning" title="Deactivated users still hold roles">
            <p>
              {deactivated === 1
                ? 'One person below has been deactivated in Jira but still holds approver eligibility.'
                : `${deactivated} people below have been deactivated in Jira but still hold approver eligibility.`}{' '}
              The daily reconciliation removes these automatically; revoke now if you would
              rather not wait.
            </p>
          </SectionMessage>
        </div>
      )}

      <Card
        title="Grant a role"
        subtitle="Add people to an existing role or name a new role. Choose the projects and work item types it covers."
      >
        <fieldset disabled={saving} style={{border:0,padding:0,margin:0,minWidth:0}}><div className="va-form-grid va-form-grid--wide">
          <UserPicker value={selectedUser} onChange={setSelectedUser} />

          <Field label="Project" hint={isSiteWide ? "This grant applies across all projects on this site." : "This grant applies only to the selected project."}>
            <Select
              placeholder="Choose a project…"
              value={projectId}
              onChange={(value) => { setProjectId(value); setIssueTypeId(value === '*' ? '*' : ''); }}
              options={[{ value: '*', label: 'All projects (Site-wide)' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            />
          </Field>

          <Field label="Work item type">
            <Select
              placeholder="Choose a type…"
              value={issueTypeId}
              disabled={!projectId}
              onChange={setIssueTypeId}
              options={[{value:'*',label:'All work item types'},...issueTypes.map((t) => ({ value: t.id, label: t.name }))]}
            />
          </Field>

          <Field label="May sign as" hint="Choose an existing role or enter a new one. Role names match controlled transitions exactly.">
            <Textfield
              list="va-existing-roles"
              placeholder="QA Lead"
              value={role}
              maxLength={32}
              onChange={(e: any) => setRole(e.target.value)}
            />
            <datalist id="va-existing-roles">{[...new Set(grants.map(g => g.role))].sort().map(name => <option key={name} value={name} />)}</datalist>
          </Field>
        </div>

        <div className="va-form-actions">
          <Button appearance="primary" onClick={handleGrant} isDisabled={saving || !complete}>
            {saving ? 'Granting…' : 'Grant role'}
          </Button>
          <span className="va-hint">
            {complete ? 'Takes effect immediately.' : 'Choose a person, a work item type, and a role.'}
          </span>
        </div>
      </fieldset></Card>

      <Section title={`Who can approve${grants.length ? ` (${grants.length})` : ''}`}>
        {grants.length > 3 && (
          <div style={{ maxWidth: '320px', marginBottom: '12px' }}>
            <Textfield
              placeholder="Filter by name, role or type…"
              value={filter}
              onChange={(e: any) => setFilter(e.target.value)}
            />
          </div>
        )}
        <Card flush>
          {loading ? (
            <EmptyState title="Loading eligibility…" />
          ) : !loaded ? <EmptyState title="Eligibility is unavailable. Retry loading before making changes."/> : grants.length === 0 ? (
            <EmptyState title="Nobody is eligible to sign yet">
              A controlled transition whose role nobody holds cannot be signed by anyone, and
              the validator will refuse it for every user.
            </EmptyState>
          ) : visible.length === 0 ? (
            <EmptyState title="No grants match that filter" />
          ) : (
            <Table columns={COLUMNS}>
              {visible.map((grant) => (
                <tr key={grant.elId}>
                  <td>
                    <Person
                      name={grant.signerName}
                      noun="signer"
                      meta={grant.signerActive ? undefined : 'Deactivated in Jira'}
                    />
                  </td>
                  <td><Badge tone="brand">{grant.role}</Badge></td>
                  <td><Name value={grant.issueTypeName} noun="work item type" /></td>
                  <td>{grant.scope}</td>
                  <td className="va-muted">
                    {formatDate(grant.grantedAt) ?? '—'}
                    {grant.grantedByName && (
                      <div className="va-secondary">by {grant.grantedByName}</div>
                    )}
                  </td>
                  <td className="va-table__actions">
                    <Button appearance="subtle" isDisabled={saving} onClick={() => handleRevoke(grant)}>Revoke</Button>
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
