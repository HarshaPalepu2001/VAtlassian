import { useCallback, useEffect, useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Badge, Card, Loading, Page, Table } from '../../ui/primitives';
import { Notice, When } from '../../ui/feedback';
import { assertResult, errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { JiraUser } from '../types';
import UserPicker from '../UserPicker';
type Grant = { accountId: string; forName?: string; issuedByName?: string; issuedAt: number; expiresAt: number; status: string };
type Credential = { accountId: string; displayName?: string; state: string; lastVerifiedAt?: number };
export default function CredentialsPage() {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [person, setPerson] = useState<JiraUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError(''); setGrants(null); setCredentials(null);
    try {
      const [g, c] = await Promise.all([
        invoke<Result & { grants: Grant[] }>('admin:listCredentialResetGrants'),
        invoke<Result & { credentials: Credential[]; hasMore?: boolean }>('admin:listCredentials')
      ]);
      assertResult(g); assertResult(c); setGrants(g.grants); setCredentials(c.credentials); setHasMore(c.hasMore === true);
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function issue() {
    if (!person || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      assertResult(await invoke<Result>('admin:issueCredentialResetGrant', { targetAccountId: person.accountId }));
      setMessage(`Reset authorized for ${person.displayName}. They can enroll a replacement authenticator in personal settings.`);
      setPerson(null); await load();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <Page eyebrow="Operations" title="Credentials & recovery" actions={<Button isDisabled={busy || loading} onClick={load}>Refresh</Button>}><div className="va-stack">
    {error && <Notice danger>{error} <Button isDisabled={busy || loading} onClick={load}>Retry</Button></Notice>}{message && <Notice>{message}</Notice>}
    <Card title="Authorize authenticator replacement"><p>Another administrator must authorize recovery; you cannot authorize your own reset. The grant is time limited and can be used once.</p><fieldset disabled={busy} style={{border:0,padding:0,margin:0,minWidth:0}}><UserPicker value={person} onChange={setPerson} /><Button appearance="primary" isDisabled={busy || !person} onClick={issue}>{busy ? 'Authorizing…' : 'Issue reset grant'}</Button></fieldset></Card>
    {loading ? <Loading label="Loading credentials and recovery history…" /> : <>
      <Card title="Authenticator credentials" flush>{credentials === null ? <p>Credential status is unavailable.</p> : !credentials.length ? <p>No authenticator credentials recorded.</p> : <Table columns={[{key:'person',label:'Person'},{key:'state',label:'Status'},{key:'last',label:'Last verified'}]}>{credentials.map(c=><tr key={c.accountId}><td>{c.displayName??'Unknown person'}</td><td><Badge>{c.state}</Badge></td><td><When ms={c.lastVerifiedAt}/></td></tr>)}</Table>}{hasMore&&<Notice>Showing the first 200 credentials.</Notice>}</Card>
      <Card title="Recovery history" flush>{grants === null ? <p>Recovery history is unavailable.</p> : !grants.length ? <p>No reset grants recorded.</p> : <><Table columns={[{ key: 'person', label: 'Person' }, { key: 'issuer', label: 'Authorized by' }, { key: 'time', label: 'Expires' }, { key: 'status', label: 'Status' }]}>{grants.map(g => <tr key={`${g.accountId}:${g.issuedAt}`}><td>{g.forName ?? 'Unknown person'}</td><td>{g.issuedByName ?? 'Unknown administrator'}</td><td><When ms={g.expiresAt} /></td><td><Badge>{g.status}</Badge></td></tr>)}</Table><p className="va-muted">Most recent 100 recovery grants.</p></>}</Card>
    </>}
  </div></Page>;
}
