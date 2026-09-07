import { useEffect,useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Card,EmptyState,IssueLink,Page,Table } from '../../ui/primitives';
import { Notice,When } from '../../ui/feedback';
import { assertResult,errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
type Change={issueKey:string;issueId?:string;summary?:string;fieldName?:string;actorName?:string;changedAt?:number;driftId?:string;materiality?:string};
export default function ContentReviewPage(){const [items,setItems]=useState<Change[]>([]);const [error,setError]=useState('');const [loading,setLoading]=useState(true);
 async function load(){setLoading(true);setError('');try{const r=assertResult(await invoke<Result&{changes:Change[]}>('admin:listContentChanges'));setItems(r.changes??[]);}catch(e){setError(errorMessage(e));}finally{setLoading(false);}}
 useEffect(()=>{void load();},[]);
 return <Page eyebrow="Evidence" title="Content changes" lead="Unresolved changes to approved content. Open the work item to review the evidence and record a decision." actions={<Button isDisabled={loading} onClick={load}>Refresh</Button>}>{error&&<Notice danger>{error}</Notice>}<Card flush>{!items.length?<EmptyState title={loading?'Loading changes…':'No unresolved changes'}/>:<Table columns={[{key:'issue',label:'Work item'},{key:'field',label:'Field'},{key:'who',label:'Changed by'},{key:'when',label:'When'}]}>{items.map((c,i)=><tr key={c.driftId??`${c.issueId}:${i}`}><td><IssueLink issueKey={c.issueKey} summary={c.summary}/></td><td>{c.fieldName??'Controlled content'} {c.materiality}</td><td>{c.actorName??'Not recorded'}</td><td><When ms={c.changedAt}/></td></tr>)}</Table>}</Card></Page>;
}
