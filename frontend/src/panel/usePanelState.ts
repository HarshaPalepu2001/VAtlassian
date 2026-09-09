import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeIssueUpdates } from '../lib/issueUpdates';
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
  const unsubscribe = subscribeIssueUpdates(refresh);
  return()=>{active.current=false;++sequence.current;unsubscribe();};
 },[refresh]);
 return {state,error,refresh,refreshing};
}
