import { useState, useEffect, useMemo } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import Textfield from '@atlaskit/textfield';

import {
  Badge, Card, EmptyState, Field, Name, Page, Person, Section, Select, Table
} from '../../ui/primitives';
import { formatDate } from '../../ui/format';

type Project = { id: string; key: string; name: string };
type IssueType = { id: string; name: string };
type JiraUser = { accountId: string; displayName: string; emailAddress?: string };

/**
 * As with the transitions list, the account id and issue type id are resolved
 * server-side and not returned. This screen used to have two columns headed
 * "Account ID" and "Issue Type ID" — a directory of every signer's Atlassian
 * account id, printed for an audience that cannot do anything with one.
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [grants, setGrants] = useState<EligibilityGrant[]>([]);
  const [issueTypes, setIssueTypes] = useState<IssueType[]>([]);

  const [projectId, setProjectId] = useState('');
  const [issueTypeId, setIssueTypeId] = useState('');
  const [role, setRole] = useState('');

  const [userQuery, setUserQuery] = useState('');
  const [userResults, setUserResults] = useState<JiraUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<JiraUser | null>(null);

  const [filter, setFilter] = useState('');

  const loadGrants = async () => {
    try {
      const response = await invoke('admin:listEligibility', {}) as
        { success: boolean; grants?: EligibilityGrant[]; error?: string };
      if (response.success) setGrants(response.grants ?? []);
      else setMessage({ type: 'error', text: response.error || 'Failed to load approver eligibility.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to load approver eligibility.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadGrants(); }, []);

  useEffect(() => {
    if (!projectId) { setIssueTypes([]); return; }
    invoke('admin:listIssueTypesForProject', { projectId })
      .then((r: any) => { if (r.success) setIssueTypes(r.issueTypes ?? []); });
  }, [projectId]);

  useEffect(() => {
    const handle = setTimeout(async () => {
      if (userQuery.trim().length < 2 || selectedUser) { setUserResults([]); return; }
      const response = await invoke('admin:searchUsers', { query: userQuery }) as
        { success: boolean; users?: JiraUser[] };
      if (response.success) setUserResults(response.users ?? []);
    }, 300);
    return () => clearTimeout(handle);
  }, [userQuery, selectedUser]);

  const complete = selectedUser && issueTypeId && role.trim();

  const handleGrant = async () => {
    setMessage(null);
    if (!complete) {
      setMessage({ type: 'error', text: 'Choose a person, a work item type, and the role they may sign as.' });
      return;
    }
    setSaving(true);
    try {
      const result = await invoke('admin:grantEligibility', {
        targetAccountId: selectedUser!.accountId, issueTypeId, role: role.trim(), projectId
      }) as { success: boolean; error?: string };

      if (result.success) {
        setMessage({
          type: 'success',
          text: `${selectedUser!.displayName} may now sign as "${role.trim()}".`
        });
        setSelectedUser(null); setUserQuery(''); setRole('');
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
    const result = await invoke('admin:revokeEligibility', { elId: grant.elId }) as
      { success: boolean; error?: string };
    if (result.success) {
      setMessage({
        type: 'success',
        text: `${grant.signerName ?? 'That signer'} can no longer sign as "${grant.role}".`
      });
      await loadGrants();
    } else {
      setMessage({ type: 'error', text: result.error || 'Failed to revoke eligibility.' });
    }
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
    <Page eyebrow="Setup" title="Approver roles">
      {message && (
        <div style={{ marginBottom: '20px' }}>
          <SectionMessage appearance={message.type}>
            <p>{message.text}</p>
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
        subtitle="Eligibility is granted per work item type, so a Change Request approver is not automatically a Deviation approver."
      >
        <div className="va-form-grid va-form-grid--wide">
          <div className="va-field va-typeahead">
            <span className="va-label">Person</span>
            {selectedUser ? (
              <div className="va-typeahead__selected">
                <Person name={selectedUser.displayName} meta={selectedUser.emailAddress} />
                <span className="va-spacer" />
                <Button
                  appearance="subtle"
                  onClick={() => { setSelectedUser(null); setUserQuery(''); }}
                >
                  Change
                </Button>
              </div>
            ) : (
              <>
                <Textfield
                  placeholder="Search by name or email…"
                  value={userQuery}
                  onChange={(e: any) => setUserQuery(e.target.value)}
                />
                {userResults.length > 0 && (
                  <div className="va-typeahead__menu">
                    {userResults.map((user) => (
                      <button
                        type="button"
                        key={user.accountId}
                        className="va-typeahead__option"
                        onClick={() => { setSelectedUser(user); setUserResults([]); }}
                      >
                        <Person name={user.displayName} meta={user.emailAddress} />
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <Field label="Project" hint="Used to narrow the work item types below.">
            <Select
              placeholder="Choose a project…"
              value={projectId}
              onChange={(value) => { setProjectId(value); setIssueTypeId(''); }}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
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

          <Field label="May sign as" hint="Must match the role named on the controlled transition, exactly.">
            <Textfield
              placeholder="QA Lead"
              value={role}
              maxLength={32}
              onChange={(e: any) => setRole(e.target.value)}
            />
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
      </Card>

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
          ) : grants.length === 0 ? (
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
                    <Button appearance="subtle" onClick={() => handleRevoke(grant)}>Revoke</Button>
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
