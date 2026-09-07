import { useEffect, useState } from 'react';
import { invoke } from '../lib/bridge';
import { Badge, Loading } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { assertResult, errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
type Glance=Result&{state?:string;version?:number;baselineVersion?:number;driftCount?:number;count?:number};
export default function IssueContext(){const [state,setState]=useState<Glance|null>(null);const [error,setError]=useState('');useEffect(()=>{invoke<Glance>('panel:getGlanceState').then(assertResult).then(setState).catch(e=>setError(errorMessage(e)));},[]);
 if(error)return <Notice danger>{error}</Notice>;if(!state)return <Loading/>;return <div className="va-row"><Badge tone={state.state==='DRIFTED'?'warning':state.state==='BASELINED'?'success':'neutral'}>{state.state??'No baseline'}</Badge>{(state.baselineVersion??state.version)!=null&&<span>Version {state.baselineVersion??state.version}</span>}{!!(state.driftCount??state.count)&&<span>{state.driftCount??state.count} changes</span>}</div>;
}
