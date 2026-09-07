import Button from '@atlaskit/button';
import { Loading, Page } from '../ui/primitives';
import { Notice } from '../ui/feedback';
import usePanelState from './usePanelState';
import DriftSection from './sections/DriftSection';
import ApprovalControls from './sections/ApprovalControls';
import BaselineRecord from './sections/BaselineRecord';
import RestoreStatus from './sections/RestoreStatus';
export default function IssuePanel({issueKey, onDone}:{issueKey?:string, onDone?:()=>void}){
 const {state,error,refresh,refreshing}=usePanelState(issueKey);
 if(!state&&!error)return <Loading label="Loading approval and baseline…"/>;
 return <Page variant="panel" title="Approval & baseline" actions={<Button isDisabled={refreshing} onClick={refresh}>Refresh</Button>}><div className="va-stack">
  {error&&<Notice danger>{error} Refresh before making an approval decision.</Notice>}
  {state&&<><DriftSection drift={state.drift} issueKey={issueKey??state.issue?.key}/><ApprovalControls state={state} issueKey={issueKey} onDone={async () => { await refresh(); onDone?.(); }} disabled={!!error||refreshing}/><BaselineRecord record={state.record}/><RestoreStatus issueKey={issueKey??state.issue?.key} revision={`${state.record?.version}:${state.drift.evidenceHash??''}`}/></>}
 </div></Page>;
}
