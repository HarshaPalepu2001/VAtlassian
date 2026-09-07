import { useEffect, useState } from 'react';
import { invoke } from '../lib/bridge';
import Button from '@atlaskit/button';
import { Loading } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
import type { DiffField, ReportMeta, ReviewReport } from './types';
import DiffView from './DiffView';
import ReportView from './ReportView';
type ReportEnvelope=ReportMeta&{body?:ReviewReport};
export default function ReviewWorkspace({issueKey,evidenceHash}:{issueKey?:string;evidenceHash?:string}){
 const [fields,setFields]=useState<DiffField[]|null>(null);const [report,setReport]=useState<ReportEnvelope|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [focus,setFocus]=useState<string>();
 useEffect(()=>{let active=true;setFields(null);setReport(null);setError('');
  Promise.all([invoke<Result&{diff:{fields:DiffField[]}}>('drift:getDiff',{issueKey}),invoke<Result&{report:ReportEnvelope|null}>('report:get',{issueKey})]).then(([d,r])=>{assertResult(d);assertResult(r);if(active){setFields(d.diff.fields);setReport(r.report);}}).catch(e=>{if(active)setError(errorMessage(e));});return()=>{active=false;};
 },[issueKey,evidenceHash]);
 async function generate(){setBusy(true);setError('');try{const r=assertResult(await invoke<Result&{report:ReportEnvelope}>('report:generate',{issueKey}));setReport(r.report);}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
 function cite(id:string){const field=fields?.find(f=>f.driftIds?.includes(id));if(!field)return;setFocus(id);document.getElementById(`field-${field.fieldId}`)?.scrollIntoView({behavior:'smooth',block:'center'});}
 return <div className="va-stack">{error&&<Notice danger>{error}</Notice>}<div><Button isDisabled={busy||!fields} onClick={generate}>{busy?'Preparing report…':'Generate review summary'}</Button></div>
  {report&&<ReportView report={report.body} meta={report} fallback="No summary has been generated." onCite={cite}/>}
  {!fields&&!error?<Loading label="Comparing approved and current values…"/>:fields&&<DiffView fields={fields} focusDriftId={focus}/>}
 </div>;
}
