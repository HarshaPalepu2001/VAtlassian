import { useEffect,useState } from 'react';
import { workflowRules } from '@forge/jira-bridge';
import { Card,Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';
export default function GateConfig({readOnly=false}:{readOnly?:boolean}){
 const [error,setError]=useState('');useEffect(()=>{if(!readOnly)workflowRules.onConfigure(async()=>JSON.stringify({configuredIn:'admin'})).catch(()=>setError('The workflow editor could not register this configuration. Reopen the validator and retry.'));},[readOnly]);
 return <Page variant="panel" title="VAtlassian validator">{error&&<Notice danger>{error}</Notice>}<Card title="Attach to every transition"><p>On every transition it is attached to, this validator holds a baselined work item whose content has changed since approval, until that change is approved or reverted.</p><p>On transitions configured under Jira settings → Apps → VAtlassian → Controlled transitions, it also enforces the approval role, assurance level, and baseline capture set there.</p>{!readOnly&&<p>Use the workflow editor’s Save or Add button to attach this validator.</p>}</Card></Page>;
}
