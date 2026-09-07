import { useEffect,useState } from 'react';
import { invoke } from '../lib/bridge';
import { Field, Person } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { assertResult,errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
import type { JiraUser } from './types';
export default function UserPicker({value,onChange}:{value:JiraUser|null;onChange:(v:JiraUser|null)=>void}){
 const [query,setQuery]=useState('');const [users,setUsers]=useState<JiraUser[]>([]);const [error,setError]=useState('');
 useEffect(()=>{let active=true;const timer=setTimeout(()=>{if(query.trim().length<2||value){setUsers([]);return;}invoke<Result&{users:JiraUser[]}>('admin:searchUsers',{query}).then(assertResult).then(r=>{if(active){setUsers(r.users);setError('');}}).catch(e=>{if(active)setError(errorMessage(e));});},300);return()=>{active=false;clearTimeout(timer);};},[query,value]);
 return <div className="va-typeahead">{error&&<Notice danger>{error}</Notice>}{value?<div className="va-row"><Person name={value.displayName}/><button className="va-button" onClick={()=>{onChange(null);setQuery('');}}>Change person</button></div>:<><Field label="Person"><input className="va-input" value={query} placeholder="Search by name or email" onChange={e=>setQuery(e.target.value)}/></Field>{users.map(u=><button className="va-typeahead__option" key={u.accountId} onClick={()=>{onChange(u);setUsers([]);}}><Person name={u.displayName}/></button>)}</>}</div>;
}
