import { executeQuery, limitClause, affectedRows } from '../lib/db.js';
import { throwing, isDuplicateKey } from './store.js';

export async function getSubjectState(subjectId) {
  const rows = await throwing('SELECT * FROM va_governance_state WHERE subject_id = ?', [subjectId]);
  return rows[0] || null;
}

export async function setSubjectState(subjectId, product, contentType, state) {
  const existing = await throwing('SELECT subject_id FROM va_governance_state WHERE subject_id = ?', [subjectId]);
  if (existing.length === 0) {
    try {
      await throwing(
        'INSERT INTO va_governance_state (subject_id, state) VALUES (?, ?)',
        [subjectId, state]
      );
      await throwing(
        'INSERT INTO va_governed_subject (subject_id, product, content_type) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE product = VALUES(product)',
        [subjectId, product, contentType]
      );
      return;
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
    }
  }
  await throwing(
    'UPDATE va_governance_state SET state = ? WHERE subject_id = ?',
    [state, subjectId]
  );
}

export async function getWorkingCopy(canonicalId) {
  const rows = await throwing('SELECT * FROM va_governance_operation WHERE subject_id = ? AND operation_id LIKE ?', [canonicalId, '%_wc']);
  return rows[0] || null;
}

export async function setWorkingCopy(copyId, canonicalId, createdAt) {
  await throwing(
    'INSERT INTO va_governance_operation (operation_id, subject_id) VALUES (?, ?)',
    [copyId, canonicalId]
  );
}

export async function deleteWorkingCopy(canonicalId) {
  await throwing('DELETE FROM va_governance_operation WHERE subject_id = ? AND operation_id LIKE ?', [canonicalId, '%_wc']);
}

export async function getDriftedSubjects() {
  const rows = await throwing('SELECT * FROM va_governance_state WHERE state IN ("DRIFTED", "WORKING_COPY")');
  return rows;
}

