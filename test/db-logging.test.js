import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlErrorSummary, sqlStatementSummary } from '../src/lib/db.js';

test('SQL statement logging keeps operation and table but drops literals', () => {
  const summary = sqlStatementSummary("INSERT INTO va_totp_credential (account_id, ciphertext) VALUES ('actor-1', 'secret-code')");
  assert.deepEqual(summary, { operation: 'INSERT', tables: ['va_totp_credential'], placeholders: 0 });
  assert.doesNotMatch(JSON.stringify(summary), /actor-1|secret-code|ciphertext/);
});

test('SQL error logging drops response bodies, query text and quoted values', () => {
  const summary = sqlErrorSummary({
    name: 'ForgeSQLAPIError',
    message: "duplicate entry 'secret-code' for query SELECT * FROM va_baseline_value",
    code: 'ER_DUP_ENTRY',
    context: {
      responseText: 'full private body',
      debug: { code: 'ER_DUP_ENTRY', sql: "SELECT 'private value'" }
    }
  });
  assert.equal(summary.name, 'ForgeSQLAPIError');
  assert.equal(summary.code, 'ER_DUP_ENTRY');
  assert.doesNotMatch(JSON.stringify(summary), /secret-code|private value|full private body|SELECT \*/);
});
