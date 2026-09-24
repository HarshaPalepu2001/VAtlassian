import { useEffect,useState } from 'react';
import { workflowRules } from '@forge/jira-bridge';
import { Card,Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';

type TransitionContext = { id?: string | number; from?: { id?: string | number }; to?: { id?: string | number } } | undefined;

/**
 * What the validator is told about the transition it is attached to.
 *
 * Jira's validator payload carries the from and to statuses but never the
 * transition id, so on its own the validator cannot tell two transitions into
 * the same status apart. This screen DOES know which transition it is on, so it
 * saves that id into the validator's configuration, and Jira hands the
 * configuration back to the validator on every call.
 */
export function gateConfiguration(transitionContext: TransitionContext) {
  const id = transitionContext?.id;
  const toStatusId = transitionContext?.to?.id;
  return {
    configuredIn: 'admin',
    ...(id != null && String(id) !== '' ? { transitionId: String(id) } : {}),
    ...(toStatusId != null ? { toStatusId: String(toStatusId) } : {})
  };
}

export default function GateConfig({readOnly=false,transitionContext}:{readOnly?:boolean;transitionContext?:TransitionContext}){
 const [error,setError]=useState('');
 useEffect(()=>{if(!readOnly)workflowRules.onConfigure(async()=>JSON.stringify(gateConfiguration(transitionContext))).catch(()=>setError('The workflow editor could not register this configuration. Reopen the validator and retry.'));},[readOnly,transitionContext]);
 return <Page variant="panel" title="VAtlassian validator">{error&&<Notice danger>{error}</Notice>}<Card title="Attach to every transition"><p>On every transition it is attached to, this validator holds a baselined work item whose content has changed since approval, until that change is approved or reverted.</p><p>On transitions configured under Jira settings → Apps → VAtlassian → Controlled transitions, it also enforces the approval role, assurance level, and baseline capture set there.</p>{!readOnly&&<p>Use the workflow editor’s Save or Add button to attach this validator. If you add it to a transition you have just created, publish the workflow first and then open and save the validator once, so it records the transition’s final id.</p>}</Card></Page>;
}
