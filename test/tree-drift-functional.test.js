import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { project } from '../src/lib/content.js';

/**
 * Functional coverage for the aggregate tree collector (src/lib/collect.js's
 * collectTree/affectedTreeRoots/collectAffectedTrees/
 * discoverActiveRootsByAncestor).
 *
 * diffTree()'s own drift-category logic already has dedicated unit coverage
 * in test/tree-diff.test.js. What is untested anywhere else is the GLUE this
 * task adds: reading the real (governed) tree, diffing it against the signed
 * baseline, and replacing — never appending to — the tree's drift set, with
 * no baseline meaning nothing is read or written at all.
 *
 * Every DB- and Jira-facing module collect.js imports is replaced with a thin
 * fixture, the same technique test/drift-functional.test.js and
 * test/signature-gate-drift.test.js use: real business logic (diffTree,
 * planTreeCapture, readStableTree, createTreeReader) runs unmodified; only
 * the persistence and network boundaries are swapped out.
 */
const modules = {
  'db/configStore.js': ['controlledFields', 'projectConfig', 'reviewStatusIds', 'recallTargetStatus',
    'declaredFieldRows', 'seedControlledFields', 'countControlledFields'],
  'db/baselineStore.js': ['activeBaseline', 'activeBaselines', 'readAllValues'],
  'db/driftStore.js': ['recordDrift', 'driftSummary', 'existingChangelogKeys'],
  'db/itemStateStore.js': ['getReview', 'applyObservation', 'touch', 'refreshHeader', 'dueTreeRoots', 'recoverStaleLocks', 'moveScope'],
  'db/restoreStore.js': ['suppressedFields'],
  'db/approvalStore.js': ['voidOthers', 'expireStale'],
  // Keep the recall module stubbed as a tripwire: drift detection must not
  // import or call it, and the no-status-move regressions below assert that.
  'db/store.js': ['tryAppend', 'newId', 'throwing'],
  'db/observationStore.js': ['recordObservation'],
  'db/baselineTreeStore.js': ['activeRootsForNode', 'readBaselineTree'],
  'db/treeDriftStore.js': ['replaceTreeDrift'],
  'lib/restore/recall.js': ['recallToReview', 'recordRecallFailure']
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'fixture:api', shortCircuit: true };
    const resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL).pathname : specifier;
    const key = Object.keys(modules).find(k => resolved.endsWith('/' + k));
    return key ? { url: 'fixture:' + key, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'fixture:api') {
      return {
        format: 'module', shortCircuit: true, source: `
      export const route = (s,...v) => s.reduce((a,b,i)=>a+b+(v[i]??''),'');
      export default { asUser: () => ({requestJira: (...a) => globalThis.vaFlow.request('user',...a)}),
        asApp: () => ({requestJira: (...a) => globalThis.vaFlow.request('app',...a)}) };`
      };
    }
    const names = modules[url.slice(8)];
    if (names) {
      return {
        format: 'module', shortCircuit: true,
        source: names.map(n => `export const ${n} = (...a) => globalThis.vaFlow.${n}(...a);`).join('\n')
      };
    }
    return next(url, context);
  }
});
const { collect, collectTree, collectAffectedTrees, discoverActiveRootsByAncestor } = await import('../src/lib/collect.js');
const { sweep } = await import('../src/jobs/reconcile.js');
const { planTreeCapture } = await import('../src/lib/tree/capturePlan.js');
hooks.deregister();

const FIELDS = [{ field_id: 'summary', field_name: 'summary', field_kind: 'TEXT', store_values: true, writable: true }];

/** The raw { id, fields } shape the Jira tree reader would hand back for a root plus some children. */
function rawNodes(children) {
  const structural = { project: { id: '10' }, issuetype: { id: '20' }, status: { id: '30' } };
  return [
    { id: '1', fields: { summary: 'root', parent: null, ...structural } },
    ...children.map(c => ({ id: c.id, fields: { summary: c.summary, parent: { id: '1' }, ...structural } }))
  ];
}

/**
 * A tiny governed tree: root FEAT-1 (id 1) plus whatever children are given.
 *
 * The baseline tree is built with the SAME planTreeCapture() the live read
 * path uses, over `baselineChildren` — never hand-rolled logical ids or
 * digests, which would drift out of step with the real hashing scheme
 * (sha256 of the issue id, content-hashed field digests) and produce false
 * diffs that have nothing to do with the collector under test.
 */
function baseFixture({ baselineChildren = [{ id: '2', summary: 'story' }], liveChildren = baselineChildren } = {}) {
  const replaceTreeDriftCalls = [];
  const tryAppendCalls = [];
  const recallCalls = [];
  const baselineTree = planTreeCapture({ rootIssueId: '1', nodes: rawNodes(baselineChildren), controlledFields: FIELDS });
  const f = {
    review: { baseline_id: Buffer.alloc(16, 1), baseline_version: 1, version: 1, state: 'BASELINED', last_checked_at: 0,
      project_id: 10, issue_type_id: '20' },
    baselineTree,
    replaceTreeDriftCalls,
    tryAppendCalls,
    recallCalls,
    getReview: async () => f.review,
    activeBaseline: async () => ({ baseline_id: f.review.baseline_id, version: 1,
      transition_id: '2', from_status_id: '20', to_status_id: '30', required_role: 'Reviewer',
      required_assurance: 'ESIGNATURE', controlled_fields_hash: 'a'.repeat(64) }),
    applyObservation: async ({ review, counters }) => {
      f.review = { ...f.review, ...review, drift_count: counters.driftCount,
        drifted_field_count: counters.driftedFieldCount, max_materiality: counters.maxMateriality,
        version: Number(f.review.version ?? 0) + 1 };
      return { updated: true };
    },
    voidOthers: async () => 0,
    recallToReview: async (args) => { recallCalls.push(args); return { action: 'RECALL', applied: true }; },
    controlledFields: async () => FIELDS,
    // Each child's own active baseline, by issue id (child baselines, 2026-09-24).
    childBaselines: new Map(),
    activeBaselines: async ids => new Map(ids.filter(id => f.childBaselines.has(Number(id)))
      .map(id => [Number(id), f.childBaselines.get(Number(id))])),
    activeRootsForNode: async () => [],
    readBaselineTree: async () => f.baselineTree,
    replaceTreeDrift: async (baselineId, driftRows) => { replaceTreeDriftCalls.push({ baselineId, driftRows }); },
    tryAppend: async (event) => { tryAppendCalls.push(event); },
    request: async (identity, url, options = {}) => {
      const ok = body => ({ status: 200, json: async () => body });
      if (options.method === 'POST' && String(url).includes('/search/jql')) {
        const body = JSON.parse(options.body);
        // Only the root's own children are ever asked for in this fixture —
        // a search for anyone else's children (i.e. a grandchild lookup)
        // comes back empty, keeping this a two-level tree.
        const issues = body.jql.includes('FEAT-1')
          ? liveChildren.map(c => ({ id: c.id, key: `LIVE-${c.id}`, fields: {
              summary: c.summary, parent: { id: '1' }, project: { id: '10' },
              issuetype: { id: '20' }, status: { id: '30' }
            } }))
          : [];
        return ok({ issues });
      }
      // GET root issue (called twice by readStableTree's two-read stability check).
      return ok({ id: '1', key: 'FEAT-1', fields: {
        summary: 'root', parent: null, project: { id: '10' },
        issuetype: { id: '20' }, status: { id: '30' }
      } });
    }
  };
  globalThis.vaFlow = f;
  return f;
}

function flatFixture() {
  const fields = [{ field_id: 'summary', field_name: 'summary', field_kind: 'TEXT', store_values: true, writable: true }];
  const approved = { summary: 'approved', parent: null, project: { id: '10' }, issuetype: { id: '20' }, status: { id: '30' } };
  const live = { ...approved, summary: 'edited after approval' };
  const projected = project({ summary: approved.summary }, fields);
  const recallCalls = [];
  const driftRows = [];
  const f = {
    issue: { id: '1', key: 'FEAT-1', fields: live },
    review: { baseline_id: Buffer.alloc(16, 2), baseline_version: 1, version: 1, state: 'BASELINED',
      issue_key: 'FEAT-1', summary: 'approved', reviewer_account_id: 'reviewer-1', reviewer_name: 'Reviewer' },
    baseline: { baseline_id: Buffer.alloc(16, 2), issue_id: 1, project_id: 10, issue_type_id: '20', version: 1,
      state: 'ACTIVE', content_hash: projected.contentHash, field_digests: JSON.stringify(projected.digests),
      transition_id: '2', from_status_id: '20', to_status_id: '30', required_role: 'Reviewer',
      required_assurance: 'ESIGNATURE', controlled_fields_hash: 'a'.repeat(64), transition_at: 100 },
    driftRows,
    recallCalls,
    getReview: async () => f.review,
    activeBaseline: async () => f.baseline,
    controlledFields: async () => fields,
    projectConfig: async () => ({ enabled: true }),
    reviewStatusIds: async () => ['20'],
    recordObservation: async () => {},
    readAllValues: async () => ({ summary: approved.summary }),
    existingChangelogKeys: async () => new Set(),
    suppressedFields: async () => new Set(),
    recordDrift: async row => { driftRows.push(row); return { inserted: true, driftId: `d-${driftRows.length}` }; },
    driftSummary: async () => ({ total: driftRows.length, fields: new Set(driftRows.map(row => row.field_id)).size }),
    applyObservation: async ({ review, counters }) => {
      f.review = { ...f.review, ...review, drift_count: counters.driftCount,
        drifted_field_count: counters.driftedFieldCount, version: f.review.version + 1 };
      return { updated: true };
    },
    refreshHeader: async () => {},
    voidOthers: async () => 0,
    tryAppend: async () => {},
    recallToReview: async args => { recallCalls.push(args); return { action: 'RECALL', applied: true }; },
    request: async (_identity, url) => {
      const response = body => ({ ok: true, status: 200, json: async () => structuredClone(body) });
      if (String(url).includes('/changelog')) return response({ values: [], total: 0, isLast: true });
      return response(f.issue);
    }
  };
  globalThis.vaFlow = f;
  return f;
}

test('no active baseline for the root: NO_BASELINE, nothing read or written', async () => {
  const f = baseFixture();
  f.review = null;
  const result = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', detectedVia: 'EVENT', now: 1000 });
  assert.equal(result.outcome, 'NO_BASELINE');
  assert.equal(f.replaceTreeDriftCalls.length, 0);
  assert.equal(f.tryAppendCalls.length, 0);
});

test('a review whose baseline was never captured (baseline_id null) is also NO_BASELINE', async () => {
  const f = baseFixture();
  f.review = { baseline_id: null };
  const result = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', now: 1000 });
  assert.equal(result.outcome, 'NO_BASELINE');
  assert.equal(f.replaceTreeDriftCalls.length, 0);
});

test('tree drift loads the controlled fields for the baselined project and issue type', async () => {
  const f = baseFixture();
  f.review.project_id = 10;
  f.review.issue_type_id = '20';
  let scope;
  f.controlledFields = async args => { scope = args; return FIELDS; };

  await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', now: 1000 });

  assert.deepEqual(scope, { projectId: 10, issueTypeId: '20' });
});

test('a root mid-decision or mid-restore is BUSY and is left alone', async () => {
  const f = baseFixture();
  f.review = { ...f.review, state: 'DECIDING', last_checked_at: 900 };
  const result = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', now: 1000 });
  assert.equal(result.outcome, 'BUSY');
  assert.equal(f.replaceTreeDriftCalls.length, 0);
});

test('a stale DECIDING lock does not block collection', async () => {
  const f = baseFixture();
  f.review = { ...f.review, state: 'DECIDING', last_checked_at: 0 };
  const result = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', now: 1000 * 1000 });
  assert.notEqual(result.outcome, 'BUSY');
});

test('a new descendant not in the baseline is diffed as NODE_ADDED and replaces the tree drift set', async () => {
  const f = baseFixture({ liveChildren: [{ id: '2', summary: 'story' }, { id: '3', summary: 'new' }] });
  const result = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', actorAccountId: 'acct-1', eventId: 'e1', eventAt: 5, now: 1000 });
  assert.equal(result.outcome, 'DRIFT_RECORDED');
  assert.ok(result.kinds.includes('NODE_ADDED'));
  assert.equal(f.replaceTreeDriftCalls.length, 1, 'exactly one replace call — never an append');
  assert.ok(f.replaceTreeDriftCalls[0].driftRows.some(r => r.fieldId === 'NODE_ADDED'));
  assert.equal(f.tryAppendCalls.length, 1);
  assert.equal(f.tryAppendCalls[0].actorAccountId, 'acct-1');
  assert.equal(f.tryAppendCalls[0].payload.scope, 'TREE');
});

test('tree drift detection records evidence without moving the Jira status', async () => {
  const f = baseFixture({ liveChildren: [{ id: '2', summary: 'changed story' }] });
  const result = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', now: 1000 });

  assert.equal(result.outcome, 'DRIFT_RECORDED');
  assert.equal(f.review.state, 'DRIFTED');
  assert.equal(f.recallCalls.length, 0, 'detecting drift must not perform a workflow recall');
  assert.equal(result.recall, null);
});

test('flat-field drift detection records evidence without moving the Jira status', async () => {
  const f = flatFixture();
  const result = await collect({ issueId: 1, issueKey: 'FEAT-1', now: 1000 });

  assert.equal(result.outcome, 'DRIFT_RECORDED');
  assert.equal(f.review.state, 'DRIFTED');
  assert.equal(f.driftRows.length, 1);
  assert.equal(f.recallCalls.length, 0, 'detecting drift must not perform a workflow recall');
  assert.equal(result.recall, null);
});

test('a baselined child missing from the live tree is diffed as NODE_REMOVED', async () => {
  const f = baseFixture({ liveChildren: [] });
  const result = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', now: 1000 });
  assert.equal(result.outcome, 'DRIFT_RECORDED');
  assert.deepEqual(result.kinds, ['NODE_REMOVED']);
});

test('an unchanged tree is NO_CHANGE and writes nothing', async () => {
  const f = baseFixture();
  const result = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', now: 1000 });
  assert.equal(result.outcome, 'NO_CHANGE');
  assert.equal(f.replaceTreeDriftCalls.length, 0);
});

test('repeated and out-of-order collection converges on the same one aggregate drift set', async () => {
  const f = baseFixture({ liveChildren: [{ id: '2', summary: 'story' }, { id: '3', summary: 'new' }] });
  const first = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', eventId: 'e1', now: 1000 });
  const second = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', eventId: 'e2', now: 2000 });
  assert.equal(f.replaceTreeDriftCalls.length, 2, 'each collection replaces, it does not append to the last one');
  const kindsOf = call => call.driftRows.map(r => r.fieldId).sort();
  assert.deepEqual(kindsOf(f.replaceTreeDriftCalls[0]), kindsOf(f.replaceTreeDriftCalls[1]));
  assert.deepEqual(first.kinds.sort(), second.kinds.sort());
});

test('reconcile.sweep enumerates active tree roots and runs the aggregate collector once per root', async () => {
  const dueItems = [
    { issue_id: 1, issue_key: 'FEAT-1' },
    { issue_id: 5, issue_key: 'FEAT-5' }
  ];
  const calls = [];
  const collector = async (args) => {
    calls.push(args);
    if (args.rootIssueId === 5) return { outcome: 'NO_BASELINE' };
    return { outcome: 'DRIFT_RECORDED', inserted: 2 };
  };
  const result = await sweep({ now: 42, due: async () => dueItems, collector });
  assert.deepEqual(calls.map(c => [c.rootIssueId, c.rootIssueKey]), [[1, 'FEAT-1'], [5, 'FEAT-5']]);
  assert.equal(result.examined, 2);
  assert.equal(result.withDrift, 1, 'NO_BASELINE must not be counted as drift');
  assert.equal(result.errors, 0, 'NO_BASELINE is not an error');
});

/**
 * discoverActiveRootsByAncestor() end to end — the ancestor-walk fallback for
 * a node created after its tree was baselined, so no baseline row indexes it
 * yet. Every other test in this file (and in tree-trigger-fanout.test.js and
 * baseline-trigger-retry.test.js) either mocks affectedTreeRoots() directly
 * or forces activeRootsForNode() to answer immediately, so the real walk —
 * the one piece of this task that talks to @forge/api — was never actually
 * exercised. These two tests replace globalThis.vaFlow with a minimal fixture
 * of their own: only activeRootsForNode() and the Jira parent-fetch request()
 * this function calls, nothing collectTree() needs.
 */
test('the ancestor walk climbs past an unindexed parent to find an active governed root at the grandparent', async () => {
  const activeRoot = [{ rootIssueId: 1, rootIssueKey: 'FEAT-1' }];
  const rootsByIssueId = { 2: [], 1: activeRoot };
  const parentOf = { 2: 1 }; // issue 2's native parent is issue 1
  const requests = [];
  globalThis.vaFlow = {
    activeRootsForNode: async (id) => rootsByIssueId[id] ?? [],
    request: async (identity, url) => {
      requests.push(url);
      const id = Number(String(url).match(/issue\/([^?]+)/)[1]);
      return { status: 200, json: async () => ({ fields: { parent: parentOf[id] ? { id: String(parentOf[id]) } : null } }) };
    }
  };

  const result = await discoverActiveRootsByAncestor({ issueId: '10', issueKey: 'SUB-10', parentIssueId: '2' });

  assert.deepEqual(result, activeRoot);
  assert.equal(requests.length, 1,
    'the immediate parent (2) is not indexed so its native parent is fetched once; the grandparent (1) answers from the index, so the walk stops there without a second Jira call');
});

test('an unindexed leaf with no governed ancestor at all comes back empty, not stuck forever', async () => {
  globalThis.vaFlow = {
    activeRootsForNode: async () => [],
    request: async () => ({ status: 200, json: async () => ({ fields: { parent: null } }) })
  };

  const result = await discoverActiveRootsByAncestor({ issueId: '10', issueKey: 'SUB-10', parentIssueId: '2' });
  assert.deepEqual(result, []);
});

test('a cycle in the native parent chain is detected via the visited set and the walk stops instead of looping forever', async () => {
  const requests = [];
  globalThis.vaFlow = {
    activeRootsForNode: async () => [], // nothing is ever indexed on this chain
    request: async (identity, url) => {
      requests.push(url);
      const id = Number(String(url).match(/issue\/([^?]+)/)[1]);
      const parentOf = { 2: 3, 3: 2 }; // 2 -> 3 -> 2 -> ... a real cycle
      return { status: 200, json: async () => ({ fields: { parent: parentOf[id] ? { id: String(parentOf[id]) } : null } }) };
    }
  };

  const result = await discoverActiveRootsByAncestor({ issueId: '10', issueKey: 'SUB-10', parentIssueId: '2' });

  assert.deepEqual(result, []);
  // 2 (unvisited) -> fetch -> 3 (unvisited, followed) -> fetch -> 2 (already
  // visited: the walk breaks here). Two Jira calls, not an infinite loop.
  assert.equal(requests.length, 2);
});

test('the starting node itself is protected from a one-hop cycle back to it', async () => {
  const requests = [];
  globalThis.vaFlow = {
    activeRootsForNode: async () => [],
    request: async (identity, url) => {
      requests.push(url);
      // Issue 2's own native parent is reported as issue 10 — the node that
      // is asking. visited seeds with the asking issue's own id specifically
      // to catch this.
      return { status: 200, json: async () => ({ fields: { parent: { id: '10' } } }) };
    }
  };

  const result = await discoverActiveRootsByAncestor({ issueId: '10', issueKey: 'SUB-10', parentIssueId: '2' });

  assert.deepEqual(result, []);
  assert.equal(requests.length, 1, 'the walk must not follow the chain back to the node that started it');
});

// ─── The counter is the comparison's answer, not the row count ──────────────
//
// VJIRA-17 sat at drift_count 0 with content that had plainly moved, so it
// never entered the My approvals queue (which selects on state and reads
// drift_count) and the panel showed a change nobody was allowed to decide.
//
// The cause was counting undecided va_drift ROWS. A row is skipped whenever the
// dedupe key already holds one, and no later pass can recover it — every sweep
// skips the same row and recounts the same zero.

test('a field whose drift row is deduped away is still counted as drift', async () => {
  const f = flatFixture();
  // The row already exists from an earlier pass: recordDrift reports the
  // duplicate and inserts nothing.
  f.recordDrift = async () => ({ inserted: false, duplicate: true });

  const result = await collect({ issueId: 1, issueKey: 'FEAT-1', now: 1000 });

  assert.equal(result.outcome, 'DRIFT_RECORDED');
  assert.equal(f.driftRows.length, 0, 'no new evidence row was written');
  assert.equal(result.driftCount, 1, 'but the content still differs from the signature');
  assert.equal(f.review.drift_count, 1, 'and the queue index says so');
  assert.equal(f.review.state, 'DRIFTED');
});

test('the counter does not depend on how many rows the evidence trail holds', async () => {
  // driftSummary counts rows for the whole baseline version, including ones
  // decided long ago. The counter must reflect what changed now.
  const f = flatFixture();
  f.driftSummary = async () => ({ total: 97, fields: 97 });

  const result = await collect({ issueId: 1, issueKey: 'FEAT-1', now: 1000 });

  assert.equal(result.driftCount, 1);
  assert.equal(f.review.drift_count, 1);
});

test('content that matches its baseline reports no drift, whatever rows exist', async () => {
  const f = flatFixture();
  f.issue.fields.summary = 'approved';
  f.touch = async () => {};
  f.driftSummary = async () => ({ total: 12, fields: 12 });

  const result = await collect({ issueId: 1, issueKey: 'FEAT-1', now: 1000 });

  assert.equal(result.outcome, 'NO_CHANGE');
  assert.notEqual(f.review.state, 'DRIFTED');
});

// ─── A baselined item moved to another project or issue type ────────────────
//
// Decided 2026-09-24: it follows the destination's configuration from then on,
// and the move is recorded once in the audit trail.

function movedFixture({ destinationFields = [] } = {}) {
  const f = baseFixture();
  const request = f.request;
  f.moveScopeCalls = [];
  f.moveScope = async (args) => {
    f.moveScopeCalls.push(args);
    if (Number(f.review.project_id) !== args.fromProjectId || String(f.review.issue_type_id) !== args.fromIssueTypeId) return false;
    f.review = { ...f.review, project_id: args.toProjectId, issue_type_id: args.toIssueTypeId };
    return true;
  };
  f.controlledFields = async ({ projectId }) => (Number(projectId) === 11 ? destinationFields : FIELDS);
  f.request = async (identity, url, options = {}) => {
    const res = await request(identity, url, options);
    if (options.method === 'POST') return res;
    const body = await res.json();
    return { status: 200, json: async () => ({ ...body, fields: { ...body.fields, summary: 'edited after the move', project: { id: '11' } } }) };
  };
  return f;
}

test('an item moved to an untracked project is recorded once and then follows the destination', async () => {
  const f = movedFixture();
  const result = await collectTree({ rootIssueId: '1', rootIssueKey: 'FEAT-1', now: 5_000_000 });
  assert.equal(result.outcome, 'NO_CHANGE', 'the destination tracks nothing, so the edit is not drift');
  const moves = f.tryAppendCalls.filter(e => e.eventType === 'BASELINE_SCOPE_CHANGED');
  assert.equal(moves.length, 1);
  assert.deepEqual({ ...moves[0].payload }, { fromProjectId: 10, fromIssueTypeId: '20', toProjectId: 11, toIssueTypeId: '20',
    baselineVersion: 1, destinationTrackedFields: 0 });

  await collectTree({ rootIssueId: '1', rootIssueKey: 'FEAT-1', now: 5_000_001 });
  assert.equal(f.tryAppendCalls.filter(e => e.eventType === 'BASELINE_SCOPE_CHANGED').length, 1, 'recorded once, not on every update');
});

test('an item moved to a project that tracks the same field still drifts on it', async () => {
  const f = movedFixture({ destinationFields: FIELDS });
  const result = await collectTree({ rootIssueId: '1', rootIssueKey: 'FEAT-1', now: 5_000_000 });
  assert.equal(result.outcome, 'DRIFT_RECORDED');
  assert.equal(f.tryAppendCalls.filter(e => e.eventType === 'BASELINE_SCOPE_CHANGED')[0].payload.destinationTrackedFields, 1);
});

test('a move another collector already recorded is not recorded twice', async () => {
  const f = movedFixture();
  f.moveScope = async () => false;                       // someone else won the conditional update
  f.getReview = async () => f.review;
  await collectTree({ rootIssueId: '1', rootIssueKey: 'FEAT-1', now: 5_000_000 });
  assert.equal(f.tryAppendCalls.filter(e => e.eventType === 'BASELINE_SCOPE_CHANGED').length, 0);
});

// ── Child baselines (2026-09-24): a child's content is its own drift ─────────

test('a child that carries its own baseline: its field change is not parent drift', async () => {
  const f = baseFixture({ baselineChildren: [{ id: '2', summary: 'story' }], liveChildren: [{ id: '2', summary: 'edited' }] });
  f.childBaselines.set(2, { issue_id: 2, version: 3, tree_hash: null, captured_by_baseline_id: f.review.baseline_id });
  const result = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', detectedVia: 'EVENT', now: 1000 });
  assert.equal(result.outcome, 'NO_CHANGE');
  assert.equal(f.replaceTreeDriftCalls.length, 0);
});

test('a child baselined on its own after the parent capture also owns its content', async () => {
  const f = baseFixture({ baselineChildren: [{ id: '2', summary: 'story' }], liveChildren: [{ id: '2', summary: 'edited' }] });
  const parent = await f.activeBaseline();
  f.activeBaseline = async () => ({ ...parent, captured_at: 500 });
  f.childBaselines.set(2, { issue_id: 2, version: 5, tree_hash: null, captured_by_baseline_id: null, captured_at: 900 });
  const result = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', detectedVia: 'EVENT', now: 1000 });
  assert.equal(result.outcome, 'NO_CHANGE');
});

test('a child with no baseline of its own (a tree captured before child baselines) is still parent drift', async () => {
  const f = baseFixture({ baselineChildren: [{ id: '2', summary: 'story' }], liveChildren: [{ id: '2', summary: 'edited' }] });
  const result = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', detectedVia: 'EVENT', now: 1000 });
  assert.equal(result.outcome, 'DRIFT_RECORDED');
  assert.deepEqual(result.kinds, ['FIELD_CHANGED']);
});

test('a child added under a parent whose children own their content is still parent drift', async () => {
  const f = baseFixture({ baselineChildren: [{ id: '2', summary: 'story' }],
    liveChildren: [{ id: '2', summary: 'edited' }, { id: '3', summary: 'new' }] });
  f.childBaselines.set(2, { issue_id: 2, version: 3, tree_hash: null, captured_by_baseline_id: f.review.baseline_id });
  const result = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', detectedVia: 'EVENT', now: 1000 });
  assert.equal(result.outcome, 'DRIFT_RECORDED');
  assert.deepEqual(result.kinds, ['NODE_ADDED']);
  assert.deepEqual(f.replaceTreeDriftCalls[0].driftRows.map(r => r.fieldId), ['NODE_ADDED']);
});

test('the root\'s own field change is parent drift, whatever its children carry', async () => {
  const f = baseFixture();
  f.childBaselines.set(2, { issue_id: 2, version: 3, tree_hash: null, captured_by_baseline_id: f.review.baseline_id });
  const request = f.request;
  f.request = async (identity, url, options = {}) => {
    const res = await request(identity, url, options);
    if (options.method === 'POST') return res;
    const body = await res.json();
    return { status: 200, json: async () => ({ ...body, fields: { ...body.fields, summary: 'root edited' } }) };
  };
  const result = await collectTree({ rootIssueId: 1, rootIssueKey: 'FEAT-1', detectedVia: 'EVENT', now: 1000 });
  assert.equal(result.outcome, 'DRIFT_RECORDED');
  assert.deepEqual(result.kinds, ['FIELD_CHANGED']);
});

test('an update to a child with its own single-issue baseline runs the single-issue collector too', async () => {
  const calls = [];
  const results = await collectAffectedTrees({ issue: { id: '2', key: 'FEAT-2', fields: { parent: { id: '1' } } }, eventId: 'e1' }, {
    affectedTreeRoots: async () => [{ rootIssueId: 1, rootIssueKey: 'FEAT-1' }],
    collectTree: async args => { calls.push(['tree', args.rootIssueKey]); return { outcome: 'NO_CHANGE' }; },
    ownFlatBaseline: async id => { calls.push(['own?', id]); return true; },
    collect: async args => { calls.push(['flat', args.issueId, args.issueKey]); return { outcome: 'DRIFT_RECORDED' }; }
  });
  assert.deepEqual(calls.filter(c => c[0] !== 'own?'), [['tree', 'FEAT-1'], ['flat', 2, 'FEAT-2']]);
  assert.deepEqual(results.map(r => r.outcome), ['NO_CHANGE', 'DRIFT_RECORDED']);
});

test('an update to an issue with a tree baseline or none is left to the tree collectors', async () => {
  let flat = 0;
  const results = await collectAffectedTrees({ issue: { id: '1', key: 'FEAT-1', fields: {} } }, {
    affectedTreeRoots: async () => [{ rootIssueId: 1, rootIssueKey: 'FEAT-1' }],
    collectTree: async () => ({ outcome: 'NO_CHANGE' }),
    ownFlatBaseline: async () => false,
    collect: async () => { flat += 1; return { outcome: 'NO_CHANGE' }; }
  });
  assert.equal(flat, 0);
  assert.equal(results.length, 1);
});
