import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

import { recallPlan, RECALL } from '../src/lib/recall.js';

/**
 * DRIFT PUTS THE ITEM BACK IN FRONT OF A REVIEWER.
 *
 * BS-11 was DRIFTED in our database and "In Progress" on the board, and every
 * transition out of In Progress was unguarded — the gate is configured on the
 * way out of REVIEW. The database knew and the board did not, and the board is
 * the one people act on.
 *
 * THE TARGET IS THE LATEST ACTIVE BASELINE'S OWN REVIEW STATUS, and nothing
 * else — never a list of "every status this project calls review", never
 * today's va_controlled_transition configuration. See lib/recall.js and
 * lib/restore/recall.js for why.
 *
 * These pin the things that make an automatic transition on somebody's live
 * work item defensible: it happens only when it is warranted, it happens
 * through exactly one screen-free route, and when the workflow offers zero,
 * two, or a blocked route it fails visibly instead of improvising.
 */

const REVIEW = '10426';
const IN_PROGRESS = '3';
const DONE = '10019';

const route = (id, toStatusId, extra = {}) => ({
  id, name: `To ${toStatusId}`, toStatusId, isAvailable: true, hasScreen: false, ...extra
});

const base = {
  currentStatusId: IN_PROGRESS,
  targetStatusId: REVIEW,
  transitions: [route('301', REVIEW), route('41', DONE)],
  driftCount: 2
};

// ─── recallPlan: pure decision, no I/O ───────────────────────────────────────

test('a drifted item past the gate is recalled to the baseline\'s review status', () => {
  const plan = recallPlan(base);

  assert.equal(plan.action, RECALL.RECALL);
  assert.equal(plan.target, REVIEW);
  assert.equal(plan.transitionId, '301');
});

test('an item that drifted while already at the baseline\'s review status is left exactly where it is', () => {
  // It is already in front of a reviewer and the gate already covers its exits.
  // Transitioning it onto itself is a no-op at best and a trigger loop at worst.
  const plan = recallPlan({ ...base, currentStatusId: REVIEW });

  assert.equal(plan.action, RECALL.ALREADY_IN_REVIEW);
  assert.equal(plan.transitionId, undefined);
});

test('no drift, no movement', () => {
  assert.equal(recallPlan({ ...base, driftCount: 0 }).action, RECALL.NO_DRIFT);
  assert.equal(recallPlan({ ...base, driftCount: null }).action, RECALL.NO_DRIFT);
});

test('a baseline with no recorded review status is never moved', () => {
  const plan = recallPlan({ ...base, targetStatusId: null });

  assert.equal(plan.action, RECALL.NOT_GATED);
});

test('zero Jira routes to the review status fails hard rather than picking a nearby status', () => {
  // THE RULE THAT KEEPS THIS SAFE. Improvising a destination would move a
  // customer's work item somewhere their workflow never intended. The item
  // stays put, still drifted, still queued, and the caller logs at error level.
  const plan = recallPlan({ ...base, transitions: [route('41', DONE)] });

  assert.equal(plan.action, RECALL.NO_ROUTE);
  assert.equal(plan.target, REVIEW);
  assert.equal(plan.transitionId, undefined);
});

test('a transition Jira marks unavailable is not a route', () => {
  const plan = recallPlan({
    ...base,
    transitions: [route('301', REVIEW, { isAvailable: false }), route('41', DONE)]
  });

  assert.equal(plan.action, RECALL.NO_ROUTE);
});

test('exactly one clean route is recalled through it', () => {
  const plan = recallPlan({ ...base, transitions: [route('301', REVIEW)] });

  assert.equal(plan.action, RECALL.RECALL);
  assert.equal(plan.transitionId, '301');
});

test('two Jira routes to review are ambiguous', () => {
  const plan = recallPlan({ ...base, transitions: [route('1', REVIEW), route('2', REVIEW)] });

  assert.equal(plan.action, RECALL.AMBIGUOUS_ROUTE);
  assert.deepEqual(plan.offered, ['1', '2']);
});

test('three or more routes are still reported as ambiguous, not truncated to two', () => {
  const plan = recallPlan({ ...base, transitions: [route('1', REVIEW), route('2', REVIEW), route('3', REVIEW)] });

  assert.equal(plan.action, RECALL.AMBIGUOUS_ROUTE);
  assert.deepEqual(plan.offered, ['1', '2', '3']);
});

test('the one route to review is blocked, not attempted, when it carries a transition screen', () => {
  // A screen with required fields cannot be satisfied by a job with no reviewer
  // to ask. Refused before any request reaches Jira, unlike the old behaviour
  // of attempting it anyway and discovering the same fact from a failed POST.
  const plan = recallPlan({ ...base, transitions: [route('301', REVIEW, { hasScreen: true })] });

  assert.equal(plan.action, RECALL.SCREEN_BLOCKED);
  assert.equal(plan.transitionId, '301');
});

test('a screen on one of several routes does not change an ambiguous result', () => {
  const plan = recallPlan({
    ...base,
    transitions: [route('1', REVIEW, { hasScreen: true }), route('2', REVIEW)]
  });

  assert.equal(plan.action, RECALL.AMBIGUOUS_ROUTE);
});

// ─── recallToReview: performs the plan, records what happened ───────────────
//
// Only @forge/api, the audit store, and the incident store are replaced.
// db/configStore.js is deliberately NOT wired to anything recallToReview can
// reach — if a future change reintroduced a configuration lookup on this path,
// the module would fail to resolve and every test below would fail loudly.

const modules = {
  'db/store.js': ['tryAppend'],
  'db/incidentStore.js': ['recordRecallFinding', 'clearRecallFindings']
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
      export const route = (s,...v) => s.reduce((a,b,i)=>a+b+(v[i]??''),'');
      export default {
        asUser: () => ({ requestJira: (...a) => globalThis.vaRecall.request(...a) }),
        asApp: () => ({ requestJira: (...a) => globalThis.vaRecall.request(...a) })
      };` };
    const names = modules[url.slice(8)];
    if (names) return { format: 'module', shortCircuit: true,
      source: names.map(n => `export const ${n} = (...a) => globalThis.vaRecall.${n}(...a);`).join('\n') };
    return next(url, context);
  }
});
const { recallToReview } = await import('../src/lib/restore/recall.js');

// Raw Jira /transitions response shape — distinct from the already-normalised
// shape recallPlan takes directly (see `route()` above). availableTransitions()
// (src/lib/transitions.js) is the real, unmocked code doing that normalising
// here, so the fixture has to hand it what Jira actually returns.
const jiraTransition = (id, toStatusId, extra = {}) => ({
  id, name: `To ${toStatusId}`, to: { id: toStatusId, name: toStatusId }, hasScreen: false, isAvailable: true, ...extra
});

function fixture() {
  const f = {
    audits: [], findings: [], cleared: [], requests: [], configLookups: [],
    transitions: [jiraTransition('301', REVIEW)],
    jiraOk: true, jiraStatus: 400, jiraMessages: ['A workflow validator blocked this transition.'],
    tryAppend: async (event) => { f.audits.push(event); },
    recordRecallFinding: async (args) => { f.findings.push(args); return true; },
    clearRecallFindings: async (args) => { f.cleared.push(args); return true; },
    request: async (url, options = {}) => {
      f.requests.push({ url: String(url), options });
      if (options.method === 'POST') {
        return f.jiraOk
          ? { status: 204 }
          : { status: f.jiraStatus, json: async () => ({ errorMessages: f.jiraMessages }) };
      }
      return { ok: true, status: 200, json: async () => ({ transitions: f.transitions }) };
    }
  };
  return f;
}

const call = (f, overrides = {}) => {
  globalThis.vaRecall = f;
  return recallToReview({
    issueId: 1, issueKey: 'T-1', projectId: 10, issueTypeId: '1',
    currentStatusId: IN_PROGRESS, driftCount: 2,
    baselineId: 'abc123', baselineVersion: 4, reviewStatusId: REVIEW, now: 1000,
    ...overrides
  });
};

test('the latest baseline\'s review status is the only recall target, and configuration is never consulted', async () => {
  const f = fixture();
  const result = await call(f);

  assert.equal(result.action, RECALL.RECALL);
  assert.equal(result.applied, true);
  assert.equal(result.transitionId, '301');
  assert.equal(f.configLookups.length, 0);
  assert.equal(f.audits.at(-1).eventType, 'DRIFT_RECALLED');
  assert.equal(f.audits.at(-1).payload.baselineId, 'abc123');
  assert.equal(f.findings.length, 0);
});

test('an item already at the review status is left alone, with no Jira calls at all', async () => {
  const f = fixture();
  const result = await call(f, { currentStatusId: REVIEW });

  assert.equal(result.action, RECALL.ALREADY_IN_REVIEW);
  assert.equal(f.requests.length, 0);
  assert.equal(f.findings.length, 0);
});

test('two Jira routes to the review status block recall and raise one administrator finding', async () => {
  const f = fixture();
  f.transitions = [jiraTransition('301', REVIEW), jiraTransition('302', REVIEW)];
  const result = await call(f);

  assert.equal(result.action, RECALL.AMBIGUOUS_ROUTE);
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 0);
  assert.equal(f.findings.length, 1);
  assert.equal(f.findings[0].failureType, RECALL.AMBIGUOUS_ROUTE);
  assert.equal(f.findings[0].baselineId, 'abc123');
  assert.equal(f.findings[0].baselineVersion, 4);
  assert.deepEqual(f.findings[0].offeredTransitionIds, ['301', '302']);
});

test('a screen-blocked route is refused before Jira is asked to apply it, and raises a finding', async () => {
  const f = fixture();
  f.transitions = [jiraTransition('301', REVIEW, { hasScreen: true })];
  const result = await call(f);

  assert.equal(result.action, RECALL.SCREEN_BLOCKED);
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 0);
  assert.equal(f.findings.length, 1);
  assert.equal(f.findings[0].failureType, RECALL.SCREEN_BLOCKED);
  assert.equal(f.findings[0].hasScreen, true);
});

test('a clean single route Jira itself refuses is reported as JIRA_REFUSED, not silently swallowed', async () => {
  const f = fixture();
  f.jiraOk = false;
  const result = await call(f);

  assert.equal(result.action, RECALL.JIRA_REFUSED);
  assert.equal(result.applied, false);
  assert.equal(f.findings.length, 1);
  assert.equal(f.findings[0].failureType, RECALL.JIRA_REFUSED);
  assert.deepEqual(f.findings[0].jiraResponse, { status: 400, messages: f.jiraMessages });
  assert.equal(f.audits.some(a => a.eventType === 'DRIFT_RECALL_FAILED'), true);
});

test('the same stuck baseline retried twice still reaches recordRecallFinding with its dedupe facts intact', async () => {
  const f = fixture();
  f.transitions = [jiraTransition('301', REVIEW), jiraTransition('302', REVIEW)];
  await call(f);
  await call(f, { now: 2000 });

  assert.equal(f.findings.length, 2);
  assert.equal(f.findings[0].baselineId, f.findings[1].baselineId);
  assert.equal(f.findings[0].baselineVersion, f.findings[1].baselineVersion);
  assert.equal(f.findings[0].failureType, f.findings[1].failureType);
  assert.equal(f.findings[1].now, 2000);
});

test('no drift means no Jira calls and no finding', async () => {
  const f = fixture();
  const result = await call(f, { driftCount: 0 });

  assert.equal(result.action, RECALL.NO_DRIFT);
  assert.equal(f.requests.length, 0);
  assert.equal(f.findings.length, 0);
});
