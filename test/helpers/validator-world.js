/**
 * A simulated Jira site and VAtlassian database for end-to-end scenarios.
 *
 * Runs the REAL validator runtime (lib/approval/runtime.js gateRuntime +
 * gate.js) and the REAL panel summary (usecases/panelSummary.js getSummary).
 * Only the boundaries are replaced: Jira REST, SQL and the ledger. A scenario
 * changes the world the way an admin (VAtlassian config) or Jira (workflow,
 * issue content) would, then asks the validator and the panel what they think.
 *
 * Import this module FIRST in a test file: it installs module hooks before the
 * real modules load.
 */
import { registerHooks } from 'node:module';

const mocked = {
  'lib/db.js': ['executeQuery', 'limitClause'],
  'lib/ledger.js': ['append'],
  'db/store.js': ['tryAppend', 'newId', 'throwing', 'isDuplicateKey'],
  'db/approvalStore.js': ['pendingApprovalFor', 'pendingApprovalByToken', 'casConsume', 'voidOthers',
    'latestApproval', 'pendingApprovalForActor', 'recordApproval', 'activateApproval', 'invalidateApproval', 'approvalById'],
  'db/configStore.js': ['gatedTransition', 'controlledFields', 'projectConfig', 'declaredFieldRows',
    'seedControlledFields', 'countControlledFields', 'listGatedTransitions', 'gateActiveOutOf'],
  'db/baselineStore.js': ['activeBaseline', 'baselineByVersion'],
  'db/baselineTreeStore.js': ['rootNodeDigests', 'activeRootsForNode', 'driftedDescendants', 'capturingParent'],
  'db/itemStateStore.js': ['getReview'],
  'db/incidentStore.js': ['adminIncidentCount'],
  'db/credentialStore.js': ['credentialState'],
  'db/adminStore.js': ['isActiveAdmin'],
  'db/restoreStore.js': ['restoresForIssue'],
  'lib/reviewer.js': ['isEligible'],
  'db/linkPendingStore.js': ['linkDecisionsPending']
};
const extra = {
  'lib/ledger.js': "export const EVENT = new Proxy({}, { get: (_, k) => String(k) });",
  'db/store.js': 'export const auditStore = {};'
};

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@forge/api') return { url: 'world:api', shortCircuit: true };
    if (specifier === '@forge/sql') return { url: 'world:sql', shortCircuit: true };
    const resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL).pathname : specifier;
    const key = Object.keys(mocked).find(k => resolved.endsWith('/src/' + k));
    return key ? { url: 'world:' + key, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'world:api') return { format: 'module', shortCircuit: true, source: `
      export const route = (s, ...v) => s.reduce((a, b, i) => a + b + (i < v.length ? encodeURIComponent(String(v[i])) : ''), '');
      const client = who => ({ requestJira: (...a) => globalThis.vaWorld.jira(who, ...a) });
      export default { asUser: () => client('user'), asApp: () => client('app') };` };
    if (url === 'world:sql') return { format: 'module', shortCircuit: true, source: 'export const sql = {};' };
    const names = mocked[url.slice(6)];
    if (names) return { format: 'module', shortCircuit: true,
      source: names.map(n => `export const ${n} = (...a) => globalThis.vaWorld.db.${n}(...a);`).join('\n')
        + '\n' + (extra[url.slice(6)] ?? '') };
    return next(url, context);
  }
});

const { createGate } = await import('../../src/gate.js');
const { gateRuntime, approvalContentHash } = await import('../../src/lib/approval/runtime.js');
const { getSummary } = await import('../../src/usecases/panelSummary.js');
const { project } = await import('../../src/lib/content.js');
const { makeApproval } = await import('../../src/lib/approval/record.js');

export const T0 = 1_760_000_000_000;
const clone = v => structuredClone(v);
const hex = b => Buffer.from(b).toString('hex');
let idSeq = 1;
const newId = () => { const b = Buffer.alloc(16); b.writeUInt32BE(idSeq++, 12); return b; };

/** The standard workflow: To Do(1) -> In Progress(2) -> Review(3) -> Done(4), plus globals. */
export const WORKFLOW = [
  { id: '11', name: 'Start', from: ['1'], to: '2' },
  { id: '21', name: 'Send to review', from: ['2'], to: '3' },
  { id: '31', name: 'Approve', from: ['3'], to: '4' },
  { id: '32', name: 'Reject', from: ['3'], to: '2' },
  { id: '41', name: 'Reopen', from: ['4'], to: '2' },
  { id: '91', name: 'Backlog', from: '*', to: '1' },
  { id: '92', name: 'Back to review', from: '*', to: '3' }
];

export const TRACKED = [
  { field_id: 'summary', field_kind: 'TEXT', store_values: true, materiality: 'MAJOR' },
  { field_id: 'description', field_kind: 'ADF', store_values: true, materiality: 'MAJOR' },
  { field_id: 'labels', field_kind: 'MULTI', store_values: true, materiality: 'MINOR' },
  { field_id: 'priority', field_kind: 'SCALAR', store_values: true, materiality: 'MINOR' },
  { field_id: 'customfield_100', field_kind: 'SCALAR', store_values: true, materiality: 'COSMETIC' }
];

export const doc = text => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

export function world({ workflow = WORKFLOW, tracked = TRACKED } = {}) {
  const w = {
    now: T0,
    issues: new Map(),
    workflows: new Map([['1:1', clone(workflow)]]),       // "projectId:issueTypeId" -> transitions
    projectConfig: new Map([[1, { enabled: true }]]),
    controlledFields: new Map([['1:1', clone(tracked)]]),
    controlledTransitions: [],
    baselines: [],
    rootDigests: new Map(),                                   // baseline hex -> digests
    itemState: new Map(),
    approvals: [],
    eligibility: [{ account_id: 'reviewer', role: 'reviewer', project_id: null, issue_type_id: '*', state: 'ACTIVE' }],
    audit: [],
    attachmentAliases: [],
    linkPending: [],                                          // { issue_id, decided_on_issue_id, decided_on_key, queued_at }                                    // { issue_id, attachment_id, stands_for_id } a restore recorded
    faults: new Set(),                                        // e.g. 'jira:issue', 'jira:transitions', 'db:config', 'db:baseline', 'db:item', 'db:rootDigests', 'db:alias'
    calls: []
  };

  // ── Jira REST ──────────────────────────────────────────────────────────
  w.jira = async (who, url, options = {}) => {
    const path = decodeURIComponent(String(url));
    w.calls.push({ who, path, method: options.method ?? 'GET' });
    // A user who has never granted the app consent: Forge cannot act as them.
    if (who === 'user' && w.faults.has('jira:noConsent')) {
      throw Object.assign(new Error('Authentication required'), { name: 'NeedsAuthenticationError', code: 'NEEDS_AUTHENTICATION_ERR' });
    }
    const res = (status, body) => ({ ok: status < 300, status, json: async () => clone(body), text: async () => JSON.stringify(body) });
    const m = path.match(/^\/rest\/api\/3\/issue\/([^/?]+)(\/transitions)?/);
    if (path.startsWith('/rest/api/3/myself')) return res(200, { accountId: w.actor ?? 'reviewer', displayName: 'Reviewer', active: true });
    if (!m) return res(404, {});
    const issue = [...w.issues.values()].find(i => i.key === m[1] || i.id === m[1]);
    if (!issue) return res(404, {});
    if (m[2]) {
      if (w.faults.has('jira:transitions')) return res(503, {});
      // A workflow condition can hide a transition from the app that the user can still take.
      const visible = w.available(issue.key).filter(t => !(who === 'app' && w.hiddenFromApp?.has(t.id)));
      return res(200, { transitions: visible.map(t => ({ id: t.id, name: t.name, to: { id: t.to, name: t.to },
        isAvailable: true, hasScreen: false, fields: {} })) });
    }
    if (w.faults.has('jira:issue')) return res(503, {});
    return res(200, issue);
  };

  w.workflowFor = issue => w.workflows.get(`${issue.fields.project.id}:${issue.fields.issuetype.id}`) ?? [];
  w.available = key => {
    const issue = w.issue(key);
    const status = issue.fields.status.id;
    return w.workflowFor(issue).filter(t => (t.from === '*' || t.from.includes(status)) && !(w.hidden?.has(t.id)));
  };

  // ── Issues ─────────────────────────────────────────────────────────────
  /** `childOf`: the key of this issue's parent (Jira's `parent` link). */
  w.createIssue = ({ key = 'T-1', id = String(1000 + w.issues.size), status = '1', projectId = '1', issueTypeId = '1', fields = {},
    childOf = null } = {}) => {
    const parent = childOf ? w.issue(childOf) : null;
    const issue = { id, key, fields: {
      summary: `Summary of ${key}`, description: doc(`Description of ${key}`), labels: ['alpha'],
      priority: { id: '3', name: 'Medium' }, customfield_100: 'x', customfield_200: 'untracked',
      issuelinks: [], subtasks: [],
      status: { id: status }, project: { id: projectId }, issuetype: { id: issueTypeId },
      parent: parent ? { id: parent.id, key: parent.key } : null, ...fields } };
    w.issues.set(key, issue);
    return issue;
  };
  w.issue = key => { const i = w.issues.get(key); if (!i) throw new Error(`no issue ${key}`); return i; };
  w.edit = (key, fields) => Object.assign(w.issue(key).fields, clone(fields));
  w.status = key => w.issue(key).fields.status.id;

  const scopeOf = issue => ({ projectId: Number(issue.fields.project.id), issueTypeId: String(issue.fields.issuetype.id) });
  const trackedFor = (projectId, issueTypeId) => [
    ...(w.controlledFields.get(`${projectId}:${issueTypeId}`) ?? []),
    ...(w.controlledFields.get(`${projectId}:*`) ?? [])
  ];

  // ── App configuration (what an admin does in VAtlassian) ───────────────
  w.control = ({ transitionId, from, to, role = 'reviewer', assurance = 'ESIGNATURE', meaning = 'Approved', capture = true,
    projectId = 1, issueTypeId = '1', state = 'ACTIVE' }) => {
    const t = [...w.workflows.values()].flat().find(x => x.id === String(transitionId));
    const row = { ct_id: newId(), project_id: projectId, issue_type_id: issueTypeId,
      from_status_id: from ?? (t && t.from !== '*' ? t.from[0] : '*'), to_status_id: to ?? t?.to,
      transition_id: String(transitionId), required_role: role, required_assurance: assurance, meaning,
      capture_baseline: capture, require_decision: true, state };
    w.controlledTransitions.push(row);
    return row;
  };
  w.uncontrol = transitionId => { w.controlledTransitions = w.controlledTransitions.filter(r => r.transition_id !== String(transitionId)); };
  w.disableProject = (projectId = 1) => w.projectConfig.set(projectId, { enabled: false });
  w.enableProject = (projectId = 1) => w.projectConfig.set(projectId, { enabled: true });

  // ── Baselines (what a signed controlled transition leaves behind) ──────
  /** `capturedBy`: the parent baseline whose tree capture wrote this one (child baselines). */
  w.baseline = (key, { transitionId = '31', from = '3', to = '4', role = 'reviewer', assurance = 'ESIGNATURE',
    tree = false, approvedBy = 'reviewer', capturedBy = null } = {}) => {
    const issue = w.issue(key);
    const { projectId, issueTypeId } = scopeOf(issue);
    const p = project(issue.fields, trackedFor(projectId, issueTypeId));
    for (const b of w.baselines) if (b.issue_id === Number(issue.id) && b.state === 'ACTIVE') b.state = 'SUPERSEDED';
    const version = w.baselines.filter(b => b.issue_id === Number(issue.id)).length + 1;
    const b = { baseline_id: newId(), issue_id: Number(issue.id), project_id: projectId, issue_type_id: issueTypeId,
      version, state: 'ACTIVE', content_hash: p.contentHash,
      field_digests: tree ? '{}' : JSON.stringify(p.digests), tree_hash: tree ? 'tree-' + version : null,
      transition_id: String(transitionId), from_status_id: from, to_status_id: to,
      required_role: role, required_assurance: assurance, controlled_fields_hash: 'c'.repeat(64),
      transition_at: w.now, captured_at: w.now, approved_by: approvedBy, approval_id: newId(),
      captured_by_baseline_id: capturedBy?.baseline_id ?? null,
      // What va_baseline_value retains: the link worker reads it (jobs/linkWorker.js).
      values: clone(p.raw) };
    w.baselines.push(b);
    if (tree) w.rootDigests.set(hex(b.baseline_id), JSON.stringify(p.digests));
    w.itemState.set(Number(issue.id), { state: 'BASELINED', baseline_version: version, lock_token: null, version: 1 });
    return b;
  };
  w.activeBaseline = key => w.baselines.find(b => b.issue_id === Number(w.issue(key).id) && b.state === 'ACTIVE') ?? null;
  /** Every descendant through Jira's `parent` link, recursively. */
  w.descendants = key => {
    const id = w.issue(key).id;
    const children = [...w.issues.values()].filter(i => String(i.fields.parent?.id ?? '') === String(id));
    return children.flatMap(c => [c, ...w.descendants(c.key)]);
  };
  /**
   * A parent's controlled-transition capture, as lib/capture.js does it: the
   * parent's tree baseline, then a baseline for every descendant whose own
   * project and issue type track fields, over those fields, signed by the
   * parent's approval (captured_by_baseline_id).
   */
  w.captureTree = (key, opts = {}) => {
    const parent = w.baseline(key, { ...opts, tree: true });
    const children = w.descendants(key)
      .filter(child => trackedFor(...Object.values(scopeOf(child))).length > 0)
      .map(child => w.baseline(child.key, { transitionId: parent.transition_id, from: parent.from_status_id,
        to: parent.to_status_id, role: parent.required_role, assurance: parent.required_assurance, capturedBy: parent }));
    return { parent, children };
  };
  /** A drift APPROVE: the current content becomes the new baseline, in place. */
  w.approveDrift = key => {
    const old = w.activeBaseline(key);
    const again = { transitionId: old.transition_id, from: old.from_status_id, to: old.to_status_id,
      role: old.required_role, assurance: old.required_assurance };
    // A parent's approval is a tree capture: it re-baselines every child too.
    return old.tree_hash ? w.captureTree(key, again).parent : w.baseline(key, { ...again, tree: false });
  };
  /** Whether an issue's live tracked content differs from its active baseline (what the collector records). */
  w.driftedNow = issue => {
    const b = w.baselines.find(x => x.issue_id === Number(issue.id) && x.state === 'ACTIVE');
    if (!b) return false;
    const digests = b.tree_hash ? JSON.parse(w.rootDigests.get(hex(b.baseline_id)) ?? '{}') : JSON.parse(b.field_digests);
    const now = project(issue.fields, trackedFor(...Object.values(scopeOf(issue)))).digests;
    return Object.keys(digests).some(f => digests[f] !== now[f]);
  };
  /** A drift REJECT that restores completely: the tracked content goes back. */
  w.restoreDrift = (key, values) => w.edit(key, values);

  // ── Approvals (a signature placed for a controlled transition) ─────────
  w.sign = async (key, transitionId, { account = 'reviewer', expiresIn = 600_000, baselineBound = null } = {}) => {
    const issue = w.issue(key);
    const t = w.available(key).find(x => x.id === String(transitionId)) ?? w.workflowFor(issue).find(x => x.id === String(transitionId));
    const { projectId, issueTypeId } = scopeOf(issue);
    const { contentHash } = await approvalContentHash({ issue: { ...issue, issueId: Number(issue.id), issueKey: issue.key },
      declared: trackedFor(projectId, issueTypeId), activeBaseline: null });
    const binding = { accountId: account, issueId: Number(issue.id), fromStatusId: w.status(key), toStatusId: t.to,
      contentHash, decision: 'APPROVE', transitionId: String(transitionId) };
    const proof = { ok: true, level: 'ESIGNATURE', providerId: 'totp',
      evidence: { method: 'SESSION_AND_TOTP', verifiedAt: w.now, binding } };
    const ct = w.controlledTransitions.find(r => r.transition_id === String(transitionId));
    const row = { ...makeApproval({ ...binding, issueKey: key, projectId, issueTypeId, actorName: 'Reviewer',
      meaning: ct?.meaning ?? 'Approved', signerRole: ct?.required_role ?? 'reviewer', proof,
      transitionId: String(transitionId), now: w.now, baselineId: baselineBound?.baseline_id ?? null,
      baselineVersion: baselineBound?.version ?? null }), state: 'PENDING' };
    row.expires_at = w.now + expiresIn;
    w.approvals.push(row);
    return row;
  };

  // ── The validator, called the way Jira calls it ────────────────────────
  /**
   * `configured`: the validator on this transition was set up through its
   * setup screen, which saved the transition's id into its configuration (true), or a
   * specific (possibly stale or copied) id to have saved instead.
   */
  w.transition = async (key, transitionId, { omitId = false, modifiedFields = {}, fromOverride, toOverride, dry = false,
    configured = false } = {}) => {
    const issue = w.issue(key);
    const t = w.workflowFor(issue).find(x => x.id === String(transitionId));
    if (!t) throw new Error(`no transition ${transitionId}`);
    const payload = { issue: { key }, transition: {
      ...(omitId ? {} : { id: Number(transitionId) }),
      from: { id: Number(fromOverride ?? issue.fields.status.id) }, to: { id: Number(toOverride ?? t.to) }, modifiedFields },
      configuration: configured === false ? { configuredIn: 'admin' }
        : { configuredIn: 'admin', transitionId: configured === true ? String(transitionId) : String(configured) } };
    const runtime = await gateRuntime();
    const result = await createGate({ ...runtime, now: () => w.now, log: () => {} })(payload);
    if (result.result && !dry) {
      // Jira applies the transition screen's field values along with the move.
      Object.assign(issue.fields, clone(modifiedFields));
      issue.fields.status = { id: t.to };
    }
    return result;
  };
  /** Ask every currently available transition, without moving. */
  w.verdicts = async key => {
    const out = {};
    for (const t of w.available(key)) out[t.id] = await w.transition(key, t.id, { dry: true });
    return out;
  };
  w.moves = async (key, transitionId, opts) => (await w.transition(key, transitionId, opts)).result;

  // ── The panel, as a viewer opens it ────────────────────────────────────
  w.panel = async (key, account = 'reviewer') => {
    w.actor = account;
    const out = await getSummary({ payload: { issueKey: key }, context: { accountId: account } });
    if (out?.success === false || out?.error) throw new Error('panel failed: ' + JSON.stringify(out));
    return out.data ?? out;
  };

  // ── Database ───────────────────────────────────────────────────────────
  const fault = name => { if (w.faults.has(name)) throw Object.assign(new Error('db down'), { reason: 'SERVICE_UNAVAILABLE' }); };
  const matchCt = ({ projectId, issueTypeId, fromStatusId, toStatusId, transitionId }) => w.controlledTransitions.find(r =>
    r.state === 'ACTIVE' && Number(r.project_id) === Number(projectId)
    && (r.issue_type_id === String(issueTypeId) || r.issue_type_id === '*')
    && (r.from_status_id === String(fromStatusId) || r.from_status_id === '*')
    && (r.to_status_id === String(toStatusId) || r.to_status_id === '*')
    && transitionId != null && r.transition_id === String(transitionId)) ?? null;

  w.db = {
    executeQuery: async (sql, params = []) => {
      w.calls.push({ sql });
      if (/FROM va_item_state/.test(sql)) {
        if (w.faults.has('db:item')) return { result: false, error: 'down' };
        const row = w.itemState.get(Number(params[0]));
        return { result: true, data: row ? [clone(row)] : [] };
      }
      if (/UPDATE va_item_state/.test(sql)) return { result: true, data: [] };
      if (/FROM va_attachment_alias/.test(sql)) {
        if (w.faults.has('db:alias')) return { result: false, error: 'down' };
        const ids = params.map(Number);
        return { result: true, data: clone(w.attachmentAliases.filter(a => ids.includes(Number(a.issue_id)))) };
      }
      if (/va_eligibility/.test(sql)) return { result: true, data: w.eligible(params) ? [{ ok: 1 }] : [] };
      return { result: true, data: [] };
    },
    append: async (_store, event) => { w.audit.push(event); return { seq: w.audit.length }; },
    tryAppend: async event => { w.audit.push(event); },
    newId, throwing: async () => [], isDuplicateKey: () => false, limitClause: n => String(n),
    pendingApprovalFor: async ({ issueId, fromStatusId, toStatusId, transitionId, now, approvalId }) =>
      [...w.approvals].reverse().find(a => String(a.issue_id) === String(issueId) && a.state === 'PENDING'
        && a.from_status_id === fromStatusId && a.to_status_id === toStatusId && String(a.transition_id) === String(transitionId)
        && Number(a.expires_at) > now && (!approvalId || hex(a.approval_id) === approvalId)) ?? null,
    pendingApprovalByToken: async ({ issueId, approvalId }) =>
      w.approvals.find(a => String(a.issue_id) === String(issueId) && a.state === 'PENDING'
        && hex(a.approval_id) === hex(approvalId)) ?? null,
    casConsume: async ({ approvalId }) => {
      const a = w.approvals.find(x => hex(x.approval_id) === hex(approvalId) && x.state === 'PENDING');
      if (!a) return { consumed: false };
      a.state = 'CONSUMED';
      return { consumed: true };
    },
    voidOthers: async ({ issueId, exceptApprovalId }) => {
      for (const a of w.approvals) if (String(a.issue_id) === String(issueId) && a.state === 'PENDING'
        && (!exceptApprovalId || hex(a.approval_id) !== hex(exceptApprovalId))) a.state = 'VOID';
    },
    latestApproval: async issueId => [...w.approvals].reverse().find(a => String(a.issue_id) === String(issueId)) ?? null,
    pendingApprovalForActor: async () => null,
    recordApproval: async () => {}, activateApproval: async () => true, invalidateApproval: async () => {},
    approvalById: async id => w.approvals.find(a => hex(a.approval_id) === hex(id)) ?? null,
    gatedTransition: async args => { fault('db:config'); return clone(matchCt(args)); },
    controlledFields: async ({ projectId, issueTypeId }) => { fault('db:config'); return clone(trackedFor(projectId, issueTypeId)); },
    projectConfig: async projectId => { fault('db:config'); return clone(w.projectConfig.get(Number(projectId)) ?? { enabled: true }); },
    declaredFieldRows: async () => [], seedControlledFields: async () => {}, countControlledFields: async () => 0,
    listGatedTransitions: async projectId => { fault('db:config'); return clone(w.controlledTransitions.filter(r => Number(r.project_id) === Number(projectId))); },
    gateActiveOutOf: async () => null,
    activeBaseline: async issueId => { fault('db:baseline'); return clone(w.baselines.find(b => b.issue_id === Number(issueId) && b.state === 'ACTIVE') ?? null); },
    baselineByVersion: async (issueId, version) => clone(w.baselines.find(b => b.issue_id === Number(issueId) && b.version === Number(version)) ?? null),
    rootNodeDigests: async baselineId => { fault('db:rootDigests'); return w.rootDigests.get(hex(baselineId)) ?? null; },
    activeRootsForNode: async () => [],
    driftedDescendants: async baselineId => {
      const parent = w.baselines.find(b => hex(b.baseline_id) === hex(baselineId));
      const root = [...w.issues.values()].find(i => Number(i.id) === parent?.issue_id);
      return root ? w.descendants(root.key).filter(w.driftedNow).length : 0;
    },
    capturingParent: async baselineId => {
      const parent = w.baselines.find(b => hex(b.baseline_id) === hex(baselineId));
      const root = parent && [...w.issues.values()].find(i => Number(i.id) === parent.issue_id);
      return root ? { issueId: Number(root.id), issueKey: root.key, version: parent.version } : null;
    },
    getReview: async issueId => clone(w.itemState.get(Number(issueId)) ?? null),
    linkDecisionsPending: async (issueId, now = w.now) => w.linkPending
      .filter(p => p.issue_id === Number(issueId) && p.queued_at >= now - 120_000)
      .map(p => ({ decidedOnKey: p.decided_on_key, queuedAt: p.queued_at })),
    adminIncidentCount: async () => 0, credentialState: async () => ({ state: 'ACTIVE' }), isActiveAdmin: async () => false,
    restoresForIssue: async () => [],
    isEligible: async ({ accountId, projectId, issueTypeId, role }) =>
      w.eligibility.some(e => e.state === 'ACTIVE' && e.account_id === accountId && e.role === role
        && (e.project_id == null || Number(e.project_id) === Number(projectId))
        && (e.issue_type_id === '*' || e.issue_type_id === String(issueTypeId)))
  };
  // ELIGIBILITY_PREDICATE parameters: account_id, issue_type_id, role, state, project_id
  w.eligible = ([accountId, issueTypeId, role, state, projectId]) => w.eligibility.some(e => e.state === state
    && e.account_id === accountId && e.role === role
    && (e.project_id == null || Number(e.project_id) === Number(projectId))
    && (e.issue_type_id === '*' || e.issue_type_id === String(issueTypeId)));

  globalThis.vaWorld = w;
  return w;
}

/** Drift reasons as the validator words them. */
export const DRIFT = /changed since it was approved/i;
