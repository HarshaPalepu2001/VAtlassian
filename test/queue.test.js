import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

/**
 * MY APPROVALS: EVERYTHING WAITING ON THIS PERSON, BY THE ROLES THEY HOLD.
 *
 * Three kinds of work, decided by the same rules the panel and the signing
 * path enforce, so the list never offers what signing would refuse and never
 * hides what only this person can do:
 *
 *   CHANGES     a signed item edited since approval. Authority is the role
 *               frozen into its baseline, whatever the transition settings
 *               say today.
 *   RESTORE     a rejection whose restore did not finish.
 *   TRANSITION  a controlled transition this person may sign, read live.
 */
const BUG = '10004';
const STORY = '10001';
const SUBTASK = '10005';
const ACTOR = 'actor-1';

const modules = {
  'usecases/panelAccess.js': null,
  'lib/reviewer.js': ['grantsFor'],
  'db/configStore.js': ['controlledFields', 'projectConfig', 'gateActiveOutOf', 'gatedReviewStatuses', 'gatedTransition',
    'listGatedTransitions', 'declaredFieldRows', 'seedControlledFields', 'countControlledFields'],
  'db/itemStateStore.js': ['awaitingDecision'],
  'db/baselineStore.js': ['activeBaselines'],
  'db/restoreStore.js': ['latestRestoresFor'],
  'db/approvalStore.js': ['pendingMovesFor'],
  'db/linkPendingStore.js': ['linkDecisionsPendingFor']
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'fixture:api', shortCircuit: true };
    const resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL).pathname : specifier;
    const key = Object.keys(modules).find(k => resolved.endsWith('/' + k));
    return key ? { url: 'fixture:' + key, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'fixture:api') return { format: 'module', shortCircuit: true, source: `
      export const route = (s, ...v) => s.reduce((a, b, i) => a + b + (v[i] ?? ''), '');
      export default { asUser: () => ({ requestJira: (...a) => globalThis.vaQueue.request(...a) }) };` };
    // The real respond/serialise: Buffers leave as base64, exactly as in production.
    if (url === 'fixture:usecases/panelAccess.js') return { format: 'module', shortCircuit: true,
      source: `export { actorFrom, respond, fail } from ${JSON.stringify(new URL('../src/usecases/access.js', import.meta.url).href)};` };
    const names = modules[url.slice(8)];
    if (names) return { format: 'module', shortCircuit: true,
      source: names.map(n => `export const ${n} = (...a) => globalThis.vaQueue.${n}(...a);`).join('\n') };
    return next(url, context);
  }
});
const { list } = await import('../src/usecases/queue.js');
hooks.deregister();

const ok = body => ({ ok: true, status: 200, json: async () => structuredClone(body) });
const grant = (role, over = {}) => ({ account_id: ACTOR, project_id: '10001', issue_type_id: '*', role, state: 'ACTIVE', ...over });

function issue({ id, key = `VAT-${id}`, type = BUG, status = ['3', 'In Review'], project = '10001', transitions = [] }) {
  return { id: String(id), key, transitions: transitions.map(t => ({ id: t.id, name: t.name, isAvailable: true,
    to: { id: t.to, name: t.toName ?? t.name } })),
    fields: { summary: `${key} summary`, status: { id: status[0], name: status[1] }, project: { id: project },
      issuetype: { id: type } } };
}

/** A baseline carrying the rule it was signed under, as capture freezes it. */
function baseline(issueId, { role = 'SDE-1', version = 2 } = {}) {
  return { issue_id: issueId, baseline_id: Buffer.alloc(16, issueId), version, transition_id: '31', from_status_id: '3',
    to_status_id: '5', required_role: role, required_assurance: 'ESIGNATURE', controlled_fields_hash: 'a'.repeat(64) };
}

/** An item the app has recorded as changed since approval (va_item_state). */
function changed(issueId, over = {}) {
  return { issue_id: issueId, issue_key: `VAT-${issueId}`, project_id: 10001, issue_type_id: BUG, state: 'DRIFTED',
    baseline_version: 2, drift_count: 2, drifted_field_count: 1, max_materiality: 'MAJOR', last_drift_at: 1000, ...over };
}

/**
 * The Jira and storage this app would see. `issues` is what the viewer may
 * browse; searches return only those. `rules` are the active controlled
 * transitions.
 */
function world({ grants = [grant('SDE-1')], issues = [], rules = [], decisions = [], baselines = [],
  restores = [], pendingMoves = [], linkPending = [], searchPage = 50 } = {}) {
  const calls = { searches: [], reads: [] };
  const visible = new Map(issues.map(i => [i.id, i]));
  globalThis.vaQueue = {
    calls,
    grantsFor: async () => grants,
    controlledFields: async () => [], projectConfig: async () => ({ enabled: true }), gateActiveOutOf: async () => ({ gated: false }),
    listGatedTransitions: async () => [], declaredFieldRows: async () => [], seedControlledFields: async () => {},
    countControlledFields: async () => 0,
    gatedReviewStatuses: async () => rules.map(r => ({ projectId: 10001, issueTypeId: r.type ?? BUG, statusId: r.from,
      toStatusId: r.to, role: r.role })),
    gatedTransition: async ({ issueTypeId, fromStatusId, toStatusId }) => {
      const rule = rules.find(r => (r.type ?? BUG) === issueTypeId && (r.from === '*' || r.from === fromStatusId) && r.to === toStatusId);
      return rule ? { required_role: rule.role, required_assurance: 'ESIGNATURE', meaning: 'Approve' } : null;
    },
    awaitingDecision: async args => { calls.decisionScope = args; return decisions; },
    activeBaselines: async ids => new Map(baselines.filter(b => ids.map(Number).includes(b.issue_id)).map(b => [b.issue_id, b])),
    latestRestoresFor: async ids => new Map(restores.filter(r => ids.map(Number).includes(r.issue_id)).map(r => [r.issue_id, r])),
    pendingMovesFor: async ({ issueIds }) => pendingMoves.filter(p => issueIds.map(Number).includes(p.issue_id)),
    linkDecisionsPendingFor: async ids => new Set(linkPending.filter(id => ids.map(Number).includes(id))),
    request: async (url, options = {}) => {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        calls.searches.push(body.jql);
        const byId = /^id in \(([\d,]+)\)$/.exec(body.jql);
        const matches = byId
          ? issues.filter(i => byId[1].split(',').includes(i.id))
          : issues.filter(i => rules.some(r => (r.type ?? BUG) === i.fields.issuetype.id
            && (r.from === '*' || r.from === i.fields.status.id)));
        const start = Number(body.nextPageToken ?? 0);
        const page = matches.slice(start, start + Math.min(searchPage, body.maxResults));
        const next = start + page.length < matches.length ? String(start + page.length) : null;
        return ok({ issues: page.map(({ transitions, ...rest }) => rest), nextPageToken: next });
      }
      calls.reads.push(url);
      const key = /issue\/([^?]+)/.exec(url)[1];
      const found = issues.find(i => i.key === key);
      return found ? ok(found) : { ok: false, status: 404, json: async () => ({}) };
    }
  };
  return calls;
}

const run = (payload = {}) => list({ payload, context: { accountId: ACTOR } });

test('a controlled transition the viewer may sign is listed, read live in one request', async () => {
  const bug = issue({ id: 7, transitions: [{ id: '101', name: 'Done', to: '5' }] });
  const subtask = issue({ id: 8, type: SUBTASK, transitions: [{ id: '102', name: 'Done', to: '5' }] });
  const calls = world({ issues: [bug, subtask], rules: [{ from: '*', to: '5', role: 'SDE-1' }] });

  const result = await run();

  assert.deepEqual(result.items.map(i => [i.issueKey, i.kind, i.transitionName]), [['VAT-7', 'TRANSITION', 'Done']]);
  assert.match(calls.searches[0], /issuetype = 10004/);
  assert.equal(calls.reads.length, 1, 'one read per candidate: its status and transitions together');
  assert.match(calls.reads[0], /expand=transitions/);
});

test('an item whose live status has moved on is not offered, however stale the search', async () => {
  const moved = issue({ id: 16, status: ['10002', 'In Progress'] });
  const calls = world({ issues: [moved], rules: [{ from: '10002', to: '5', role: 'SDE-1' }] });
  // The search still claims In Review; the live read says In Progress, from which nothing is offered.
  const result = await run();
  assert.equal(result.items.length, 0);
  assert.equal(calls.reads.length, 1);
});

test('changes since approval are listed wherever the item now sits', async () => {
  const item = issue({ id: 1, status: ['5', 'Done'] });
  world({ issues: [item], rules: [{ from: '3', to: '5', role: 'SDE-1' }],
    decisions: [changed(1)], baselines: [baseline(1, { version: 5 })] });

  const result = await run();

  assert.equal(result.items.length, 1);
  assert.deepEqual([result.items[0].issueKey, result.items[0].kind, result.items[0].driftCount, result.items[0].materialCount],
    ['VAT-1', 'CHANGES', 2, 1]);
  assert.equal(result.items[0].baselineVersion, 5, 'the standing baseline, not a stale counter row');
  assert.equal(result.items[0].status, 'Done');
});

test('changes are decided by the role frozen into the baseline, not by today\'s transition settings', async () => {
  // The transition this item was signed on has since been removed. Jira still
  // holds the item on every move until the change is decided, so it must reach
  // whoever holds the role it was signed under.
  world({ issues: [issue({ id: 1 })], rules: [], decisions: [changed(1)], baselines: [baseline(1, { role: 'SDE-1' })] });
  assert.deepEqual((await run()).items.map(i => i.issueKey), ['VAT-1']);

  world({ grants: [grant('SDE-2')], issues: [issue({ id: 1 })], rules: [{ from: '3', to: '5', role: 'SDE-2' }],
    decisions: [changed(1)], baselines: [baseline(1, { role: 'SDE-1' })] });
  assert.deepEqual((await run()).items, [], 'holding another role is not authority over it');
});

test('a child approved through its parent reaches the parent\'s role holders', async () => {
  const child = issue({ id: 40, type: SUBTASK });
  world({ grants: [grant('SDE-1', { issue_type_id: SUBTASK })], issues: [child],
    decisions: [changed(40, { issue_type_id: SUBTASK })], baselines: [baseline(40, { role: 'SDE-1' })] });
  assert.deepEqual((await run()).items.map(i => i.issueKey), ['VAT-40']);
});

test('a site-wide grant finds changes in any project, and a project grant only its own', async () => {
  let calls = world({ grants: [grant('SDE-1', { project_id: null })] });
  await run();
  assert.deepEqual(calls.decisionScope, { projectIds: [], siteWide: true, limit: 2000 });

  calls = world({ grants: [grant('SDE-1', { project_id: '10001' }), grant('QA', { project_id: '10002' })] });
  await run();
  assert.deepEqual(calls.decisionScope, { projectIds: [10001, 10002], siteWide: false, limit: 2000 });
});

test('an item the viewer cannot browse is never listed, whatever the app recorded about it', async () => {
  world({ issues: [], decisions: [changed(9)], baselines: [baseline(9)] });
  assert.deepEqual((await run()).items, []);
});

test('a restore that did not finish is listed for everyone in the role; only the rejecter may retry it', async () => {
  const restore = { issue_id: 3, restore_id: Buffer.alloc(16, 3), baseline_version: 2, state: 'PARTIAL',
    actor_account_id: ACTOR, finished_at: 900, started_at: 800 };
  world({ issues: [issue({ id: 3 })], decisions: [changed(3, { state: 'ERROR' })], baselines: [baseline(3)], restores: [restore] });
  let [item] = (await run()).items;
  assert.equal(item.kind, 'RESTORE');
  assert.equal(item.canRetry, true);
  assert.equal(item.restoreId, Buffer.alloc(16, 3).toString('base64'));
  assert.equal(item.waitingSince, 900);

  world({ issues: [issue({ id: 3 })], decisions: [changed(3, { state: 'ERROR' })], baselines: [baseline(3)],
    restores: [{ ...restore, actor_account_id: 'someone-else' }] });
  [item] = (await run()).items;
  assert.equal(item.kind, 'RESTORE');
  assert.equal(item.canRetry, false, 'visible to the role, retry left to the person who rejected');
});

test('a restore of an earlier baseline version does not turn today\'s changes into a restore', async () => {
  world({ issues: [issue({ id: 3 })], decisions: [changed(3)], baselines: [baseline(3, { version: 4 })],
    restores: [{ issue_id: 3, restore_id: Buffer.alloc(16, 3), baseline_version: 2, state: 'FAILED', actor_account_id: ACTOR }] });
  assert.equal((await run()).items[0].kind, 'CHANGES');
});

test('changes say when a linked item\'s approval is being recorded, and when the last decision did not finish', async () => {
  world({ issues: [issue({ id: 4 }), issue({ id: 5 })], decisions: [changed(4), changed(5, { state: 'ERROR' })],
    baselines: [baseline(4), baseline(5)], linkPending: [4] });
  const notes = Object.fromEntries((await run()).items.map(i => [i.issueKey, i.note]));
  assert.deepEqual(notes, { 'VAT-4': 'LINK_RECORDING', 'VAT-5': 'DECISION_INCOMPLETE' });
});

test('decisions come first, oldest waiting first; transitions follow', async () => {
  const transition = issue({ id: 20, transitions: [{ id: '101', name: 'Done', to: '5' }] });
  world({ issues: [transition, issue({ id: 1, status: ['5', 'Done'] }), issue({ id: 2, status: ['5', 'Done'] })],
    rules: [{ from: '3', to: '5', role: 'SDE-1' }],
    decisions: [changed(1, { last_drift_at: 5000 }), changed(2, { last_drift_at: 1000 })],
    baselines: [baseline(1), baseline(2)] });
  assert.deepEqual((await run()).items.map(i => i.issueKey), ['VAT-2', 'VAT-1', 'VAT-20']);
});

test('a changed item is not also offered as a transition: Jira holds it until the change is decided', async () => {
  const both = issue({ id: 6, transitions: [{ id: '101', name: 'Done', to: '5' }] });
  const calls = world({ issues: [both], rules: [{ from: '3', to: '5', role: 'SDE-1' }],
    decisions: [changed(6)], baselines: [baseline(6)] });
  const result = await run();
  assert.deepEqual(result.items.map(i => [i.issueKey, i.kind]), [['VAT-6', 'CHANGES']]);
  assert.equal(calls.reads.length, 0, 'not read twice');
});

test('an approval Jira refused to act on is offered as a move to retry', async () => {
  const signed = issue({ id: 11, transitions: [{ id: '101', name: 'Done', to: '5' }] });
  world({ issues: [signed], rules: [{ from: '3', to: '5', role: 'SDE-1' }],
    pendingMoves: [{ issue_id: 11, transition_id: '101', from_status_id: '3', to_status_id: '5' }] });
  const [item] = (await run()).items;
  assert.equal(item.kind, 'TRANSITION');
  assert.equal(item.pendingMove, true);
});

test('a page is filled from further searches rather than coming back empty with more behind it', async () => {
  // Forty items in scope; only the last two are the viewer's to sign.
  const nobodys = Array.from({ length: 38 }, (_, n) => issue({ id: 100 + n }));
  const mine = [issue({ id: 200, transitions: [{ id: '101', name: 'Done', to: '5' }] }),
    issue({ id: 201, transitions: [{ id: '101', name: 'Done', to: '5' }] })];
  world({ issues: [...nobodys, ...mine], rules: [{ from: '3', to: '5', role: 'SDE-1' }], searchPage: 10 });
  const result = await run();
  assert.deepEqual(result.items.map(i => i.issueKey), ['VAT-200', 'VAT-201']);
  assert.equal(result.nextPageToken, null);
});

test('loading more continues the transition search and does not repeat the decisions', async () => {
  const items = Array.from({ length: 30 }, (_, n) => issue({ id: 300 + n, transitions: [{ id: '101', name: 'Done', to: '5' }] }));
  const calls = world({ issues: [...items, issue({ id: 1, status: ['5', 'Done'] })], rules: [{ from: '3', to: '5', role: 'SDE-1' }],
    decisions: [changed(1)], baselines: [baseline(1)], searchPage: 10 });
  const first = await run();
  assert.equal(first.items[0].issueKey, 'VAT-1');
  assert.ok(first.nextPageToken, 'more transitions remain');
  const more = await run({ nextPageToken: first.nextPageToken });
  assert.ok(more.items.length > 0);
  assert.ok(more.items.every(i => i.kind === 'TRANSITION'));
  assert.equal(calls.searches.filter(q => q.startsWith('id in')).length, 1, 'the decisions are read once, on the first page');
});

test('every pending decision is reachable across pages, in order, and none of them leaks into transitions', async () => {
  // 201 eligible decisions: one more than the old single-page cap. Each is
  // also a live candidate for the transition search below, so if the skip set
  // were ever rebuilt from only the page that finished decisions (losing the
  // other 200 ids), this test would see transition items appear alongside
  // them, even though the validator would refuse those transitions.
  const COUNT = 201;
  const issues = Array.from({ length: COUNT }, (_, n) => issue({ id: n + 1, transitions: [{ id: '101', name: 'Done', to: '5' }] }));
  const decisions = Array.from({ length: COUNT }, (_, n) => changed(n + 1, { last_drift_at: 1000 + n }));
  const baselines = Array.from({ length: COUNT }, (_, n) => baseline(n + 1));
  world({ issues, decisions, baselines, rules: [{ from: '3', to: '5', role: 'SDE-1' }] });

  const seen = [];
  let token;
  for (let page = 0; page < 10 && (page === 0 || token); page += 1) {
    const result = await run({ nextPageToken: token });
    seen.push(...result.items);
    token = result.nextPageToken;
  }

  assert.equal(seen.length, COUNT, 'every eligible decision is eventually reachable, not capped at the old 200-row limit');
  assert.equal(new Set(seen.map(i => i.issueKey)).size, COUNT, 'no decision repeats across pages');
  assert.deepEqual(seen.map(i => i.lastDriftAt), [...seen.map(i => i.lastDriftAt)].sort((a, b) => a - b), 'oldest first, across the page boundary');
  assert.ok(seen.every(i => i.kind === 'CHANGES'), 'every item under decision keeps that kind on every page: none leaked through as a transition');
});

test('a value cursor preserves the next item when an earlier decision resolves between pages', async () => {
  // A row-position cursor (page 2 starts "at index 200") breaks the moment
  // the set it indexes into changes shape: removing the earliest item here
  // shifts every later one up by one slot, so slice(200, 400) on the new,
  // 200-long array would return nothing and silently drop the 201st decision.
  const COUNT = 201;
  const issues = Array.from({ length: COUNT }, (_, n) => issue({ id: n + 1 }));
  const decisions = Array.from({ length: COUNT }, (_, n) => changed(n + 1, { last_drift_at: 1000 + n }));
  const baselines = Array.from({ length: COUNT }, (_, n) => baseline(n + 1));
  world({ issues, decisions, baselines });

  const first = await run();
  assert.equal(first.items.length, 200);
  assert.ok(first.nextPageToken, 'one decision remains');

  // The earliest item, already shown on the first page, gets decided
  // before the next page is fetched, exactly as a reviewer acting on it
  // between the two round trips would make it disappear from the store.
  decisions.splice(0, 1);

  const second = await run({ nextPageToken: first.nextPageToken });
  assert.deepEqual(second.items.map(i => i.issueKey), ['VAT-201'], 'the still-outstanding 201st decision is not skipped');
});

test('someone with no approval role gets an empty list without any Jira search', async () => {
  const calls = world({ grants: [] });
  assert.deepEqual(await run(), { items: [], nextPageToken: null });
  assert.equal(calls.searches.length, 0);
});
