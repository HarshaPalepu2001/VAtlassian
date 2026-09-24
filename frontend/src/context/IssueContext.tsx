import { useEffect, useState } from 'react';
import { subscribeIssueUpdates } from '../lib/issueUpdates';
import { invoke } from '../lib/bridge';
import { Badge, Loading } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
type Glance=Result&{state?:string;version?:number;baselineVersion?:number;driftCount?:number;count?:number};
export default function IssueContext(){const [state,setState]=useState<Glance|null>(null);const [error,setError]=useState('');useEffect(()=>{
 let active=true;let sequence=0;
 const refresh=async()=>{const ticket=++sequence;try{const result=assertResult(await invoke<Glance>('panel:getGlanceState'));if(active&&ticket===sequence){setState(result);setError('');}}catch(e){if(active&&ticket===sequence)setError(errorMessage(e));}};
 void refresh();const unsubscribe=subscribeIssueUpdates(refresh);
 return()=>{active=false;++sequence;unsubscribe();};
 },[]);
 // Once a state has painted it stays: a later refresh that fails (they are all
 // background ones here) is not worth replacing the lozenge with an error.
 if(!state)return error?<Notice danger>{error}</Notice>:<Loading/>;return <div className="va-row"><Badge tone={state.state==='DRIFTED'?'warning':state.state==='BASELINED'?'success':'neutral'}>{state.state??'No baseline'}</Badge>{(state.baselineVersion??state.version)!=null&&<span>Version {state.baselineVersion??state.version}</span>}{!!(state.driftCount??state.count)&&<span>{state.driftCount??state.count} changes</span>}</div>;
}
