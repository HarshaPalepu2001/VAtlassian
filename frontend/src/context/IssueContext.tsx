import { useEffect, useState } from 'react';
import { view } from '@forge/bridge';
import { subscribeIssueUpdates } from '../lib/issueUpdates';
import { invoke } from '../lib/bridge';
import { Badge, Loading } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { plural } from '../ui/format';
import { openReview } from '../review/openReview';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
type Glance=Result&{state?:string;version?:number;baselineVersion?:number;driftCount?:number;count?:number};

/**
 * Show the work item's state in the sidebar and link to review when it has
 * drifted.
 */
export default function IssueContext(){const [state,setState]=useState<Glance|null>(null);const [error,setError]=useState('');const [issueKey,setIssueKey]=useState<string>();
 useEffect(()=>{
 let active=true;let sequence=0;
 view.getContext().then(ctx=>{if(active)setIssueKey((ctx?.extension as {issue?:{key?:string}})?.issue?.key);}).catch(()=>{});
 const refresh=async()=>{const ticket=++sequence;try{const result=assertResult(await invoke<Glance>('panel:getGlanceState'));if(active&&ticket===sequence){setState(result);setError('');}}catch(e){if(active&&ticket===sequence)setError(errorMessage(e));}};
 void refresh();const unsubscribe=subscribeIssueUpdates(refresh);
 return()=>{active=false;++sequence;unsubscribe();};
 },[]);
 // Keep the displayed state if a background refresh fails.
 if(!state)return error?<Notice danger>{error}</Notice>:<Loading/>;
 const version=state.baselineVersion??state.version;const changes=state.driftCount??state.count??0;
 return <div className="va-glance">
  <div className="va-row">
   <Badge tone={state.state==='DRIFTED'?'warning':state.state==='BASELINED'?'success':'neutral'}>{state.state==='DRIFTED'?'Drifted':state.state==='BASELINED'?'Signed':(state.state??'No baseline')}</Badge>
   {version!=null&&<span className="va-secondary">Baseline version {version}</span>}
  </div>
  {!!changes&&<>
   <span>{plural(changes,'change')} since approval</span>
   <div className="va-row">
    <button type="button" className="va-btn" onClick={()=>void openReview({issueKey,tab:'changes'}).catch(()=>{})}>See changes</button>
    <button type="button" className="va-btn va-btn--discovery" onClick={()=>void openReview({issueKey,tab:'summary'}).catch(()=>{})}>AI summary</button>
   </div>
  </>}
 </div>;
}
