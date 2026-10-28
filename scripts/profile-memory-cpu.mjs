// Local memory/CPU profiling only. No network, no DB, no production data.
//
// Measures two things the Performance Checklist marks Unverified/Partial:
//   1. Heap growth (process.memoryUsage()) for a tree fixture sized near the
//      documented TREE_LIMIT (src/lib/tree/model.js) and for a value-store
//      encode/decode round trip (src/lib/valuestore.js) on a large payload.
//   2. CPU self-cost (perf_hooks performance.now()) of the three operations
//      the checklist already names as CPU candidates — synchronous level-9
//      gzip, hashing (src/lib/hash.js), and content canonicalization
//      (src/lib/content.js) — on an identical workload, ranked by measured
//      time.
//
// This script only imports and calls existing exports; it does not modify
// product source. Source hashes are checked before and after the run so a
// concurrent edit (a sibling agent, or this script itself misbehaving) is
// caught rather than silently producing numbers for different code.
//
// Run: node --expose-gc scripts/profile-memory-cpu.mjs [outDir]
// Without --expose-gc, global.gc() is unavailable and heap deltas between
// phases are noisier (uncollected garbage from an earlier phase can bleed
// into the next one's "before" snapshot) — the report says so either way.

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { cpus, platform, arch, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { project, normaliseAdf } from '../src/lib/content.js';
import { diffTree } from '../src/lib/tree/diff.js';
import { TREE_LIMIT, logicalNodeId } from '../src/lib/tree/model.js';
import { encodeValue, decodeValue, CHUNK_CHARS } from '../src/lib/valuestore.js';
import { canonical, sha256Hex } from '../src/lib/hash.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(process.argv[2] ?? `${root}/docs/acceptance/2026-10-29-memory-cpu-profile`);
await mkdir(out, { recursive: true });

const sources = ['src/lib/content.js', 'src/lib/tree/diff.js', 'src/lib/tree/model.js',
  'src/lib/valuestore.js', 'src/lib/hash.js'];
async function hashes() {
  return Object.fromEntries(await Promise.all(sources.map(async p => [p,
    createHash('sha256').update(await readFile(resolve(root, p))).digest('hex')])));
}
const before = await hashes();

const gcAvailable = typeof globalThis.gc === 'function';
if (!gcAvailable) {
  console.error('WARNING: --expose-gc was not passed. Re-run as `node --expose-gc '
    + 'scripts/profile-memory-cpu.mjs` for forced-GC isolation between phases. Continuing '
    + 'without it: the heap deltas below mix each phase\'s own allocation with whatever '
    + 'uncollected garbage happened to still be around from the phase before it.');
}
function settle() { if (gcAvailable) { globalThis.gc(); globalThis.gc(); } }
function mib(bytes) { return Math.round(bytes / 1024 / 1024 * 100) / 100; }

const memoryPhases = [];
function phase(name, fn) {
  settle();
  const beforeMem = process.memoryUsage();
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  settle();
  const afterMem = process.memoryUsage();
  memoryPhases.push({
    name,
    ms: Math.round(ms * 100) / 100,
    heapUsedBeforeMiB: mib(beforeMem.heapUsed),
    heapUsedAfterMiB: mib(afterMem.heapUsed),
    heapUsedDeltaMiB: mib(afterMem.heapUsed - beforeMem.heapUsed),
    rssBeforeMiB: mib(beforeMem.rss),
    rssAfterMiB: mib(afterMem.rss),
    rssDeltaMiB: mib(afterMem.rss - beforeMem.rss)
  });
  console.error(`[memory] ${name}: ${Math.round(ms)}ms, heapUsed delta ${mib(afterMem.heapUsed - beforeMem.heapUsed)} MiB, rss delta ${mib(afterMem.rss - beforeMem.rss)} MiB`);
  return result;
}

// ─── Representative content ──────────────────────────────────────────────
// Not a real tenant document. Structured, deterministic ADF shaped like the
// paragraphs/sentences a reviewer actually writes, sized to be representative
// rather than to flatter either the gzip or the no-gzip case.
function buildAdfDescription(paragraphs, sentencesPerParagraph) {
  const content = [];
  for (let p = 0; p < paragraphs; p++) {
    const run = [];
    for (let s = 0; s < sentencesPerParagraph; s++) {
      run.push({ type: 'text', text: `Paragraph ${p} sentence ${s}: the quick brown fox jumps over the lazy dog while auditors review controlled field ${p}-${s} for drift before approval.` });
    }
    content.push({ type: 'paragraph', localId: `p${p}`, content: run });
  }
  return { type: 'doc', version: 1, content };
}

// Per-node description: small, like most real fields — the 500-node fixture
// below uses this, not the large one, matching "the overwhelming majority of
// fields are a single row" (src/lib/valuestore.js comment on CHUNK_CHARS).
const SMALL_DESCRIPTION = buildAdfDescription(8, 4);
// One large outlier value, sized to cross CHUNK_CHARS and force decodeValue's
// multi-row reassembly path rather than the common single-row path.
const LARGE_DESCRIPTION = buildAdfDescription(3000, 10);

function controlledFieldsFixture() {
  return [
    { field_id: 'summary', field_kind: 'TEXT', store_values: true },
    { field_id: 'description', field_kind: 'ADF', store_values: true },
    { field_id: 'labels', field_kind: 'MULTI', store_values: true },
    { field_id: 'issuelinks', field_kind: 'LINKS', store_values: true },
    { field_id: 'subtasks', field_kind: 'SUBTASKS', store_values: true },
    { field_id: 'customfield_10050', field_kind: 'SCALAR', store_values: true },
    { field_id: 'customfield_10051', field_kind: 'SCALAR', store_values: true },
    { field_id: 'customfield_10052', field_kind: 'SCALAR', store_values: true },
    { field_id: 'customfield_10053', field_kind: 'MULTI', store_values: true },
    { field_id: 'customfield_10054', field_kind: 'TEXT', store_values: true }
  ];
}
const CONTROLLED_FIELDS = controlledFieldsFixture();

function issueFieldsFor(n) {
  return {
    summary: `Work item ${n}: representative summary text for profiling, long enough to be realistic.`,
    description: SMALL_DESCRIPTION,
    labels: ['alpha', 'beta', `tag-${n % 7}`],
    issuelinks: [{ type: { id: '10001' }, outwardIssue: { id: String(n + 1000) } }],
    subtasks: n % 5 === 0 ? [{ id: String(n + 5000) }] : [],
    customfield_10050: { value: n % 2 === 0 ? 'High' : 'Medium' },
    customfield_10051: { value: 'Open' },
    customfield_10052: n,
    customfield_10053: [`env-${n % 3}`, 'shared'],
    customfield_10054: `Free text custom field body for node ${n}.`
  };
}

// ─── Memory phase 1: build a tree fixture sized at TREE_LIMIT ─────────────
const nodeCount = TREE_LIMIT; // 500 — src/lib/tree/model.js
assert.equal(nodeCount, 500, 'TREE_LIMIT moved; this script is now measuring the wrong size');

let builtTree;
phase(`build ${nodeCount}-node tree fixture (= TREE_LIMIT), 10 controlled fields each`, () => {
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      logicalNodeId: logicalNodeId(i + 1),
      parentLogicalId: i === 0 ? null : logicalNodeId(Math.floor((i - 1) / 2) + 1),
      issueFields: issueFieldsFor(i)
    });
  }
  builtTree = nodes;
  return nodes;
});

// ─── Memory phase 2: project() every node — the real per-node content-
// canonicalization + digesting pass a tree capture runs ─────────────────
let projected;
phase(`project() all ${nodeCount} nodes' controlled fields (normalise + digest, content.js)`, () => {
  projected = builtTree.map(n => ({
    logicalNodeId: n.logicalNodeId,
    parentLogicalId: n.parentLogicalId,
    ...project(n.issueFields, CONTROLLED_FIELDS)
  }));
  return projected;
});

// ─── Memory phase 3: diffTree over two full-size projected trees ─────────
function asDiffNode(p) { return { logicalNodeId: p.logicalNodeId, parentLogicalId: p.parentLogicalId, digests: p.digests }; }
let diffResult;
phase(`diffTree() over two ${nodeCount}-node projected trees (10% of nodes changed)`, () => {
  const baselineNodes = projected.map(asDiffNode);
  const currentNodes = projected.map((p, i) => i % 10 === 0
    ? { ...asDiffNode(p), digests: { ...p.digests, summary: `${p.digests.summary}-changed` } }
    : asDiffNode(p));
  diffResult = diffTree({ baselineTree: { nodes: baselineNodes }, currentTree: { nodes: currentNodes }, controlledFields: CONTROLLED_FIELDS });
  return diffResult;
});
assert.equal(diffResult.changes.filter(c => c.kind === 'FIELD_CHANGED').length, Math.ceil(nodeCount / 10),
  'diff fixture sanity check failed — the drift count is not what the fixture was built to produce');

// ─── Memory phase 4/5: value-store encode/decode of one large payload ────
const largeRawBytes = Buffer.byteLength(JSON.stringify(LARGE_DESCRIPTION));
let encoded;
phase(`encodeValue() on one large ADF-like value (${largeRawBytes} raw bytes)`, () => {
  encoded = encodeValue(LARGE_DESCRIPTION);
  return encoded;
});
assert(encoded.chunks.length > 1, 'large fixture did not exceed CHUNK_CHARS — grow it so the multi-chunk path is actually exercised');

let decoded;
phase(`decodeValue() reassembling ${encoded.chunks.length} chunks`, () => {
  const rows = encoded.chunks.map((data, seq) => ({ seq, encoding: encoded.encoding, data, raw_bytes: encoded.rawBytes }));
  decoded = decodeValue(rows);
  return decoded;
});
assert.deepEqual(decoded.value, LARGE_DESCRIPTION, 'encode/decode round trip did not reproduce the original value');

// ─── CPU: rank the three named candidates on an identical workload ───────
// Same input, same iteration count, same machine moment — the only thing
// that differs between the three timed functions is the function itself.
const cpuSamplePlain = JSON.stringify(SMALL_DESCRIPTION);
const cpuSampleBytes = Buffer.from(cpuSamplePlain, 'utf8');
const ITERATIONS = 2000;
const TRIALS = 7;
const WARMUP = 100;

let sink = 0; // forces the result to be used so nothing is optimized away as dead code
function timeOp(fn) {
  for (let i = 0; i < WARMUP; i++) sink += fn();
  const usPerOp = [];
  for (let trial = 0; trial < TRIALS; trial++) {
    const t0 = performance.now();
    for (let i = 0; i < ITERATIONS; i++) sink += fn();
    const ms = performance.now() - t0;
    usPerOp.push((ms * 1000) / ITERATIONS);
  }
  const sorted = [...usPerOp].sort((a, b) => a - b);
  return {
    medianUs: Math.round(sorted[Math.floor(sorted.length / 2)] * 1000) / 1000,
    minUs: Math.round(sorted[0] * 1000) / 1000,
    maxUs: Math.round(sorted[sorted.length - 1] * 1000) / 1000,
    usPerOp: usPerOp.map(v => Math.round(v * 1000) / 1000)
  };
}

const cpuResults = {
  gzipLevel9: timeOp(() => gzipSync(cpuSampleBytes, { level: 9 }).length),
  hashingSha256: timeOp(() => sha256Hex(cpuSamplePlain).length),
  contentCanonicalizationNormaliseAdf: timeOp(() => JSON.stringify(normaliseAdf(SMALL_DESCRIPTION)).length)
};
// Context only, not part of the three-way ranking the checklist asks for:
// hash.js's own generic canonical() (sortDeep + JSON.stringify), which
// content.js's digest computation also calls on top of normaliseAdf.
const contextResults = {
  genericCanonicalHashJs: timeOp(() => canonical(SMALL_DESCRIPTION).length),
  fullProjectOneNode: timeOp(() => Object.keys(project(issueFieldsFor(1), CONTROLLED_FIELDS).digests).length)
};

const ranked = Object.entries(cpuResults)
  .sort((a, b) => b[1].medianUs - a[1].medianUs)
  .map(([name, r], i) => ({ rank: i + 1, name, medianUs: r.medianUs }));

console.error('\n[cpu] ranked by median self-time (descending), same input, same iteration count:');
for (const r of ranked) console.error(`  ${r.rank}. ${r.name}: ${r.medianUs} us/op`);

// ─── Assemble and write the report ────────────────────────────────────────
const report = {
  measuredAtUtc: new Date().toISOString(),
  source: {
    head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    sha256: before
  },
  environment: {
    node: process.version, platform: platform(), arch: arch(),
    cpu: cpus()[0]?.model, cpuCount: cpus().length,
    totalMemMiB: mib(totalmem()),
    gcExposed: gcAvailable
  },
  treeFixture: {
    treeLimit: TREE_LIMIT, nodeCount, controlledFieldCount: CONTROLLED_FIELDS.length,
    perNodeDescriptionParagraphs: 8, perNodeDescriptionSentencesPerParagraph: 4
  },
  valueStoreFixture: {
    largeDescriptionParagraphs: 3000, largeDescriptionSentencesPerParagraph: 10,
    largeRawBytes, chunkCharsThreshold: CHUNK_CHARS,
    encodedChunkCount: encoded.chunks.length, encodedEncoding: encoded.encoding,
    encodedRawBytesField: encoded.rawBytes,
    totalBase64Chars: encoded.chunks.reduce((s, c) => s + c.length, 0)
  },
  memoryPhases,
  cpu: {
    methodology: 'perf_hooks performance.now(); 100 warmup calls then 7 trials of 2000 iterations each; reported value is the median of the 7 per-iteration-averaged trial times, in microseconds per call',
    iterationsPerTrial: ITERATIONS, trials: TRIALS, warmup: WARMUP,
    sampleInputBytes: cpuSampleBytes.length,
    results: cpuResults,
    context: contextResults,
    rankedByMedianUsDescending: ranked,
    sink
  }
};
await writeFile(resolve(out, 'results.json'), JSON.stringify(report, null, 2) + '\n');

const after = await hashes();
assert.deepEqual(after, before, 'Measured source changed while this script was running — numbers above are not trustworthy, re-run');

console.log(JSON.stringify({ memoryPhases: report.memoryPhases, cpu: { results: cpuResults, rankedByMedianUsDescending: ranked } }, null, 2));
console.error(`\nRaw results written to ${resolve(out, 'results.json')}`);
