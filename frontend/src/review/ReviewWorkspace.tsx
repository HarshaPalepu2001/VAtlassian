import { useEffect, useState } from 'react';
import { invoke } from '../lib/bridge';
import Button from '@atlaskit/button';
import { Loading } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
import type { DiffField, ReportMeta, ReviewReport } from './types';
import type { PanelEvidence } from '../panel/types';
import DiffView from './DiffView';
import ReportView from './ReportView';
type ReportEnvelope=ReportMeta&{body?:ReviewReport};
export default function ReviewWorkspace({issueKey,evidenceHash,evidence}:{issueKey?:string;evidenceHash?:string;evidence?:PanelEvidence|null}){
 const [fields,setFields]=useState<DiffField[]|null>(null);const [report,setReport]=useState<ReportEnvelope|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [focus,setFocus]=useState<string>();const [historyLimited,setHistoryLimited]=useState(false);
 useEffect(()=>{let active=true;setFields(evidence?.drift?.fields ?? null);setReport(null);setError('');setHistoryLimited(false);
  const diffRead: Promise<Result&{diff:{fields:DiffField[];historyTruncated?:boolean;historyUnavailable?:boolean}}> = evidence
   ? Promise.resolve({ diff: evidence.drift } as Result&{diff:{fields:DiffField[];historyTruncated?:boolean;historyUnavailable?:boolean}})
   : invoke<Result&{diff:{fields:DiffField[];historyTruncated?:boolean;historyUnavailable?:boolean}}>('drift:getDiff',{issueKey});
  diffRead
   .then(d=>{assertResult(d);const diff=d?.diff;if(!diff||!Array.isArray(diff.fields))throw new Error('The change comparison is unavailable. Reload the review.');if(active){setFields(diff.fields);setHistoryLimited(!!(diff.historyTruncated||diff.historyUnavailable));}})
   .catch(e=>{if(active)setError(errorMessage(e));});
  invoke<Result&{report:ReportEnvelope|null}>('report:get',{issueKey})
   .then(r=>{assertResult(r);if(active)setReport(r.report);})
   .catch(()=>{ /* The deterministic diff remains available without AI or its cache. */ });
  return()=>{active=false;};
 },[issueKey,evidenceHash,evidence]);
 async function generate(){setBusy(true);setError('');try{const r=assertResult(await invoke<Result&{report:ReportEnvelope}>('report:generate',{issueKey}));setReport(r.report);}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
 function cite(id:string){const field=fields?.find(f=>f.driftIds?.includes(id));if(!field)return;setFocus(id);document.getElementById(`field-${field.fieldId}`)?.scrollIntoView({behavior:'smooth',block:'center'});}
 // Which fields changed, named. A reviewer opening this wants to know the shape
 // of the job before they start reading it — three fields or thirty, and which.
 const named=fields?fields.slice(0,4).map(f=>f.fieldName):[];
 const overflow=fields?fields.length-named.length:0;
 return <div className="va-stack">{error&&<Notice danger>{error}</Notice>}
  {fields&&fields.length>0&&<div className="va-row">
   <span className="va-grow">Changed: <strong>{named.join(', ')}</strong>{overflow>0&&` and ${overflow} more`}</span>
   <Button isDisabled={busy} onClick={generate}>{busy?'Preparing summary…':'Summarise with AI'}</Button>
  </div>}
  {fields&&fields.length===0&&<p className="va-muted">Current tracked values match the baseline. Any outstanding review still requires a decision.</p>}
  {historyLimited&&<Notice>Some Jira history could not be loaded. The value comparison is current; the list of who changed it and when may be incomplete.</Notice>}
  {report&&<ReportView report={report.body} meta={report} fallback="No summary has been generated." onCite={cite}/>}
  {!fields&&!error?<Loading label="Comparing approved and current values…"/>:fields&&<DiffView fields={fields} focusDriftId={focus}/>}
 </div>;
}
