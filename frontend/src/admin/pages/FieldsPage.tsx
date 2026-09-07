import { useCallback,useEffect,useState } from 'react';
import { invoke } from '../../lib/bridge';
import Button from '@atlaskit/button';
import { Badge,Card,Field,Loading,Page,Select } from '../../ui/primitives';
import { Notice } from '../../ui/feedback';
import { assertResult,errorMessage } from '../../lib/result';
import type { Result } from '../../lib/result';
import type { AvailableField,ControlledField,Project } from '../types';
import FieldClassification from './FieldClassification';
type Setup=Result&{controlled:ControlledField[];excluded:AvailableField[];available:AvailableField[];coverage?:{tracked:number;excluded:number;unadopted:number};storage?:{storedBytes:number;items:number};config?:{aiEnabled?:boolean}};
export default function FieldsPage({projects}:{projects:Project[]}){
 const [projectId,setProject]=useState('');const [data,setData]=useState<Setup|null>(null);const [error,setError]=useState('');const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);const [ai,setAi]=useState(false);
 const load=useCallback(async()=>{if(!projectId)return;try{const r=assertResult(await invoke<Setup>('admin:fieldSetup',{projectId,issueTypeId:'*'}));setData(r);}catch(e){setError(errorMessage(e));}},[projectId]);
 useEffect(()=>{setData(null);setAi(false);setError('');void load();},[load]);
 async function mutate(action:()=>Promise<Result>){setBusy(true);setError('');try{const r=assertResult(await action());setMessage(r.note??'Saved.');await load();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
 return <Page eyebrow="Setup" title="Controlled fields"><div className="va-stack"><Field label="Project"><Select value={projectId} onChange={setProject} placeholder="Choose a project" options={projects.map(p=>({value:p.id,label:p.name}))}/></Field>{error&&<Notice danger>{error}</Notice>}{message&&<Notice>{message}</Notice>}
 {projectId&&<div className="va-row"><Button isDisabled={busy} onClick={()=>setAi(true)}>Classify fields with AI</Button><Button isDisabled={busy} onClick={()=>mutate(()=>invoke<Result>('admin:syncFields',{projectId,issueTypeId:'*'}))}>Sync fields</Button></div>}
 {ai?<FieldClassification key={projectId} projectId={projectId} onClose={()=>setAi(false)} onSaved={note=>{setMessage(note);setAi(false);void load();}}/>:data?<>
  <Card><div className="va-row"><Badge tone="brand">{data.coverage?.tracked??data.controlled.length} tracked</Badge><Badge>{data.coverage?.excluded??data.excluded.length} excluded</Badge><Badge tone="warning">{data.coverage?.unadopted??data.available.length} unreviewed</Badge></div>{!data.controlled.length&&<Notice>No fields are tracked. A baseline would capture an empty set.</Notice>}{data.storage&&<p>{(data.storage.storedBytes/1048576).toFixed(2)} MiB retained across {data.storage.items} work items</p>}</Card>
  <Card title="Tracked fields">{data.controlled.map(f=><div className="va-record-field" key={f.field_id}><div className="va-row"><strong>{f.field_name}</strong><Badge>{f.field_kind}</Badge><span className="va-spacer"/><label><input type="checkbox" checked={!!f.store_values} disabled={busy} onChange={e=>{const storeValues=e.target.checked;void mutate(()=>invoke<Result>('admin:setRetention',{projectId,issueTypeId:'*',fieldId:f.field_id,storeValues}));}}/> Retain contents</label><Button isDisabled={busy} onClick={()=>mutate(()=>invoke<Result>('admin:saveField',{projectId,issueTypeId:'*',fieldId:f.field_id,fieldName:f.field_name,fieldKind:f.field_kind,schemaType:f.schema_type,state:'EXCLUDED'}))}>Exclude</Button></div></div>)}</Card>
  {[{title:'Deliberately excluded',fields:data.excluded},{title:'Not yet reviewed',fields:data.available}].map(group=><Card key={group.title} title={group.title}>{!group.fields.length?<p className="va-muted">No fields in this group.</p>:group.fields.map(f=><div className="va-record-field va-row" key={f.fieldId}><strong>{f.fieldName}</strong><span className="va-spacer"/><Button isDisabled={busy} onClick={()=>mutate(()=>invoke<Result>('admin:trackField',{projectId,issueTypeId:'*',fieldId:f.fieldId,fieldName:f.fieldName,fieldKind:f.suggestedKind,schemaType:f.schemaType}))}>Track</Button></div>)}</Card>)}
 </>:projectId&&!error?<Loading/>:null}
 </div></Page>;
}
