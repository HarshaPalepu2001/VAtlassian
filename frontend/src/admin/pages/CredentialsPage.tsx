import { useCallback,useEffect,useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Badge,Card,Page,Table } from '../../ui/primitives';
import { Notice,When } from '../../ui/feedback';
import { assertResult,errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { JiraUser } from '../types';
import UserPicker from '../UserPicker';
type Grant={accountId:string;forName?:string;issuedByName?:string;issuedAt:number;expiresAt:number;status:string};
export default function CredentialsPage(){const [grants,setGrants]=useState<Grant[]>([]);const [person,setPerson]=useState<JiraUser|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [message,setMessage]=useState('');
 const load=useCallback(async()=>{try{const r=assertResult(await invoke<Result&{grants:Grant[]}>('admin:listCredentialResetGrants'));setGrants(r.grants);}catch(e){setError(errorMessage(e));}},[]);useEffect(()=>{void load();},[load]);
 async function issue(){if(!person)return;setBusy(true);setError('');try{assertResult(await invoke<Result>('admin:issueCredentialResetGrant',{targetAccountId:person.accountId}));setMessage(`Reset authorized for ${person.displayName}. They can enroll a replacement authenticator in personal settings.`);setPerson(null);await load();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
 return <Page eyebrow="Operations" title="Credentials & recovery"><div className="va-stack">{error&&<Notice danger>{error}</Notice>}{message&&<Notice>{message}</Notice>}<Card title="Authorize authenticator replacement"><p>A second administrator must authorize recovery. The grant is time limited and can be used once.</p><UserPicker value={person} onChange={setPerson}/><Button appearance="primary" isDisabled={busy||!person} onClick={issue}>Issue reset grant</Button></Card><Card title="Recovery history" flush><Table columns={[{key:'person',label:'Person'},{key:'issuer',label:'Authorized by'},{key:'time',label:'Expires'},{key:'status',label:'Status'}]}>{grants.map(g=><tr key={`${g.accountId}:${g.issuedAt}`}><td>{g.forName??'Unknown person'}</td><td>{g.issuedByName??'Unknown administrator'}</td><td><When ms={g.expiresAt}/></td><td><Badge>{g.status}</Badge></td></tr>)}</Table>{!grants.length&&<p>No reset grants recorded.</p>}</Card></div></Page>;
}
