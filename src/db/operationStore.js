import { executeQuery, toBinaryParam, fromBinaryColumn } from '../lib/db.js';
import { newId, throwing } from './store.js';

export async function writeOperation(operation) {
  const operationId = operation.operation_id ?? newId();
  await throwing(
    `INSERT INTO va_operation (operation_id, issue_id, type, state, actor_account_id, payload, created_at, updated_at)
     VALUES (FROM_BASE64(?), ?, ?, ?, ?, ?, ?, ?)`,
    [
      toBinaryParam(operationId), operation.issue_id, operation.type, operation.state ?? 'PENDING',
      operation.actor_account_id, operation.payload, operation.created_at, operation.updated_at
    ]
  );
  return operationId;
}

export async function getOperation(operationId) {
  const rows = await throwing(
    `SELECT TO_BASE64(operation_id) AS operation_id, issue_id, type, state, actor_account_id, payload, created_at, updated_at
     FROM va_operation WHERE operation_id = FROM_BASE64(?)`,
    [toBinaryParam(operationId)]
  );
  if (!rows || rows.length === 0) return null;
  return {
    ...rows[0],
    operation_id: fromBinaryColumn(rows[0].operation_id)
  };
}

export async function updateOperationState(operationId, state, now) {
  await executeQuery(
    `UPDATE va_operation SET state = ?, updated_at = ? WHERE operation_id = FROM_BASE64(?)`,
    [state, now, toBinaryParam(operationId)]
  );
}
