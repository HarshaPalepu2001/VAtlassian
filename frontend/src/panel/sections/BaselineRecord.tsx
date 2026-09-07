import { useState } from 'react';
import { Badge, Card, Facts } from '../../ui/primitives';
import { AssuranceChip, Collapsible, MaterialityBadge, Notice, When } from '../../ui/feedback';
import type { BaselineRecordData, BaselineField } from '../types';
export default function BaselineRecord({record}:{record:BaselineRecordData|null}){
 const [open,setOpen]=useState(false);
 if(!record)return <Card title="Baseline record"><p className="va-muted">No approved baseline has been captured yet.</p></Card>;
 return <Card title="Baseline record"><div className="va-stack"><div className="va-row"><Badge tone="brand">Version {record.version}</Badge><AssuranceChip level={record.assuranceLevel}/>{record.fidelity&&<Badge tone={record.fidelity==='EXACT'?'success':'warning'}>{record.fidelity}</Badge>}</div>
  <p>Approved by {record.approvedName??'a reviewer'} · <When ms={record.approvedAt}/></p>
  <Collapsible open={open} onToggle={()=>setOpen(!open)} header={<strong>{record.fieldCount} tracked fields · view approved record</strong>}>
   <Facts items={[{label:'Captured',value:<When ms={record.capturedAt}/>},{label:'Content hash',value:<code className="va-hash">{record.contentHash??'Not recorded'}</code>}]}/>
   {record.fieldCount===0&&<Notice>This baseline contains no tracked fields.</Notice>}
   <div className="va-stack">{record.fields.map(field=><RecordField key={field.fieldId} field={field}/>)}</div>
   {record.retainedCount<record.fieldCount&&<p className="va-muted">{record.fieldCount-record.retainedCount} field values are not retained. Their digests detect changes, but the approved contents cannot be shown or restored.</p>}
  </Collapsible>
  {!!record.history?.length&&<details><summary>Version history</summary>{record.history.map(v=><p key={v.version}>Version {v.version} · {v.approvedName??'Reviewer'} · <When ms={v.approvedAt}/> · <AssuranceChip level={v.assuranceLevel}/></p>)}</details>}
 </div></Card>;
}
function RecordField({field}:{field:BaselineField}){return <details className="va-record-field"><summary><strong>{field.fieldName}</strong> <MaterialityBadge level={field.materiality}/> {!field.retained&&<Badge>Value not retained</Badge>}</summary>
 <p className="va-approved-value">{!field.retained?'Only the digest is retained.':!field.preview?'Approved value unavailable.':field.preview.empty?'Approved with no value':`${field.preview.text??''}${field.preview.truncated?'…':''}`}</p>{field.preview?.truncated&&<p className="va-muted">Preview shortened. Comparisons use the complete retained value.</p>}{field.digest&&<code className="va-hash">{field.digest}</code>}</details>;}
