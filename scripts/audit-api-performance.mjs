// Local claim audit only: real production functions, injected storage/Jira,
// synthetic records. No deployment, network calls, or production timing claims.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { renderExecutionSummary } from '../src/testmgmt/summary.js';
import { contentDigest } from '../src/testmgmt/content.js';
import { createTestSummary } from '../src/usecases/testSummary.js';
import { memo, withRequestCache } from '../src/lib/cache.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(process.argv[2] ?? `${root}/docs/acceptance/api-speed-audit-2026-10-28`);
await mkdir(out, { recursive: true });
const temporary = await mkdtemp(`${tmpdir()}/vat-api-speed-`);
const sources = ['src/usecases/queue.js', 'src/db/itemStateStore.js', 'src/usecases/access.js',
  'src/testmgmt/messages.js', 'src/usecases/panelSummary.js', 'src/usecases/testSummary.js',
  'src/testmgmt/summary.js', 'src/testmgmt/requestReads.js', 'src/lib/cache.js', 'src/lib/transitions.js',
  'src/testmgmt/jira.js',
  'src/lib/hash.js', 'src/jobs/restoreWorker.js', 'src/jobs/vaultWorker.js'];
async function hashes() {
  return Object.fromEntries(await Promise.all(sources.map(async p => [p,
    createHash('sha256').update(await readFile(resolve(root, p))).digest('hex')])));
}
const before = await hashes();
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const describe = xs => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs) });
const actor = { accountId: 'api-audit' };

function recordFor(count, distinct = false) {
  const snapshot = { kind: 'TEST_EXECUTION_SUMMARY', schema: 1, generatedAt: 123,
    generatedBy: actor.accountId, execution: { id: '12', key: 'VAT-12', projectId: '100', summary: 'Execution', status: 'Done' },
    completeness: 'COMPLETE', problems: [], runCount: count,
    runs: Array.from({ length: count }, (_, i) => ({ runId: String(i).padStart(32, '0'),
      test: { id: distinct ? String(1000 + i) : '11', key: distinct ? `VAT-${1000 + i}` : 'VAT-11', summary: 'Pressure test' },
      version: { versionId: '1'.repeat(32), versionNo: 1, digest: 'a'.repeat(64), content: {
        objective: 'Verify pressure — 温度', preconditions: '', verifies: [],
        steps: [{ id: 's1', action: 'Read sensor', data: '', expected: '10' }] } },
      state: 'SIGNED', result: 'PASSED', configuration: 'ECU B', environment: 'bench', release: { id: '7', name: '1.0' },
      problems: [], steps: [{ id: 's1', status: 'PASSED', actual: '10' }],
      resolvedSteps: [{ id: 's1', action: 'Read sensor', data: '', expected: '10' }], iterations: [],
      signatures: [{ actorAccountId: 'qa-1', meaning: 'Approved', signedAt: 2 }], notExecutedSignatures: [], planningSnapshot: null })),
    coverage: count ? [{ test: { id: distinct ? '1000' : '11' }, executionIssueId: '12' }] : [] };
  return { summaryId: 'f'.repeat(32), executionIssueId: '12', projectId: '100', snapshot, digest: contentDigest(snapshot) };
}

// Nine repeats verify deterministic bytes; they are not independent network samples.
const payloads = [];
for (const count of [0, 1, 3, 30, 100, 500]) {
  const rec = recordFor(count);
  const repetitions = [];
  for (let trial = 0; trial < 9; trial++) {
    const downloads = renderExecutionSummary(rec);
    const value = { summaryId: rec.summaryId, digest: rec.digest, snapshot: rec.snapshot };
    assert.equal(downloads.json.content, JSON.stringify(value));
    const pretty = JSON.stringify(value, null, 2);
    const currentResponse = JSON.stringify({ ...value, completeness: rec.snapshot.completeness, downloads });
    const prettyResponse = JSON.stringify({ ...value, completeness: rec.snapshot.completeness,
      downloads: { ...downloads, json: { ...downloads.json, content: pretty } } });
    repetitions.push({ runs: count, compactDownloadBytes: Buffer.byteLength(downloads.json.content),
      prettyDownloadBytes: Buffer.byteLength(pretty), responseBytes: Buffer.byteLength(currentResponse),
      responseWithPrettyDownloadBytes: Buffer.byteLength(prettyResponse),
      responseGzipBytes: gzipSync(currentResponse).length, responseWithPrettyDownloadGzipBytes: gzipSync(prettyResponse).length,
      responseBrotliBytes: brotliCompressSync(currentResponse).length,
      responseWithPrettyDownloadBrotliBytes: brotliCompressSync(prettyResponse).length,
      snapshotEnvelopeBytes: Buffer.byteLength(JSON.stringify(value)) });
  }
  assert(repetitions.every(v => JSON.stringify(v) === JSON.stringify(repetitions[0])));
  payloads.push(repetitions[0]);
}

// Only local JSON serialization uses 100k iterations; never call a tenant 100k times.
const sample = recordFor(3);
const value = { summaryId: sample.summaryId, digest: sample.digest, snapshot: sample.snapshot };
const timings = { compactNs: [], prettyNs: [], pairedSpeedups: [] };
let sink = 0;
function time(pretty, iterations) {
  let length = 0;
  const start = process.hrtime.bigint();
  if (pretty) for (let i = 0; i < iterations; i++) length += JSON.stringify(value, null, 2).length;
  else for (let i = 0; i < iterations; i++) length += JSON.stringify(value).length;
  const ns = Number(process.hrtime.bigint() - start) / iterations;
  sink += length;
  return ns;
}
time(false, 5000); time(true, 5000);
for (let trial = 0; trial < 9; trial++) {
  let compact, pretty;
  if (trial % 2) { pretty = time(true, 100_000); compact = time(false, 100_000); }
  else { compact = time(false, 100_000); pretty = time(true, 100_000); }
  timings.compactNs.push(compact); timings.prettyNs.push(pretty); timings.pairedSpeedups.push(pretty / compact);
  console.error(`JSON timing pair ${trial + 1}/9 complete`);
}

const readCounts = [];
for (const distinct of [false, true]) for (const count of [1, 3, 30, 100]) {
  const trials = [];
  for (let trial = 0; trial < 9; trial++) {
    const rec = recordFor(count, distinct);
    const calls = { issue: [], sources: 0, project: 0, record: 0 };
    const uc = createTestSummary({
      readExecutionSummary: async () => { calls.record++; return rec; },
      readIssueAsUser: async id => { calls.issue.push(String(id)); return { id: String(id), fields: {
        project: { id: '100' }, issuetype: { id: String(id) === '12' ? '2' : '1' } } }; },
      readProject: async () => { calls.project++; return { enabled: true, executionTypeId: '2' }; },
      resolveTestSources: async () => { calls.sources++; return []; }
    });
    const response = await uc.read({ summaryId: rec.summaryId }, actor);
    assert.equal(response.snapshot.runCount, count);
    assert.equal(calls.issue.length, count + 3);
    assert.equal(calls.sources, 2 * count);
    trials.push({ runs: count, distinctTests: distinct, issueAdapterCalls: calls.issue.length,
      distinctIssueArguments: new Set(calls.issue).size, sourceAdapterCalls: calls.sources,
      projectAdapterCalls: calls.project, summaryStoreCalls: calls.record });
  }
  assert(trials.every(v => JSON.stringify(v) === JSON.stringify(trials[0])));
  readCounts.push(trials[0]);
}

const cacheTrials = [];
for (let trial = 0; trial < 9; trial++) {
  let calls = 0;
  const factory = async () => ++calls;
  await withRequestCache(async () => {
    const values = await Promise.all(Array.from({ length: 30 }, () => memo('same', factory)));
    assert(values.every(v => v === 1));
  });
  const withinInvocation = calls;
  await withRequestCache(() => memo('same', factory));
  assert.equal(calls, 2);
  await Promise.all(Array.from({ length: 30 }, () => withRequestCache(() => memo('same', factory))));
  assert.equal(calls, 32);
  cacheTrials.push({ sameInvocationRequests: 30, sameInvocationFactories: withinInvocation,
    nextInvocationAdditionalFactories: 1, separateInvocationsAdditionalFactories: 30 });
}

// Adapt existing dependency-injection fixtures; import actual current source.
async function fixtureFile(name, base, extra) {
  let source = (await readFile(resolve(root, base), 'utf8')).split('\ntest(')[0];
  if (name === 'panel.test.mjs') source = source.replace("'lib/transitions.js': ['availableTransitions'],", '');
  source = source.replaceAll("'../src/", `'${pathToFileURL(`${root}/src/`).href}`);
  source = source.replaceAll("new URL('../src/", `new URL('${pathToFileURL(`${root}/src/`).href}`);
  const path = resolve(temporary, name);
  await writeFile(path, source + '\n' + extra);
  return path;
}
const queueTest = await fixtureFile('queue.test.mjs', 'test/queue.test.js', `
test('nine repeats: 50 candidates use 1 search + 50 live reads with peak concurrency 5', async () => {
  for (let trial=0;trial<9;trial++) {
    const items=Array.from({length:50},(_,n)=>issue({id:300+n,transitions:[{id:'101',name:'Done',to:'5'}]}));
    const calls=world({issues:items,rules:[{from:'3',to:'5',role:'SDE-1'}]});
    let active=0,peak=0;
    const request=globalThis.vaQueue.request;
    globalThis.vaQueue.request=async(url,options)=>{
      if (!String(url).includes('/issue/')) return request(url,options);
      active++;peak=Math.max(peak,active);
      await new Promise(resolve=>setImmediate(resolve));
      try { return await request(url,options); } finally { active--; }
    };
    const result=await run();
    assert.equal(result.items.length,50);assert.equal(calls.searches.length,1);
    assert.equal(calls.reads.length,50);assert.equal(peak,5);
  }
});
test('nine repeats: issue hydration 429 is silently omitted', async () => {
  for(let trial=0;trial<9;trial++) {
    world({issues:[issue({id:300,transitions:[{id:'101',name:'Done',to:'5'}]})],rules:[{from:'3',to:'5',role:'SDE-1'}]});
    const request=globalThis.vaQueue.request;
    globalThis.vaQueue.request=async(url,options)=>String(url).includes('/issue/')
      ? {ok:false,status:429,headers:{get:()=> '3'}} : request(url,options);
    assert.deepEqual(await run(),{items:[],nextPageToken:null});
  }
});
test('nine repeats: current decision continuation reaches item 201',async()=>{
  const {readFile}=await import('node:fs/promises');
  let store=await readFile(${JSON.stringify(resolve(root, 'src/db/itemStateStore.js'))},'utf8');
  const adapter='data:text/javascript,'+encodeURIComponent('export const throwing=(...a)=>globalThis.auditQuery(...a);export const isDuplicateKey=()=>false;');
  store=store.replace("'./store.js'",JSON.stringify(adapter)).replaceAll("'../lib/",${JSON.stringify(`'${pathToFileURL(`${root}/src/lib/`).href}`)});
  const actual=await import('data:text/javascript,'+encodeURIComponent(store));
  for(let trial=0;trial<9;trial++){
    const pending=Array.from({length:201},(_,n)=>changed(n+1,{last_drift_at:n+1}));
    globalThis.auditQuery=async sql=>{assert.match(sql,/LIMIT 2000/);return pending.slice(0,Number(/LIMIT (\\d+)/.exec(sql)[1]));};
    world({issues:pending.map(row=>issue({id:row.issue_id})),baselines:pending.map(row=>baseline(row.issue_id))});
    globalThis.vaQueue.awaitingDecision=actual.awaitingDecision;
    const result=await run();
    assert.equal(result.items.length,200);assert.ok(result.nextPageToken);
    assert(!result.items.some(item=>item.issueId==='201'));
    const next=await run({nextPageToken:result.nextPageToken});
    assert.deepEqual(next.items.map(item=>item.issueId),['201']);assert.equal(next.nextPageToken,null);
  }
});
test('nine repeats: error envelopes discard status and retry timing',async()=>{
  const {respond}=await import(${JSON.stringify(pathToFileURL(resolve(root, 'src/usecases/access.js')).href)});
  const {tmRespond}=await import(${JSON.stringify(pathToFileURL(resolve(root, 'src/testmgmt/messages.js')).href)});
  const original=console.error;console.error=()=>{};
  try { for(let trial=0;trial<9;trial++) {
    const error=Object.assign(new Error('throttled'),{status:429,retryAfterMs:3000});
    const generic=await respond(async()=>{throw error;});const tm=await tmRespond(async()=>{throw error;});
    assert.equal(generic.reason,'ERROR');assert.equal(tm.reason,'SERVICE_UNAVAILABLE');
    for(const result of [generic,tm]) {assert(!('status' in result));assert(!('retryAfterMs' in result));}
  }}finally{console.error=original;}
});
`);
const panelTest = await fixtureFile('panel.test.mjs', 'test/panel-performance-contract.test.js', `
test('nine repeats: actual transition reader makes THREE panel Jira requests',async()=>{
  for(let trial=0;trial<9;trial++) {
    const f=fixture();const original=f.request;const urls=[];
    f.request=async(...args)=>{urls.push(String(args[1]));return original(...args);};
    const result=await getSummary(args);assert.equal(result.error,undefined);
    assert.equal(urls.length,3);assert.equal(urls.filter(url=>url.includes('/issue/')&&!url.includes('/transitions')).length,1);
    assert.equal(urls.filter(url=>url.includes('/myself')).length,1);
    assert.equal(urls.filter(url=>url.includes('/transitions?expand=transitions.fields')).length,1);
  }
});
`);
const checked = spawnSync(process.execPath, ['--test', queueTest, panelTest], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
await writeFile(resolve(out, 'counterexamples.log'), checked.stdout + checked.stderr);
assert.equal(checked.status, 0, checked.stdout + checked.stderr);
assert.deepEqual(await hashes(), before, 'Audited source changed while measurement was running');
const report = { measuredAtUtc: new Date().toISOString(),
  source: { head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), sha256: before },
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  methodology: { repeats: 9, serializationIterationsPerRun: 100000, warmupPerVariant: 5000,
    variantOrder: 'alternating paired runs', fixtureRunsForTiming: 3,
    liveRequests: 0, byteCounts: 'UTF-8, before transport compression; gzip/brotli sizes are local experiments' },
  timings: { raw: timings, compactNs: describe(timings.compactNs), prettyNs: describe(timings.prettyNs),
    pairedSpeedup: describe(timings.pairedSpeedups), sink }, payloads, readCounts, cacheTrials,
  counterexamples: { testsPassed: 5, repeatsEach: 9, queueCandidates: 50, queueSearchRequests: 1,
    queueIssueReads: 50, peakIssueReadConcurrency: 5, panelIssueReads: 1, panelMyselfReads: 1, panelTransitionsReads: 1,
    pendingDecisionsAvailable: 201, firstPagePendingDecisions: 200, nextPagePendingDecisions: 1,
    pendingDecisionContinuation: 'present; item 201 reached', pendingDecisionFetchCap: 2000 } };
await writeFile(resolve(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ timings: {compactNs: report.timings.compactNs, prettyNs: report.timings.prettyNs,
  pairedSpeedup: report.timings.pairedSpeedup}, payloads, readCounts, counterexamples: report.counterexamples }, null, 2));
