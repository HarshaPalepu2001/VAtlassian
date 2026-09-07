import { executeQuery, toBinaryParam, fromBinaryColumn } from '../lib/db.js';
import { newId, throwing } from './store.js';

export async function writeProposal(proposal, values) {
  const proposalId = proposal.proposal_id ?? newId();
  
  await throwing(
    `INSERT INTO va_proposal (proposal_id, issue_id, baseline_id, baseline_version, baseline_hash, field_config_version, content_hash, field_digests, proposer_account_id, state, captured_at, expires_at, operation_plan_hash)
     VALUES (FROM_BASE64(?), ?, FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      toBinaryParam(proposalId), proposal.issue_id, toBinaryParam(proposal.baseline_id),
      proposal.baseline_version, proposal.baseline_hash, proposal.field_config_version ?? null,
      proposal.content_hash, proposal.field_digests, proposal.proposer_account_id,
      proposal.state ?? 'PENDING', proposal.captured_at, proposal.expires_at,
      proposal.operation_plan_hash ?? null
    ]
  );
  
  if (values && values.length > 0) {
    // Write values in chunks to va_proposal_value if needed
    // (Similar to baseline_value)
    for (const v of values) {
      await throwing(
        `INSERT INTO va_proposal_value (proposal_id, field_id, seq, encoding, raw_bytes, data)
         VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?)`,
        [toBinaryParam(proposalId), v.field_id, v.seq, v.encoding, v.raw_bytes, v.data]
      );
    }
  }

  return proposalId;
}

export async function getProposal(proposalId) {
  const rows = await throwing(
    `SELECT TO_BASE64(proposal_id) AS proposal_id, issue_id, TO_BASE64(baseline_id) AS baseline_id,
            baseline_version, baseline_hash, field_config_version, content_hash, field_digests,
            proposer_account_id, state, captured_at, expires_at, operation_plan_hash
     FROM va_proposal WHERE proposal_id = FROM_BASE64(?)`,
    [toBinaryParam(proposalId)]
  );
  if (!rows || rows.length === 0) return null;
  return {
    ...rows[0],
    proposal_id: fromBinaryColumn(rows[0].proposal_id),
    baseline_id: fromBinaryColumn(rows[0].baseline_id)
  };
}

export async function getProposalValues(proposalId) {
  const rows = await throwing(
    `SELECT field_id, seq, encoding, raw_bytes, data
     FROM va_proposal_value WHERE proposal_id = FROM_BASE64(?) ORDER BY field_id, seq`,
    [toBinaryParam(proposalId)]
  );
  return rows;
}
