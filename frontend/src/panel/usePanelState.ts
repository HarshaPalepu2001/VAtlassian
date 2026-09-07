import { useCallback, useEffect, useRef, useState } from 'react';
import { events } from '@forge/bridge';
import { invoke } from '../lib/bridge';
import { assertResult, errorMessage } from '../lib/result';
import type { PanelState } from './types';
export default function usePanelState(issueKey?:string) {
 const [state,setState]=useState<PanelState|null>(null); const [error,setError]=useState(''); const [refreshing,setRefreshing]=useState(false);
 const sequence=useRef(0); const active=useRef(true);
 const refresh=useCallback(async()=>{
  const ticket=++sequence.current; setRefreshing(true);
  try { const result=assertResult(await invoke<PanelState>('panel:getState',issueKey?{issueKey}:{})); if(active.current&&ticket===sequence.current){setState(result);setError('');} }
  catch(e){if(active.current&&ticket===sequence.current)setError(errorMessage(e));}
  finally{if(active.current&&ticket===sequence.current)setRefreshing(false);}
 },[issueKey]);
 useEffect(()=>{active.current=true;setState(null);void refresh();
  const onFocus=()=>{if(document.visibilityState==='visible')void refresh();};
  window.addEventListener('focus',onFocus);document.addEventListener('visibilitychange',onFocus);
  const timer=window.setInterval(onFocus,30000);let unsubscribe:(()=>void)|undefined;let stopped=false;
  events.on('JIRA_ISSUE_CHANGED',()=>void refresh()).then(subscription=>{if(stopped)subscription.unsubscribe();else unsubscribe=()=>subscription.unsubscribe();}).catch(()=>{});
  return()=>{active.current=false;stopped=true;++sequence.current;clearInterval(timer);window.removeEventListener('focus',onFocus);document.removeEventListener('visibilitychange',onFocus);unsubscribe?.();};
 },[refresh]);
 return {state,error,refresh,refreshing};
}
