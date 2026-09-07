import { useCallback,useEffect,useState } from 'react';
import { invoke } from '../lib/bridge';
import Button from '@atlaskit/button';
import { Badge,Card,EmptyState,IssueLink,Loading,Page,Table } from '../ui/primitives';
import { Notice,When } from '../ui/feedback';
import { assertResult,errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
import IssuePanel from '../panel/IssuePanel';
type Item={issueId:string;issueKey:string;summary:string;status:string;state:string;baselineVersion:number;driftCount:number;materialCount:number;lastDriftAt?:number};
export default function QueueList(){
 const [items,setItems]=useState<Item[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [expanded,setExpanded]=useState('');const [next,setNext]=useState<string|null>(null);
 const load=useCallback(async(token?:string)=>{setLoading(true);setError('');try{const r=assertResult(await invoke<Result&{items:Item[];nextPageToken?:string|null}>('queue:list',token?{nextPageToken:token}:{}));setItems(prev=>token?[...prev,...r.items.filter(i=>!prev.some(p=>p.issueId===i.issueId))]:r.items);setNext(r.nextPageToken??null);}catch(e){setError(errorMessage(e));}finally{setLoading(false);}},[]);
 useEffect(()=>{void load();},[load]);
 return <Page eyebrow="Approval & baseline" title="My approvals" lead="Work items needing a decision, based on your approval roles." actions={<Button isDisabled={loading} onClick={()=>load()}>Refresh</Button>}>
 {error&&<Notice danger>{error}</Notice>}{loading&&!items.length?<Loading/>:<Card flush>{!items.length?<EmptyState title="Nothing is waiting on you">Work items requiring your approval appear here.</EmptyState>:<Table columns={[{key:'issue',label:'Work item'},{key:'status',label:'Status'},{key:'drift',label:'Changes'},{key:'when',label:'Last change'},{key:'actions',label:'Review'}]}>{items.flatMap(item=>{const rows=[<tr key={item.issueId}><td><IssueLink issueKey={item.issueKey} summary={item.summary}/></td><td><Badge>{item.status}</Badge><p className="va-muted">{item.baselineVersion?`Baseline v${item.baselineVersion}`:'No baseline'}</p></td><td><Badge tone={item.driftCount?'warning':'neutral'}>{item.driftCount?`${item.driftCount} changes · ${item.materialCount} material`:'Awaiting approval'}</Badge></td><td><When ms={item.lastDriftAt}/></td><td><Button onClick={()=>setExpanded(expanded===item.issueId?'':item.issueId)}>{expanded===item.issueId?'Close':'Review'}</Button></td></tr>];if(expanded===item.issueId)rows.push(<tr key={`${item.issueId}:review`}><td colSpan={5}><IssuePanel issueKey={item.issueKey} onDone={() => void load()} /></td></tr>);return rows;})}</Table>}</Card>}{next&&<Button isDisabled={loading} onClick={()=>load(next)}>Load more</Button>}
 </Page>;
}
