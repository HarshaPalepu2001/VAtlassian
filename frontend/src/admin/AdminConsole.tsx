import { useCallback,useEffect,useState } from 'react';
import { view } from '@forge/bridge';
import { invoke } from '../lib/bridge';
import { Loading,Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import { assertResult,errorMessage } from '../lib/result';
import type { Result } from '../lib/result';
import type { Project } from './types';
import { parseAdminRoute } from './routes';
import type { AdminRoute } from './routes';
import AdminsPage from './pages/AdminsPage';
import RolesPage from './pages/RolesPage';
import TransitionsPage from './pages/TransitionsPage';
import FieldsPage from './pages/FieldsPage';
import LedgerPage from './pages/LedgerPage';
import RetentionPage from './pages/RetentionPage';
import CredentialsPage from './pages/CredentialsPage';
import HealthPage from './pages/HealthPage';
import ContentReviewPage from './pages/ContentReviewPage';
import SettingsPage from './pages/SettingsPage';
export default function AdminConsole({configure=false}:{configure?:boolean}){
 const [route,setRoute]=useState<AdminRoute|null>('admins');const [access,setAccess]=useState<{isAdmin:boolean;needsBootstrap:boolean}|null>(null);const [projects,setProjects]=useState<Project[]>([]);const [error,setError]=useState('');
 useEffect(()=>{if(configure)return;let active=true;let unlisten:(()=>void)|undefined;view.createHistory().then(history=>{if(!active)return;setRoute(parseAdminRoute(history.location.pathname));unlisten=history.listen(location=>{setRoute(parseAdminRoute(location.pathname));});}).catch(e=>setError(errorMessage(e)));return()=>{active=false;unlisten?.();};},[configure]);
 const check=useCallback(async()=>{setError('');try{const r=assertResult(await invoke<Result&{isAdmin:boolean;needsBootstrap:boolean}>('admin:check'));setAccess(r);if(r.isAdmin){const p=assertResult(await invoke<Result&{projects:Project[]}>('admin:listProjects'));setProjects(p.projects);}}catch(e){setError(errorMessage(e));}},[]);
 useEffect(()=>{void check();},[check]);
 if(error)return <Page title="Could not load administration"><Notice danger>{error}</Notice><button className="va-button" onClick={check}>Retry</button></Page>;
 if(!access)return <Loading label="Checking administrative access…"/>;
 if(access.needsBootstrap&&!access.isAdmin)return <AdminsPage bootstrap onBootstrap={()=>void check()}/>;
 if(!access.isAdmin)return <Page title="Administrator access required"><Notice>An existing VAtlassian administrator must grant access.</Notice></Page>;
 switch(route){case 'admins':return <AdminsPage/>;case 'roles':return <RolesPage projects={projects}/>;case 'transitions':return <TransitionsPage projects={projects}/>;case 'fields':return <FieldsPage projects={projects}/>;case 'ledger':return <LedgerPage/>;case 'retention':return <RetentionPage projects={projects}/>;case 'credentials':return <CredentialsPage/>;case 'health':return <HealthPage projects={projects}/>;case 'content-review':return <ContentReviewPage/>;case 'settings':return <SettingsPage projects={projects}/>;default:return <Page title="Page not found"><p>Choose a page in the administration menu.</p></Page>;}
}
