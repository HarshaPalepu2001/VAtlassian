import { approvalMode } from '../lib/assurance';
import type { AssuranceLevel } from '../lib/assurance';
export function approvalReady({level,confirmed,code,busy,eligible}:{level:AssuranceLevel;confirmed:boolean;code:string;busy:boolean;eligible:boolean}) {
 const mode=approvalMode(level);return eligible&&!busy&&confirmed&&mode!=='unavailable'&&(mode!=='totp'||/^\d{6}$/.test(code));
}
export function approvalPayload({issueKey,transitionId,toStatusId,decision,code,note,evidenceHash,confirmed,level}:{issueKey?:string;transitionId?:string;toStatusId?:string;decision:'APPROVE'|'REJECT';code:string;note:string;evidenceHash?:string;confirmed:boolean;level:AssuranceLevel}) {
 return {issueKey,transitionId,toStatusId,decision,confirmed,note:note.trim()||undefined,expectedEvidenceHash:evidenceHash,...(approvalMode(level)==='totp'?{code}:{})};
}
