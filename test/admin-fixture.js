import { randomBytes } from 'node:crypto';
import { EVENT } from '../src/lib/ledger.js';
import { describeScope } from '../src/lib/eligibility.js';
import { grantExpiry } from '../src/lib/credentialRecovery.js';
import * as retention from '../src/lib/retention.js';
import * as content from '../src/lib/content.js';
import * as classification from '../src/lib/aiClassification.js';
import * as materiality from '../src/lib/materiality.js';
import * as exportRecord from '../src/lib/exportRecord.js';

export const request = (payload = {}, accountId = 'admin') => ({ context: { accountId }, payload });
export function fixture(options = {}) {
  const calls = [], events = [], writes = [];
  const deps = {
    ...retention, ...content, ...classification, ...materiality, ...exportRecord,
    EVENT, calls, events, writes, auditStore: {}, newId: () => randomBytes(16),
    describeScope, grantExpiry, toBinaryParam: b => b.toString('base64'),
    fromBinaryColumn: b => b == null ? null : Buffer.from(b, 'base64'),
    limitClause: n => { if (!Number.isSafeInteger(n)) throw Error('Invalid limit'); return String(n); },
    executeQuery: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT account_id FROM va_admin WHERE account_id =')) {
        if (options.authError) return { result: false };
        return { result: true, data: options.unauthorized ? [] : [{ account_id: params[0] }] };
      }
      return options.query ? options.query(sql, params) : { result: true, data: [] };
    },
    append: async (_, event) => { if (options.auditError) throw Error('Audit unavailable'); events.push(event); },
    lookupUsers: async ids => new Map(ids.map(id => [id, { displayName: `User ${id}`, active: true }])),
    lookupProjects: async () => new Map([['1', { key: 'ONE', name: 'Project one' }]]),
    lookupIssueTypes: async () => new Map(), lookupStatuses: async () => new Map(),
    isJiraAdmin: async () => true,
    declaredFieldRows: async () => options.rows ?? [],
    readScopeFields: async () => [{ id: 'summary', name: 'Summary', schema: { type: 'string', system: 'summary' } },
      { id: 'customfield_1', name: 'Requirement', schema: { type: 'string', custom: 'text' } }],
    projectConfig: async () => ({ ai: { enabled: false } }),
    storageReport: async () => ({ usedBytes: 0 }),
    upsertControlledField: async row => { writes.push(row); return Buffer.alloc(16, 1); },
    setFieldRetention: async row => { writes.push(row); return true; },
    setConfig: async (...args) => { writes.push(args); },
    verifyChain: async () => ({ ok: true, checked: 1 }),
    listGatedTransitions: async () => [],
  };
  deps.tryAppend = event => deps.append(deps.auditStore, event);
  return deps;
}
