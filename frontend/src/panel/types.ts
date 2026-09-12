import type { AssuranceLevel } from '../lib/assurance';
import type { DiffField } from '../review/types';
export type Transition = { transitionId: string; toStatusId: string; name: string; toStatusName?: string; label?: string; requiredAssurance: AssuranceLevel; meaning: string; eligible: boolean; capturesBaseline?: boolean; blocksOnDrift?: boolean; requiredRole?: string };
export type PendingApproval = { approvalId: string; transitionId?: string; state: string; expiresAt?: number };
export type BaselineField = {fieldId:string;fieldName:string;materiality?:string;retained:boolean;digest?:string;preview?:{text?:string;empty?:boolean;truncated?:boolean;more?:number}|null};
export type BaselineRecordData = {version:number;approvedName?:string;approvedAt?:number;capturedAt?:number;assuranceLevel?:AssuranceLevel;fidelity?:string;contentHash?:string;fieldCount:number;retainedCount:number;fields:BaselineField[];history?:{version:number;approvedName?:string;approvedAt?:number;assuranceLevel?:AssuranceLevel}[]};
export type PanelState = {
 error?:string;reason?:string; issue?:{id?:string;key?:string;summary?:string;statusName?:string};
 tier?: 'actor' | 'observer'; state?: string;
 eligibility:{eligible:boolean;reason?:string}; approval:{requiredAssurance:AssuranceLevel;meaning?:string;pending?:PendingApproval|null};
 record:BaselineRecordData|null; 
 baseline?:{nodeCount:number;edgeCount:number;totalFieldCount:number;treeHash:string|null};
 drift:{
   count:number;materialCount:number;evidenceHash?:string;
   fields?:DiffField[];
   addedNodes?:any[]; removedNodes?:any[]; movedNodes?:any[]; changedFields?:any[];
 };
 rejection?: { deleteIssueKeys: string[]; recreateCount: number };
 transitions?:Transition[];credentialEnrolled?:boolean;
 controls?:{unavailable?:boolean;incidents:{event_type:string;occurred_at:number}[];gateFindings:{finding_type:string;detail:string;last_seen_at:number}[]};
};
