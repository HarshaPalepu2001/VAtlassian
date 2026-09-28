import React,{lazy,Suspense,useEffect,useState} from 'react';
import ReactDOM from 'react-dom/client';
import { view } from '@forge/bridge';
import '@atlaskit/css-reset';
import './ui/tokens.css';
import './ui/product.css';
import './ui/surfaces.css';
import { Loading,Page } from './ui/primitives';
import { Notice } from './ui/feedback';
import IssueContext from './context/IssueContext';
import { isReviewContext } from './review/openReview';
const AdminConsole=lazy(()=>import('./admin/AdminConsole'));
const IssuePanel=lazy(()=>import('./panel/IssuePanel'));
const QueueList=lazy(()=>import('./queue/QueueList'));
const TotpEnrollment=lazy(()=>import('./totp/TotpEnrollment'));
const GateConfig=lazy(()=>import('./gate/GateConfig'));
const ReviewWindow=lazy(()=>import('./review/ReviewWindow'));
const WebAuthnPopup=lazy(()=>import('./panel/WebAuthnPopup'));
const ApprovalField=lazy(()=>import('./field/ApprovalField'));
const ConfluenceSpaceSetup = lazy(() => import('./confluence/ConfluenceSpaceSetup'));
const ConfluencePageStatus = lazy(() => import('./confluence/ConfluencePageStatus'));
const ConfluenceProtectAction = lazy(() => import('./confluence/ConfluenceProtectAction'));

type Context = Awaited<ReturnType<typeof view.getContext>>;
function isWebAuthnPopup() {
  try { return new URL(window.location.href).searchParams.get('mode') === 'webauthn-popup'; }
  catch { return false; }
}
function App() {
  const [context, setContext] = useState<Context | null>(null); const [error, setError] = useState(false);
  useEffect(() => { view.getContext().then(setContext).catch(() => setError(true)); }, []);
  useEffect(() => { let active = true; let cleanup: (() => void) | undefined; view.theme.enable().catch(() => { if (!active) return; const media = window.matchMedia('(prefers-color-scheme: dark)'); const apply = () => document.documentElement.setAttribute('data-color-mode', media.matches ? 'dark' : 'light'); apply(); media.addEventListener('change', apply); cleanup = () => media.removeEventListener('change', apply); }); return () => { active = false; cleanup?.(); }; }, []);
  if (error) return <Page title="Could not start"><Notice danger>Context could not be read. Reload this page.</Notice></Page>;
  if (!context) return <Loading />;
  let screen: React.ReactNode;
  if (isReviewContext(context.extension.modal)) screen = <ReviewWindow issueKey={context.extension.modal.issueKey} tab={context.extension.modal.tab} />;
  else switch (context.moduleKey) {
    case 'va-device-approval-field': screen = <ApprovalField context={context as any} />; break;
    case 'va-panel': screen = <IssuePanel />; break;
    case 'va-context': screen = <IssueContext />; break;
    case 'va-worklist': screen = <QueueList />; break;
    case 'va-admin': screen = <AdminConsole />; break;
    case 'va-admin-configure': screen = <AdminConsole configure />; break;
    case 'va-authenticator': screen = <TotpEnrollment />; break;
    case 'va-gate': screen = <GateConfig readOnly={context.extension.entryPoint === 'view'} transitionContext={context.extension.transitionContext} />; break;
    case 'confluence-byline':
    case 'confluence-banner': screen = <ConfluencePageStatus view={context.moduleKey} />; break;
    case 'confluence-action': screen = <ConfluenceProtectAction />; break;
    case 'confluence-global': screen = <QueueList />; break;
    case 'confluence-space': screen = <ConfluenceSpaceSetup />; break;
    default: screen = <Page title="Screen unavailable"><Notice>This module is not configured. Contact your administrator.</Notice></Page>;
  }
 return <Suspense fallback={<Loading/>}>{screen}</Suspense>;
}
class ErrorBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return {failed:true};}render(){return this.state.failed?<Page title="This screen could not be displayed"><Notice danger>Reload the page. If this persists, contact your administrator.</Notice></Page>:this.props.children;}}
ReactDOM.createRoot(document.getElementById('root')!).render(
 <React.StrictMode>
  <ErrorBoundary>
   <Suspense fallback={<Loading/>}>{isWebAuthnPopup()?<WebAuthnPopup/>:<App/>}</Suspense>
  </ErrorBoundary>
 </React.StrictMode>
);
