import { contentDigest } from './content.js';
import { GOVERNANCE_KINDS, validAuditProof, governanceFail as fail } from './governance.js';

export const GOVERNANCE_MIGRATIONS = [
  {id:'tm-governance-record',sql:`CREATE TABLE IF NOT EXISTS tm_governance_record (
    record_id CHAR(32) NOT NULL, source_issue_id BIGINT NOT NULL, project_id BIGINT NOT NULL, kind VARCHAR(24) NOT NULL,
    content JSON NOT NULL, digest CHAR(64) NOT NULL, chain JSON NOT NULL, chain_digest CHAR(64) NOT NULL,
    state VARCHAR(16) NOT NULL, created_by VARCHAR(128) NOT NULL, created_at BIGINT NOT NULL,
    signed_at BIGINT NULL, activation_seq BIGINT NULL, activation_hash CHAR(64) NULL,
    PRIMARY KEY (record_id), KEY idx_tm_governance_source (source_issue_id,created_at)
  )`},
  {id:'tm-governance-head',sql:`CREATE TABLE IF NOT EXISTS tm_governance_head (
    source_issue_id BIGINT NOT NULL, kind VARCHAR(24) NOT NULL, record_id CHAR(32) NULL,
    revision BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (source_issue_id,kind)
  )`},
  {id:'tm-closure-evaluation',sql:`CREATE TABLE IF NOT EXISTS tm_closure_evaluation (
    evaluation_id CHAR(32) NOT NULL, source_issue_id BIGINT NOT NULL, project_id BIGINT NOT NULL,
    snapshot JSON NOT NULL, digest CHAR(64) NOT NULL, created_by VARCHAR(128) NOT NULL, created_at BIGINT NOT NULL,
    audit_seq BIGINT NULL, audit_hash CHAR(64) NULL,
    PRIMARY KEY (evaluation_id), KEY idx_tm_closure_source (source_issue_id,created_at)
  )`}
];
const defaultQuery = async (sql,params)=>(await import('../lib/db.js')).executeQuery(sql,params);
const id = value=>{if(!/^[a-f0-9]{32}$/.test(String(value??'')))fail('INVALID_INPUT');return String(value);};
const issue = value=>{if(!/^\d+$/.test(String(value??''))||!Number.isSafeInteger(Number(value))||Number(value)<1)fail('INVALID_INPUT');return Number(value);};
const hash = value=>{if(!/^[a-f0-9]{64}$/.test(String(value??'')))fail('INVALID_INPUT');return value;};
const kind = value=>{if(!GOVERNANCE_KINDS.includes(value))fail('INVALID_INPUT');return value;};
const parse=value=>{if(value&&typeof value==='object')return value;try{return JSON.parse(value);}catch{fail('SERVICE_UNAVAILABLE');}};
const auditFrom=(seq,value)=>seq==null&&value==null?null:{seq:Number(seq),entryHash:value};
const recordFrom=row=>({recordId:String(row.record_id),sourceIssueId:String(row.source_issue_id),projectId:String(row.project_id),kind:row.kind,
  content:parse(row.content),digest:row.digest,chain:parse(row.chain),chainDigest:row.chain_digest,state:row.state,createdBy:row.created_by,
  createdAt:Number(row.created_at),signedAt:row.signed_at==null?null:Number(row.signed_at),activationProof:auditFrom(row.activation_seq,row.activation_hash)});
const evaluationFrom=row=>({evaluationId:String(row.evaluation_id),sourceIssueId:String(row.source_issue_id),projectId:String(row.project_id),
  snapshot:parse(row.snapshot),digest:row.digest,createdBy:row.created_by,createdAt:Number(row.created_at),auditProof:auditFrom(row.audit_seq,row.audit_hash)});
const duplicate=error=>(error?.code??error?.context?.debug?.code)==='ER_DUP_ENTRY';

/** Immutable bodies, single-statement compare-and-swap publication, and bounded reads for Forge SQL. */
export function createGovernanceStore({query=defaultQuery,maxRecords=1000}={}) {
  const bound=Math.min(5000,Math.max(1,Number.isSafeInteger(maxRecords)?maxRecords:1000));
  const q=async(sql,params=[])=>{const result=await query(sql,params);if(!result?.result)fail('SERVICE_UNAVAILABLE');return result;};
  const rows=async(sql,params=[])=>{const data=(await q(sql,params)).data;if(!Array.isArray(data))fail('SERVICE_UNAVAILABLE');return data;};
  const bounded=(data,convert)=>({records:data.slice(0,bound).map(convert),complete:data.length<=bound});
  async function insertGovernanceRecord(record){
    if(contentDigest(record.content)!==record.digest)fail('CONTENT_CHANGED');
    if(record.kind!=='EXCEPTION')await q(`INSERT INTO tm_governance_head (source_issue_id,kind,record_id,revision) VALUES (?,?,NULL,0)
      ON DUPLICATE KEY UPDATE source_issue_id = source_issue_id`,[issue(record.sourceIssueId),kind(record.kind)]);
    const params=[id(record.recordId),issue(record.sourceIssueId),issue(record.projectId),kind(record.kind),JSON.stringify(record.content),hash(record.digest),JSON.stringify(record.chain),hash(record.chainDigest),record.createdBy,record.createdAt];
    try{
      const result=await query(`INSERT INTO tm_governance_record (record_id,source_issue_id,project_id,kind,content,digest,chain,chain_digest,state,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,'SIGNING',?,?)`,params);
      if(!result?.result){if(duplicate(result?.error))return false;fail('SERVICE_UNAVAILABLE');}return true;
    }catch(error){if(duplicate(error))return false;throw error;}
  }
  async function readGovernanceRecord(recordId){const row=(await rows('SELECT * FROM tm_governance_record WHERE record_id = ?',[id(recordId)]))[0];return row?recordFrom(row):null;}
  async function readGovernanceHead({sourceIssueId,kind:recordKind}){
    const data=await rows(`SELECT h.record_id AS head_record_id, r.* FROM tm_governance_head h
      LEFT JOIN tm_governance_record r ON r.record_id = h.record_id WHERE h.source_issue_id = ? AND h.kind = ?`,[issue(sourceIssueId),kind(recordKind)]);
    const row=data[0];if(!row?.head_record_id)return null;
    if(!row.record_id||row.state!=='SIGNED'||!validAuditProof(auditFrom(row.activation_seq,row.activation_hash)))fail('ACTIVATION_NOT_CONFIRMED');
    const record=recordFrom(row);if(record.sourceIssueId!==String(sourceIssueId)||record.kind!==recordKind||contentDigest(record.content)!==record.digest)fail('CONTENT_CHANGED');return record;
  }
  async function activateGovernanceRecord({recordId,expectedPreviousId,proof,now}){
    if(!validAuditProof(proof))fail('INVALID_INPUT');const record=await readGovernanceRecord(recordId);
    if(!record||record.content.previousId!==expectedPreviousId||contentDigest(record.content)!==record.digest)fail('CONTENT_CHANGED');
    if(!['SIGNING','SIGNED'].includes(record.state))return false;
    // Final signature + durable activation audit exist first. A crash here leaves an unpublished record that is safe to retry.
    await q(`UPDATE tm_governance_record SET state = 'SIGNED', signed_at = COALESCE(signed_at,?), activation_seq = COALESCE(activation_seq,?), activation_hash = COALESCE(activation_hash,?)
      WHERE record_id = ? AND digest = ? AND state IN ('SIGNING','SIGNED')`,[now,proof.seq,proof.entryHash,id(recordId),hash(record.digest)]);
    const confirmed=await readGovernanceRecord(recordId);if(!confirmed||!validAuditProof(confirmed.activationProof)||confirmed.state!=='SIGNED')return false;
    if(record.kind==='EXCEPTION')return true;
    const where=expectedPreviousId==null?'record_id IS NULL':'record_id = ?';
    const params=[id(recordId),issue(record.sourceIssueId),kind(record.kind),...(expectedPreviousId==null?[]:[id(expectedPreviousId)])];
    const out=await q(`UPDATE tm_governance_head SET record_id = ?, revision = revision + 1 WHERE source_issue_id = ? AND kind = ? AND ${where}`,params);
    if(Number(out.data?.affectedRows)===1)return true;
    const active=await readGovernanceHead({sourceIssueId:record.sourceIssueId,kind:record.kind});return active?.recordId===recordId;
  }
  async function readGovernanceRecordsComplete(sourceIssueId){return bounded(await rows(`SELECT * FROM tm_governance_record WHERE source_issue_id = ? ORDER BY created_at DESC,record_id DESC LIMIT ${bound+1}`,[issue(sourceIssueId)]),recordFrom);}
  async function insertClosureEvaluation(record){
    if(contentDigest(record.snapshot)!==record.digest)fail('CONTENT_CHANGED');
    const params=[id(record.evaluationId),issue(record.sourceIssueId),issue(record.projectId),JSON.stringify(record.snapshot),hash(record.digest),record.createdBy,record.createdAt];
    try{const result=await query(`INSERT INTO tm_closure_evaluation (evaluation_id,source_issue_id,project_id,snapshot,digest,created_by,created_at) VALUES (?,?,?,?,?,?,?)`,params);
      if(!result?.result){if(duplicate(result?.error))return false;fail('SERVICE_UNAVAILABLE');}return true;}catch(error){if(duplicate(error))return false;throw error;}
  }
  async function readClosureEvaluation(evaluationId){const row=(await rows('SELECT * FROM tm_closure_evaluation WHERE evaluation_id = ?',[id(evaluationId)]))[0];return row?evaluationFrom(row):null;}
  async function confirmClosureEvaluation({evaluationId,digest,proof}){
    if(!validAuditProof(proof))fail('INVALID_INPUT');
    const out=await q(`UPDATE tm_closure_evaluation SET audit_seq = ?,audit_hash = ? WHERE evaluation_id = ? AND digest = ? AND audit_seq IS NULL AND audit_hash IS NULL`,[proof.seq,proof.entryHash,id(evaluationId),hash(digest)]);
    if(Number(out.data?.affectedRows)===1)return true;
    const stored=await readClosureEvaluation(evaluationId);return !!stored&&stored.digest===digest&&validAuditProof(stored.auditProof)&&stored.auditProof.seq===proof.seq&&stored.auditProof.entryHash===proof.entryHash;
  }
  async function readClosureEvaluationsComplete(sourceIssueId){return bounded(await rows(`SELECT * FROM tm_closure_evaluation WHERE source_issue_id = ? ORDER BY created_at DESC,evaluation_id DESC LIMIT ${bound+1}`,[issue(sourceIssueId)]),evaluationFrom);}
  return {insertGovernanceRecord,readGovernanceRecord,readGovernanceHead,activateGovernanceRecord,readGovernanceRecordsComplete,
    insertClosureEvaluation,readClosureEvaluation,confirmClosureEvaluation,readClosureEvaluationsComplete};
}
