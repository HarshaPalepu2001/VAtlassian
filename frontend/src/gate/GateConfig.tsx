import { useEffect,useState } from 'react';
import { workflowRules } from '@forge/jira-bridge';
import { Card,Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';

type TransitionContext = { id?: string | number; from?: { id?: string | number }; to?: { id?: string | number } } | undefined;

/**
 * Save the exact transition id in the validator configuration. Jira's
 * validator payload contains source and destination statuses but no transition
 * id. This configuration screen knows the id and saves it for later gate calls.
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
 return <Page variant="panel" title="VAtlassian validator">{error&&<Notice danger>{error}</Notice>}<Card title="Attach to every transition"><p>When attached to a transition, this validator holds baselined work items with content changed since approval. The hold lasts until the change is approved or reverted.</p><p>On transitions configured under Jira settings → Apps → VAtlassian → Controlled transitions, it also enforces the approval role, assurance level, and baseline capture set there.</p>{!readOnly&&<p>Use the workflow editor's Save or Add button to attach this validator. For a newly created transition, publish the workflow first. Then open and save the validator once to record the transition's final id.</p>}</Card></Page>;
}
