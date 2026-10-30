# Performance checklist

Comprehensive performance optimization checklist. Covers database optimization, caching, code performance, asset optimization, and load testing.

> **Initial assessment: 28 October 2026; all previously checked rows re-audited 29 October 2026.** Current audit scope: VAtlassian source at commit `a87375aeb4431d81089537be8fe4418f6a505cc9`, full local backend/UI tests, production build and scoped memory/CPU measurements (E29). This assesses the supplied checklist; it does not implement every template optimization. No deployment, tenant mutation, production load test or Developer Console inspection was performed.
>
> This workspace file is the current audited checklist. `/Users/sriharsha/Downloads/Perfromance.md` is an earlier copy and was not synchronized by this audit. `docs/DATABASE-CHECKLIST.md` is preserved and is not treated as independent proof. Document text was treated as checklist content, not authorization to run additional operational actions.

**Status key:** `[x] Verified` = directly supported in the stated local scope; `[ ] Partial` = some controls/evidence exist; `[ ] Open` = a gap was found in reviewed code/configuration; `[ ] Unverified` = measurement or operational evidence is missing; `[ ] Managed` = platform responsibility, not independently accepted. Only Verified items are checked. Managed rows are assessed, not silently counted as passes. “Not found” refers to the reviewed workspace and supplied evidence, not proof that an external team has never configured it.

**Assessment totals:** Verified: **49**; Partial: **71**; Open: **32**; Unverified: **56**; Managed: **34**. All 242 applicable rows are assessed; 41 inapplicable template rows were removed earlier. These are checklist-row counts, not independent capabilities or a performance-readiness score. Of the five rows E29 had downgraded for lacking a production consumer, the four cache rows are Verified again in a narrower scope: one `[CACHE_TELEMETRY]` log line per invocation (E30). Slow query alert configured stays Partial: the alert is a log line with no route or recipient. The [50-row audit](acceptance/2026-10-29-verified-50-audit.md) records a source reference, justification and limitation for each decision, with fresh backend/UI tests, build, profiling and source-hash evidence (E29). Earlier E1–E28 results are historical; their test counts and timings are not fresh results of this audit. No deployed speedup, tenant alert delivery or live performance-readiness pass is asserted.

## Table of contents

1. [Database Performance](#database-performance)
2. [Query Optimization](#query-optimization)
3. [Caching Strategy](#caching-strategy)
4. [Code Performance](#code-performance)
5. [Asset Optimization](#asset-optimization)
6. [API Performance](#api-performance)
7. [Frontend Performance](#frontend-performance)
8. [Infrastructure Performance](#infrastructure-performance)
9. [Monitoring & Measurement](#monitoring--measurement)
10. [Load Testing](#load-testing)
11. [Performance Regression Prevention](#performance-regression-prevention)
12. [Audited Performance Numbers](#audited-performance-numbers)
13. [Performance changes verified locally](#performance-changes-verified-locally)
14. [References](#references)
15. [Evidence Register](#evidence-register)
16. [Fresh Local Verification](#fresh-local-verification)
17. [Known Bounds and Remaining Work](#known-bounds-and-remaining-work)

---

## Database performance

### Connection management

- [ ] Connection pooling configured. **Managed**: Forge SQL is accessed through its SDK; no application-owned connection pool is configured. E1.
- [ ] Connection pool size optimized. **Managed**: No pool-size setting exists in the app; platform capacity still needs tenant measurement. E1.
- [ ] Idle timeout configured. **Managed**: No application-owned SQL idle timeout; SDK access is used. E1.
- [ ] Max connection limits set. **Managed**: No application connection limit is declared; service quotas are separate from a tuned pool. E1.
- [ ] Database connection errors monitored. **Partial**: SQL failures produce redacted error and statement summaries; no connection-specific alert or live review was verified. E1.
- [ ] Slow connection acquisition monitored. **Managed**: Connection acquisition is not instrumented separately by the app. E1.

### Query performance

- [x] Slow query log enabled. **Verified**: `executeQuery` now measures and logs every successful and failed query's duration. Previously it logged only failures. E1, E27.
- [ ] Query execution plans reviewed. **Unverified**: No execution-plan output for representative tenant queries was found. E1, E2.
- [ ] Long-running queries identified. **Unverified**: No live query-duration sample or ranked slow-query report was supplied. E1, E6.
- [ ] Query timeouts configured. **Managed**: Forge enforces SQL query timeouts; the app does not tune them. See the platform reference in E1.
- [ ] Query complexity assessed. **Partial**: Bounded reads and batch sizes show local complexity controls; no complete query-cost inventory or plan review. E2, E3.
- [x] Inefficient queries optimized. **Verified**: Tree capture uses multi-row inserts; the 120-node fixture verifies three node inserts and three value inserts. This proves query-count reduction only. E3.
- [ ] Full table scans minimized. **Partial**: Lookup indexes and bounded queries exist; unbounded project listing and plan verification remain to review. E2, E10.

### Indexing strategy

- [ ] Index strategy documented. **Partial**: Index definitions are recorded in migrations; a measured query-to-index rationale is incomplete. E2.
- [ ] Indexed columns chosen wisely. **Partial**: Indexes include issue, project, actor and state/time lookup patterns; suitability under real data is unverified. E2.
- [ ] Index cardinality analyzed. **Unverified**: No live cardinality or selectivity measurements were found. E2.
- [ ] Composite indexes used appropriately. **Partial**: Composite lookup indexes exist, including approval and reviewer/project/state paths; actual plan usage is unverified. E2.
- [ ] Unused indexes removed. **Unverified**: No workload-based unused-index report or removal evidence was found. E2.
- [ ] Index size monitored. **Unverified**: No index-size measurements or growth trend were supplied. E2.
- [ ] Index fragmentation addressed. **Managed**: Physical index maintenance belongs to the hosted database; no maintenance result was inspected. E1.
- [ ] Index rebuild scheduled. **Managed**: No app-managed rebuild schedule; do not infer a verified platform schedule. E1.

### Database optimization

- [ ] Database statistics updated. **Managed**: Database statistics maintenance is outside the app; no statistics freshness evidence was inspected. E1.
- [ ] Query optimizer configured. **Managed**: No application-owned database optimizer configuration. E1.
- [x] Denormalization considered. **Verified**: Stored field digests/tree counts and test source projections demonstrate deliberate derived representations. Their presence is not a latency benchmark. E2, E3, E10.
- [ ] Archive old data strategy. **Partial**: Retention and sealing policy exist; retained baseline values are deliberately not pruned without archival coverage. No live archival acceptance was run. E9.
- [ ] Database parameter tuning done. **Managed**: Database server parameters are not configured by this application. E1.

---

## Query optimization

### SELECT query optimization

- [ ] SELECT * avoided (only needed columns). **Open**: SELECT * remains in test-management stores, planning, reports, retest and source-link reads. E10.
- [ ] JOIN complexity minimized. **Partial**: Some lookups use simple joins or batched reads; no complete join-cost assessment. E2, E10.
- [ ] JOIN order optimized. **Unverified**: No execution plans establish join order or optimizer decisions. E2, E10.
- [ ] Subqueries optimized. **Unverified**: Report retention includes a NOT IN subquery; no representative plan or timing review. E4.
- [ ] DISTINCT used only when necessary. **Partial**: DISTINCT is used for unique fields/scopes and capture verification; necessity was not audited for every query. E2, E3.
- [ ] GROUP BY optimized. **Unverified**: GROUP BY exists in capture, drift and child-baseline queries; no plan/timing evidence. E2, E3.

### N+1 query prevention

- [ ] N+1 queries identified and eliminated. **Partial**: Queue and test-management readers batch related entities; this is not proof that every N+1 path is eliminated. E5, E10.
- [x] Eager loading used (includes, joins). **Verified**: Queue hydration loads related baseline data in bulk; store readers also use joins/IN queries. E5, E10.
- [x] Batch loading implemented. **Verified**: Batch readers exist for signatures, bugs, versions and queue baseline data. E5, E10.
- [ ] Query log analyzed for duplicates. **Open**: No successful SQL query stream or duplicate-query analysis was found. Failure summaries are insufficient. E1.
- [x] Lazy loading vs. eager loading trade-offs considered. **Verified**: The panel summary explicitly excludes heavy evidence/tree readers; detailed evidence loads separately, enforced by a passing contract test. E5.

### INSERT/UPDATE/DELETE optimization

- [x] Bulk operations used for multiple records. **Verified**: Tree capture writes nodes and value chunks in multi-row statements. E3.
- [ ] Batch insert/update/delete implemented. **Partial**: Tree inserts are batched; not every update/delete path has been assessed for statement count and payload size. E3, E10.
- [ ] Unnecessary writes eliminated. **Partial**: Idempotent retries and completed-action journals avoid some repeat work; no global unnecessary-write audit. E8.
- [ ] Update-only-changed-fields pattern used. **Partial**: Restore planning targets changed content; full SQL config/report replacements still exist. E4, E8.
- [ ] Lock contention minimized. **Partial**: Optimistic claims, finite leases and keyed queue concurrency reduce conflicts; no live contention measurement. E8.

### Stored procedures & functions

- [ ] Function performance assessed. **Partial**: Resolver durations are logged and selected hot paths have structural tests; no comprehensive function profiling. E5, E6.
- [x] Recursive functions avoided. **Verified, scoped to content/diff**: The one recursive content/diff helper, `normaliseAdf` (`src/lib/content.js`), is now an explicit iterative stack walk, proven byte-identical to the original on 60 fixtures and workload-profiled. `src/lib/tree/diff.js` was never recursive. `src/lib/hash.js#sortDeep` remains recursive and is a general hashing utility outside this scope. This is not a whole-codebase claim. E7, E28.
- [ ] Trigger impact on performance evaluated. **Partial**: Jira event handlers and scheduled jobs have some bounds/retries; no measured trigger-overhead study. These are not SQL triggers. E8.

---

## Caching strategy

### Application caching

- [x] Caching layer implemented (Redis/Memcached). **Verified**: A request-scoped Map/AsyncLocalStorage cache and SQL-backed AI report cache are implemented. Redis/Memcached is not used. E4.
- [x] Cache invalidation strategy documented. **Verified**: Request lifetime and evidence/model-based report keys are documented beside their implementations. E4.
- [ ] Cache TTLs optimized. **Partial**: Request entries expire with their invocation; reports use evidence keys and retention. No measured TTL tuning was done. E4, E9.
- [x] Cache bust strategy implemented. **Verified**: A new invocation has a fresh memo scope; changed report evidence/model creates a new key. This is not HTTP cache invalidation. E4.
- [ ] Cache stampede prevention implemented. **Partial**: In-flight Promises coalesce within one invocation; cross-invocation report generation is not shown to have a distributed single-flight lock. E4.
- [ ] Cache consistency maintained. **Partial**: Invocation isolation and failure eviction pass local assertions; same-invocation read-after-write behavior and all consumers still need a full audit. E4.

### Cache types

- [x] Query result caching implemented. **Verified**: Config/control SQL results are memoized within a request. E4.
- [x] Object/entity caching implemented. **Verified**: Decoded configuration and report objects are cached in the relevant read paths. E4.
- [x] Configuration data caching. **Verified**: getConfig and projectConfig use request-scoped memoization. E4.
- [ ] Reference data caching. **Partial**: Controlled fields, transitions and some test-project metadata are memoized; reference-cache coverage has not been audited end to end. E4, E10.

### Cache monitoring

- [x] Cache hit rate monitored. **Verified, logged per invocation**: `withRequestCache` logs one `[CACHE_TELEMETRY]` line when each entry point's scope settles (resolvers labelled `resolver:functionKey` by `wrapWithHarness`; triggers, jobs and the gate unlabelled), carrying hits, misses and `hitRate = hits / (hits + misses)`. The log is the only consumer: no aggregation, dashboard or threshold. E4, E26, E30.
- [x] Cache miss rate analyzed. **Verified, cause split only**: each miss is counted as `coldMisses` (first read in the scope) or `postEvictionMisses` (re-read after a rejected promise was evicted) and logged with `missRate` on the same `[CACHE_TELEMETRY]` line. No key sampling or automated diagnosis; deeper analysis is left to log queries. E4, E26, E30.
- [x] Cache eviction rate tracked. **Verified, rejection evictions**: The cache counts its only production eviction, removal of a rejected in-flight promise, and logs it as `evictions` and `evictionRate = evictions / (hits + misses)` on the same `[CACHE_TELEMETRY]` line. E4, E26, E30.
- [ ] Cache memory usage monitored. **Open**: No cache-entry count, memory measurement or size alert was found. E4.
- [ ] Cache performance alerts configured. **Open**: No cache-specific performance alert configuration was found. E4, E6.
- [ ] Slow cache operations identified. **Open**: No per-cache-operation latency measurement was found. E4.

### HTTP caching headers

- [ ] Cache-Control headers set appropriately. **Managed**: Forge hosts Custom UI resources; actual deployed Cache-Control headers were not inspected. E11.
- [ ] ETag headers implemented. **Unverified**: No app ETag implementation or deployed response capture was found. E11.
- [ ] Last-Modified headers set. **Unverified**: No app Last-Modified policy or deployed response capture was found. E11.
- [ ] Expires headers configured. **Unverified**: No app Expires policy or deployed response capture was found. E11.
- [ ] Public vs. private caching configured. **Unverified**: No deployed public/private cache-policy review was performed; sensitive resolver data needs separate treatment from static assets. E11.
- [ ] Conditional requests handled (304 Not Modified). **Unverified**: No conditional GET/304 test or deployed response evidence was supplied. E11.
- [ ] Cache validator freshness optimized. **Unverified**: No freshness/validator tuning measurements were found. E11.

### CDN configuration

- [ ] CDN enabled for static assets. **Managed**: Static resources are declared for Forge hosting; deployed CDN behavior was not independently captured. E11.
- [ ] CDN cache keys configured. **Managed**: No app-owned CDN cache-key configuration is declared. E11.
- [ ] CDN cache TTLs optimized. **Managed**: No app-owned CDN TTL configuration or measured validation. E11.
- [ ] CDN compression enabled. **Unverified**: Build gzip estimates do not prove CDN transfer compression; inspect deployed Content-Encoding. E11, E12.
- [ ] CDN geographic distribution considered. **Managed**: Hosting distribution is controlled by the platform; no regional latency study was run. E11.
- [ ] CDN purge strategy documented. **Partial**: Build assets use content-hashed filenames; no operational CDN purge runbook was found. E12.
- [ ] CDN performance monitored. **Unverified**: No CDN timing dashboard or response sample was inspected. E11.

---

## Code performance

### Algorithm optimization

- [ ] Algorithm complexity analyzed (Big O). **Partial**: Query counts, batching and collection caps are reasoned about locally; no complete Big O inventory. E3, E7.
- [ ] Inefficient loops identified. **Partial**: The expensive per-node capture-write pattern has a regression test; no whole-program loop profile. E3.
- [ ] Nested loop complexity reduced. **Partial**: Some fan-out is batched and maps replace repeated lookup work; no global nested-loop audit. E3, E5, E7.
- [ ] Sorting algorithms optimized. **Unverified**: Canonical/report-key sorting exists, but no sort workload benchmark was supplied. E4, E7.
- [ ] Search algorithms optimized. **Partial**: Map/Set and indexed lookups exist; no comparative search benchmark. E2, E5, E7.
- [x] Data structure choice justified. **Verified**: Queue hydration uses maps and tree traversal uses a visited set for identity lookup and cycle detection. E5, E7.
- [x] Recursive functions evaluated. **Verified**: The original recursive `normaliseAdf` confirmed to overflow the call stack around depth 2,000–3,000; the new iterative version verified correct at depth 10,000, plus CPU-ranked against the other named candidates below. E7, E28.

### Memory optimization

- [x] Memory profiling done. **Verified, scoped**: `scripts/profile-memory-cpu.mjs` records `process.memoryUsage()` heapUsed/rss deltas per phase for a `TREE_LIMIT`-sized (500-node) tree build/project/diff and a large value-store encode/decode round trip; raw numbers retained in `docs/acceptance/2026-10-29-memory-cpu-profile/results.json`. This is allocation/retained-memory delta profiling, not a V8 `.heapsnapshot` with retainer graphs. E7, E28.
- [ ] Memory leaks prevented. **Partial**: Caches are invocation-scoped and UI effects clean up some timers; no sustained-run heap evidence proves leak freedom. E4, E7.
- [ ] Large object allocation minimized. **Partial**: File and tree limits exist, but vault reads and hashing still materialize whole buffers. E7.
- [ ] String concatenation optimized. **Unverified**: No string-allocation or concatenation profile was found. E7.
- [x] Collection sizes limited. **Verified**: TREE_LIMIT is 500; vault files are capped at 250 MiB and download ranges at 1 MiB. These are limits, not tested capacity. E7.
- [x] Lazy initialization used. **Verified**: Screens and job modules use lazy imports; Object Store setup is loaded on demand. E7, E8, E12.
- [ ] Object reuse patterns implemented. **Partial**: Memoized objects and content-addressed vaulted bytes are reused; no general allocation-reuse assessment. E4, E7.
- [ ] Garbage collection tuning considered. **Managed**: Node runtime GC is platform-controlled; no app GC tuning evidence. E11.

### Concurrency & parallelization

- [x] CPU-intensive operations identified. **Verified, local candidates only**: Fresh 100-warmup, 7×2000-call trials on a 5,638-byte fixture rank gzip level 9 ≈18.8 µs/op, `JSON.stringify(normaliseAdf(...))` ≈9.1 µs/op, and `sha256Hex` ≈2.6 µs/op. The normalization measurement includes serialization and is not pure helper self-time. These selected microbenchmarks do not identify deployed hot spots. E7, E28, E29.
- [x] Parallelization opportunities found. **Verified**: Independent reads use Promise.all and several Jira readers use bounded batches. E3, E5, E8.
- [ ] Deadlock prevention implemented. **Partial**: Finite leases and durable CAS/journal operations exist; no live deadlock/contention study was performed. E8.
- [ ] Race condition prevention. **Partial**: Compare-and-swap claims, version guards and per-issue queue concurrency exist; this is not proof of all races eliminated. E8.
- [ ] Lock contention minimized. **Partial**: Per-issue serialization and optimistic claims are present; contention under representative concurrency is unmeasured. E8.
- [x] Async operations used appropriately. **Verified**: SDK/network calls are asynchronous and independent reads are parallelized in selected paths. E3, E5, E8.

### Code-level optimization

- [x] Hot path code optimized. **Verified**: The panel summary avoids tree/changelog/editmeta/value readers, with a passing boundary test. E5.
- [x] Function call overhead minimized. **Verified**: Selected direct loops and single-row branches remove callbacks and intermediate arrays. Tests establish output correctness; function-level speed ratios are separately scoped in E20. E7, E16, E20.
- [x] Loop unrolling considered. **Verified**: Both unrolled paths were evaluated. The supplied rigorous audit reports only 1.25–1.28x for batch parameter building (about 0.098 µs saved) and 0.95–0.98x for multi-part hashing (regression/noise). This verifies consideration and correctness, not a worthwhile runtime improvement. E3, E16, E20.
- [x] Inlining opportunities identified. **Verified, selected helpers**: `isStructuralField` fast-paths known strings and `logicalNodeId` directly constructs the deterministic one-key representation. Correctness tests compare identity hashes against canonical serialization, including quoted/newline input. `digestsEquivalent` uses caching, which is a separate technique and does not prove an inlining speedup. E7, E16, E29.
- [x] Compiler optimizations enabled. **Verified**: The production TypeScript/Vite build succeeds with default optimization and minification enabled. E12.
- [x] Unnecessary type conversions removed. **Verified**: Removed redundant string-to-Buffer conversions in sha256Hex (using native UTF-8 string update), eliminated redundant Buffer.from wrapping in child baseline storage, and optimized toBinaryParam/fromBinaryColumn to accept existing formats without re-encoding. E1, E7, E16.
- [x] String allocation minimized. **Verified**: Selected branches avoid slice/callback/intermediate-array work, reuse batch placeholders and omit explicit intermediate Buffers. Source inspection and correctness tests establish these code changes; no heap profile or zero-allocation guarantee is claimed. E3, E16, E20.

---

## Asset optimization

### JavaScript optimization

- [x] JavaScript minified. **Verified**: Fresh production output contains minified JavaScript. E12.
- [ ] JavaScript bundled efficiently. **Partial**: Lazy chunks are generated, but the shared ui chunk is 777.77 kB (210.98 kB gzip estimate) and triggers the build warning. E12.
- [ ] Unused JavaScript removed. **Partial**: Bundler dead-code elimination is enabled; no dependency/unused-code coverage audit proves all unused JavaScript removed. E12.
- [x] JavaScript size measured. **Verified**: Fresh build reports per-chunk raw and gzip-estimated sizes; see validation below. E12.
- [ ] Parse/compile time monitored. **Unverified**: No browser parse/compile-time trace was captured. E12.
- [ ] Execution time profiled. **Unverified**: No browser JavaScript execution profile was captured. E12.
- [x] Async/defer attributes used appropriately. **Verified**: HTML uses module scripts; production HTML includes generated modulepreload hints. E12.
- [x] Code splitting implemented. **Verified**: React.lazy screens and build chunk groups produce distinct panel/admin/review/test chunks. E12.
- [x] Tree shaking enabled. **Verified**: The production bundler's default dead-code elimination is enabled; this does not certify that every dependency is necessary. E12.

### CSS optimization

- [x] CSS minified. **Verified**: Fresh production output contains minified CSS. E12.
- [ ] CSS bundled efficiently. **Partial**: CSS is extracted into three assets; route-level usage and render cost have not been measured. E12.
- [ ] Unused CSS removed (PurgeCSS/UnCSS). **Open**: No PurgeCSS/UnCSS or equivalent verified unused-style audit was found. E12.
- [ ] CSS specificity optimized. **Unverified**: No systematic specificity audit was performed. E12.
- [ ] Selectors optimized for performance. **Unverified**: No selector matching/render-cost profile was supplied. E12.
- [ ] Media queries used appropriately. **Partial**: Responsive rules exist, including a 720px breakpoint; no device performance/visual run was performed. E12.
- [ ] Critical CSS inlined. **Open**: No critical-CSS extraction/inlining is configured in the reviewed build. E12.
- [ ] Fonts optimized (subsetting, loading strategy). **Partial**: System font stacks avoid packaged font downloads; custom font subsetting is inapplicable. E12.

### Image optimization

- [ ] Image sizes appropriate for display. **Unverified**: No rendered-image sizing audit was performed; local SVGs alone do not prove display sizing. E12.
- [ ] SVG images optimized. **Unverified**: Two public SVG files exist, but no SVG optimization pass or measured reduction was found. E12.
- [ ] Image sprites considered. **Partial**: An icons.svg symbol file exists; actual runtime use and network benefit were not established. E12.

### Font optimization

- [x] Fallback fonts specified. **Verified**: System sans-serif and monospace stacks include fallback families. E12.
- [x] Number of font families limited. **Verified**: The shared tokens define system sans-serif and monospace families. E12.

---

## API performance

> **Adversarial re-check, 28 October 2026.** Current claims were challenged against source and isolated counterexamples, not accepted from prior checkmarks. Pending-decision pagination, client backoff guidance and API versioning status were corrected. Compact ordinary summary JSON and bounded backend retries remain verified within their stated scope. See E18 and `docs/acceptance/2026-10-28-api-performance-adversarial-audit.md`. Other sections were not re-audited.

### API response optimization

- [ ] Response size minimized. **Partial**: Panel summaries are shaped explicitly, but both execution-summary entry points return the structured snapshot and prebuilt JSON/HTML downloads together (`src/usecases/testSummary.js`, `generate`/`read`). An isolated one-run fixture measured 8,424 bytes with downloads versus 1,893 for snapshot-only; this is duplicated representation, not production savings or permission to remove required exports. No response-byte acceptance budget or deployed measurement was established. E5, E10, E18.
- [ ] Response payload includes only needed data. **Partial**: Some resolvers project narrow results, while summary responses include several representations of the same record. No per-endpoint consumer/payload audit proves minimality. Store SELECT * and upstream Jira fields=*all affect internal I/O; neither alone proves which fields leave the resolver. E5, E10, E18.
- [x] JSON formatting optimized. **Verified**: The current ordinary summary JSON download is compact: an assertion against `renderExecutionSummary` confirms equality with JSON.stringify({ summaryId, digest, snapshot }) without indentation. Readable HTML intentionally retains formatted text. The registered diagnostic probe still pretty-prints its HTTP JSON (`src/jobs/probe.js`); its temporary comment does not prove it absent from deployments. This check covers the ordinary application summary JSON, not every HTTP response. The 41% figure in E17 is a historical fixture result, not independently reproduced by this audit. E15, E17, E18.
- [ ] Response compression enabled (gzip, brotli). **Managed**: Forge transports resolver/static responses; no deployed Content-Encoding evidence was captured. E11.
- [ ] Response streaming used for large data. **Partial**: Object Store ranges validate status, Content-Range and byte count; the evidence resolver/frontend also implement bounded range chunks (`src/usecases/testEvidence.js`, `frontend/src/testmgmt/EvidenceDownload.tsx`). These are repeated buffered chunk responses, not one continuously streamed HTTP response. Whole-object paths and browser-side file assembly still materialize buffers. Local range tests passed; no live streaming acceptance. E7, E18.
- [x] Pagination implemented. **Verified, fixed in this session**: The adversarial audit reproduced an unreachable 201st decision because `awaitingDecision` defaulted to `LIMIT 200` and returned `nextPageToken: null`. In `src/usecases/queue.js`, `decisionsFor` now fetches up to `DECISIONS_HARD_CAP` 2000 and flags `decisionsOverflow: true` if that limit is reached. `list` pages the oldest-first result in memory through an opaque composite token (`decodeToken`/`encodeToken`), preserving the client contract in `frontend/src/queue/QueueList.tsx:76`. It rebuilds the transition-exclusion set from the complete decision list on each call, so a decision cannot also appear as a transition. A follow-up security review found that the first index/offset cursor could skip rows when an earlier decision was resolved. The cursor now uses the last `(last_drift_at, issue_id)` shown. `awaitingDecision` adds an `issue_id ASC` tiebreaker, and each continuation compares fresh rows with that value. Regression cases cover 201 decisions across 3 pages without gaps, duplicates or leaks, and resolution of the earliest decision between page calls without skipping the next outstanding item. `test/queue.test.js` (18/18) and `npm test` (2181/2181) passed. Other report/decision readers still flag truncation without continuation. That separate gap affects report downloads rather than this approval worklist. E5, E10, E18, E19, E23.
- [ ] Field filtering available. **Partial**: Selected Jira adapters request explicit fields, including the approval queue. This is internal field selection; the reviewed resolver contracts do not offer a general client-selected field list. Fixed server projections and broader reads for drift correctness must be evaluated per endpoint. E5, E8, E18.
- [ ] Sparse fieldsets available. **Open**: No general client-selected sparse-fieldset contract was found in the reviewed resolver definitions or usecases. Internal field-selection and drift-scope fields are different controls. This is a scoped code-review finding, not proof about every external integration. E5, E10, E18.

### API rate & throttling

- [ ] API rate limiting configured. **Partial**: Restore, vault and link queues declare per-issue concurrency 1; queue issue hydration uses READ_CONCURRENCY=5. These cap simultaneous work within their stated scope, not arrivals per caller or across all issues. No application-wide admission limiter was found in reviewed resolver wrappers. Platform ceilings still apply; the earlier phrase unlimited distinct issues was too strong. E8, E18.
- [ ] Throttling strategy fair. **Unverified**: The per-issue concurrency keys above serialize work per issue but give no cross-user or cross-tenant fairness guarantee, and no fairness test or admission policy was found. E8.
- [ ] Rate limit error responses clear. **Partial**: Queue liveActions still omits non-OK candidate reads, including throttling, without an incomplete-result signal. The current shared wrappers now preserve supplied numeric status and retry timing, verified in nine fresh repetitions, but cannot restore metadata swallowed before an error is thrown. Permission filtering remains necessary. E8, E18, E22.
- [ ] Client backoff guidance provided. **Partial**: `respond`/`tmRespond` (`src/usecases/access.js`, `src/testmgmt/messages.js`) preserve supplied `status`/`retryAfterMs` fields in error envelopes. They do not fabricate metadata; the ordinary-error exact-shape assertion in `test/user-consent.test.js` still passes. Previously the shared frontend `assertResult` in `frontend/src/lib/result.ts` discarded the envelope when `result.error` appeared, throwing only `new Error(message)`. Its ~15 callers lost the retry metadata. It now throws `ResultError extends Error` with `reason`/`status`/`retryAfterMs` properties. Existing `instanceof Error` and `.message` handling remain valid, as checked by `npm run build:ui` and review of frontend `instanceof Error` catch sites. No UI consumes the fields to display a wait time or schedule a retry. That work must distinguish retryable reads from mutations to avoid unsafe replay. A security review found that the first `retryGuidance` version forwarded any integer `status`, including the 403/404 distinction that `testmgmt/jira.js`'s `json()` hides behind `NOT_FOUND`. This exposed whether an inaccessible issue existed. `retryGuidance` now forwards `status`/`retryAfterMs` only for transient 429/503 responses. Two new `test/user-consent.test.js` cases assert that 403/404 adds no `status` field while 429/503 still does. E8, E18, E22, E24, E25.
- [x] Exponential backoff recommended. **Verified**: Verified for bounded backend retries: actual restore and vault worker calls at retry counts 0–4 each returned 5, 10, 20, 40, 60-second delays, and existing exhaustion tests pass. Product-event retry/schema-pending tests also pass. This check does not imply client guidance, admission fairness, jitter or a measured live-delivery guarantee. E8, E18.

### API versioning & deprecation

- [ ] API versioning strategy clear. **Open**: No explicit resolver compatibility/versioning policy was found in the reviewed material: supported contracts, breaking-change handling and client support windows are unspecified. Ordered SQL migrations and versioned evidence are useful but do not establish a resolver API strategy. Version tokens in action names are not mandatory; an explicit compatibility strategy is the missing evidence. E2, E5, E18.
- [ ] Old API versions deprecated properly. **Partial**: The retired signature custom-field module remains registered with replacement instructions in manifest.yml. This is concrete compatibility/retirement handling for one surface, not an inventory or verified deprecation process for all resolver consumers. E11, E18.
- [ ] Deprecation timeline communicated. **Open**: No resolver sunset dates, supported-version window or deprecation calendar were found in the reviewed manifest and documentation. An instruction to replace a retired field does not communicate a deadline. E11, E18.
- [ ] Migration path documented. **Partial**: The manifest describes replacing the retired signature field and migrations record schema changes. A resolver-consumer migration guide and compatibility acceptance remain unverified. E2, E11, E18.
- [ ] Breaking changes minimized. **Partial**: The current readBaselineTree implementation contains tiered unknown-column fallback (`src/db/baselineTreeStore.js`, function readBaselineTree). That is a real schema-compatibility mechanism, not proof of compatibility across every resolver, store and installed version. The old source line references had drifted while files were edited. E1, E2, E18.

---


## Frontend performance

### Critical rendering path

- [ ] Critical resources identified. **Partial**: Entry/shared/route resources are visible in the build; no browser critical-path waterfall was captured. E12.
- [ ] Resource priority configured. **Partial**: Vite generates modulepreload links; no measured priority tuning for deployed Jira iframe loads. E12.
- [ ] Prefetch used for non-critical resources. **Open**: No explicit non-critical route prefetch policy was found. E12.
- [ ] Resource hints optimized. **Partial**: Default preload hints exist; no waterfall comparison establishes optimal hints. E12.
- [ ] Render-blocking resources minimized. **Partial**: Module scripts and lazy routes reduce initial work; shared CSS/UI cost still needs browser measurement. E12.
- [ ] First Contentful Paint (FCP) optimized. **Unverified**: No deployed FCP measurement or before/after result was supplied. E12.

### Core web vitals

- [ ] Largest Contentful Paint (LCP) < 2.5s. **Unverified**: No measured LCP distribution for Jira host/iframe; do not infer this from build duration. E12, E13.
- [ ] Cumulative Layout Shift (CLS) < 0.1. **Unverified**: No measured CLS distribution was supplied. E13.
- [ ] Core Web Vitals monitored. **Open**: No web-vitals/PerformanceObserver collection was found in the reviewed frontend. E12, E13.
- [ ] Performance metrics tracked over time. **Open**: No retained browser metric series or trend report was supplied. E6, E13.

### Page load optimization

- [ ] Page load time measured (real user monitoring). **Open**: No real-user page-load collection was found in the reviewed frontend. E12.
- [ ] Initial page load optimized. **Partial**: Lazy screens and fast summary/detail separation are implemented; actual warm/cold page timings remain unmeasured. E5, E12.
- [ ] Time to Interactive (TTI) optimized. **Unverified**: No deployed interactivity trace or test result was supplied. E12.
- [ ] Page speed test scores reviewed. **Unverified**: No PageSpeed/WebPageTest result was supplied for this app. E12.
- [ ] Lighthouse audit scores reviewed. **Unverified**: No current Lighthouse report was supplied or run in this assessment. E12.
- [ ] Performance budgets defined. **Partial**: The design sets warm summary p95 <= 2 s, cold target <= 5 s and feedback <= 100 ms; these are goals, not measured acceptance or CI budgets. E5.

---

## Infrastructure performance

### Server configuration

- [ ] Worker processes configured. **Managed**: Forge manages execution processes; the manifest declares consumer functions, not OS workers. E11.
- [ ] Buffer sizes optimized. **Managed**: No server/socket buffer tuning is exposed by app configuration. E11.
- [ ] Keepalive connections configured. **Managed**: No app-owned connection keepalive setting is declared. E11.
- [ ] Compression enabled. **Unverified**: Actual deployed transfer compression has not been inspected. Build gzip estimates are not server evidence. E11, E12.
- [ ] Caching headers configured. **Unverified**: Actual deployed cache headers have not been inspected. E11.
- [ ] Load balancing configured (if multiple servers). **Managed**: Platform execution/hosting is managed; no app load-balancer configuration or load result was inspected. E11.

### Database server

- [ ] Database server resources adequate. **Unverified**: No representative SQL workload, utilization/headroom sample or capacity result was supplied. E1.
- [ ] CPU utilization monitored. **Managed**: Database host CPU monitoring is outside this code; no tenant console evidence was inspected. E1.
- [ ] Memory utilization monitored. **Managed**: Database host memory monitoring is outside this code; no console evidence was inspected. E1.
- [ ] Disk I/O monitored. **Managed**: Database disk I/O telemetry is outside this code; no console evidence was inspected. E1.
- [ ] Database configuration tuned. **Managed**: No application-owned database server tuning settings. E1.
- [ ] Buffer pool size optimized. **Managed**: No app-owned database buffer-pool setting. E1.

### Application server

- [ ] Application server memory configured. **Partial**: Restore/vault workers declare 1024 MiB; other functions use platform defaults. No heap/headroom benchmark validates sizing. E7, E11.
- [ ] Heap size optimized. **Managed**: No explicit Node heap-size override or heap-sizing study. E11.
- [ ] Garbage collection tuned. **Managed**: No app GC configuration or profiling evidence. E11.
- [ ] Worker process count optimized. **Managed**: No OS worker count is configured; queue concurrency is a separate application control. E8, E11.
- [x] Timeout configurations reviewed. **Verified**: Restore/vault/link worker timeouts are declared at 600 s; scheduled sweeps and LLM calls have explicit budgets. This verifies reviewable bounds, not deadline success. E8, E11.

### Network infrastructure

- [ ] Bandwidth adequate. **Unverified**: No deployed transfer-throughput or bandwidth-headroom measurement was supplied. E11.
- [ ] Latency acceptable. **Unverified**: No live warm/cold/regional latency sample was collected. E5.
- [ ] Network hops minimized. **Partial**: Batching, request memoization and summary separation reduce round trips; deployed network-hop optimization was not measured. E3, E4, E5.
- [ ] Geographic distribution optimized. **Managed**: Platform hosting geography is not tuned in this app; no regional comparison was run. E11.
- [ ] CDN configured. **Managed**: Forge hosts the declared static resource; no separate CDN configuration/acceptance evidence. E11.
- [ ] Network monitoring enabled. **Unverified**: No network timing collection, network alert or deployed waterfall was inspected. E11, E12.

---

## Monitoring & measurement

### Performance metrics

- [ ] Response time tracked (p50, p95, p99). **Partial**: Resolver duration logs and harness P95 summaries exist; no p50/p99 service-level dashboard or retained live sample was verified. E6.
- [ ] Throughput measured (requests/second). **Open**: No requests-per-second time series or accepted throughput measurement was supplied. E6.
- [ ] Error rate monitored. **Partial**: Errors/outcomes are logged and summarized; no verified error-rate threshold/alert configuration. E1, E6.
- [ ] Request size tracked. **Open**: No general request-byte instrumentation was found in reviewed wrappers. E1, E6.
- [x] Response size tracked. **Verified, wrapped responses**: `wrapWithHarness` logs UTF-8 JSON byte length (`responseBytes`) for returned results in the four wrapped resolver modules. `harness:logAction`, thrown results and unwrapped endpoints are excluded; unserializable results log null. Tests confirm byte measurement and guarded serialization. This is not compressed wire size. E1, E6, E27, E29.
- [x] Database query time measured. **Verified**: Wall-clock duration is now measured around every `executeQuery` call and returned as `durationMs` plus logged. This measures elapsed time in the app per call. Live Forge tenant-console metrics remain uninspected. E1, E27.
- [x] Cache hit rate tracked. **Verified, logged per invocation**: the same `[CACHE_TELEMETRY]` line as Cache hit rate monitored (Caching Strategy); one instrumentation, referenced from both sections. E4, E26, E30.
- [ ] API latency monitored. **Partial**: Resolvers record duration; downstream Jira/SQL latency is not separated consistently and live monitoring was not verified. E1, E6.

### Performance dashboard

- [ ] Real-time performance dashboard created. **Partial**: A log watcher and CLI statistics exist; no dedicated real-time performance dashboard was supplied. E6.
- [ ] Key metrics displayed. **Partial**: CLI statistics show outcomes and duration summaries; no verified service-level metric dashboard. E6.
- [ ] Historical trends shown. **Open**: No retained performance trend dashboard was found. E6.
- [ ] Bottlenecks identified visually. **Open**: No flame-graph/waterfall/dashboard evidence of visual bottleneck identification was supplied. E6.
- [ ] Alerts configured for anomalies. **Open**: No performance anomaly rules, destinations or trigger test was supplied. Governance alerts are not performance alerting. E6.
- [ ] Performance reports generated. **Partial**: Harness can summarize supplied logs; this assessment supplies a local build/test report, not a live performance trend report. E6, E12.

### Profiling & analysis

- [ ] Application profiling done regularly. **Unverified**: No recurring profiler runs or profile archive was supplied. E6.
- [ ] Database profiling done. **Unverified**: No SQL trace/plan/profile capture from a live installation was supplied. E1.
- [ ] Memory profiling done. **Unverified**: No heap profile or allocation trace was supplied. E7.
- [ ] CPU profiling done. **Unverified**: No CPU profile was supplied. E7.
- [ ] I/O profiling done. **Unverified**: No disk/network I/O profile was supplied. E6, E7.
- [ ] Flame graphs analyzed. **Unverified**: No flame graph was supplied or generated. E6.
- [ ] Hot spots identified. **Partial**: Source and tests identify repeated SQL/tree work and the build flags a large shared UI chunk; no deployed profiler ranks hot spots. E3, E5, E12.

### Performance alerts

- [ ] High response time alert configured. **Open**: No latency alert threshold/destination/test evidence was supplied. E6.
- [ ] High error rate alert configured. **Open**: No error-rate alert threshold/destination/test evidence was supplied. E6.
- [ ] High CPU usage alert configured. **Managed**: Host CPU alerting is platform-owned; no customer-facing alert setup was verified. E11.
- [ ] High memory usage alert configured. **Managed**: Host memory alerting is platform-owned; no customer-facing alert setup was verified. E11.
- [ ] Cache eviction rate alert. **Open**: No cache-eviction alert exists in the reviewed cache code. E4.
- [ ] Slow query alert configured. **Partial**: `executeQuery` emits a structured, greppable `[SLOW_QUERY_ALERT]` warning for any query at or over 2,000 ms. No route, recipient or log-based alert rule is configured, and the Jira security-alert pipeline is deliberately not reused (E27). An in-process destination layer added on 29 October was removed the same day because nothing in production registered a destination (E30). E1, E27, E30.

---

## Load testing

### Load test preparation

- [ ] Load test plan documented. **Open**: Design documents call for scale/performance checks, but no executable workload plan with arrival rates, duration and acceptance thresholds was found. E5, E14.
- [ ] Test scenarios defined (happy path, edge cases). **Partial**: Functional/failure fixtures cover panel loading, tree capture and retries; they are not realistic arrival-rate load scenarios. E3, E5, E8.
- [ ] Expected load estimated. **Open**: No tenant count, concurrent-user model, issue volume or requests-per-second forecast was supplied. E14.
- [ ] Peak load identified. **Open**: No peak-hour concurrency or burst estimate was supplied. E14.
- [ ] Load test duration determined. **Open**: No load-test duration is defined by an executable test plan. E14.
- [ ] Ramp-up strategy planned. **Open**: No arrival-rate/ramp-up schedule was found. E14.
- [ ] Test data prepared. **Partial**: The 120-node fixture and functional test data exist; no representative tenant-scale load dataset was validated. E3, E14.

### Load test execution

- [ ] Baseline load test run. **Unverified**: No baseline load run was executed or evidenced. The local unit run is not a load test. E14.
- [ ] Stress testing completed. **Unverified**: No stress run was executed or evidenced. E14.
- [ ] Spike testing completed. **Unverified**: No spike run was executed or evidenced. E14.
- [ ] Sustained load testing completed. **Unverified**: No sustained/soak run was executed or evidenced. E14.
- [ ] Load test from multiple geographic locations. **Unverified**: No multi-region run was executed or evidenced. E14.
- [ ] Load test captures various metrics. **Unverified**: No load-run latency/throughput/error/resource dataset was supplied. E14.
- [ ] Load test alerts trigger appropriately. **Unverified**: No alert-trigger test under load was supplied. E14.

### Load test analysis

- [ ] Load test results analyzed. **Unverified**: No load-run results exist in this assessment to analyze. E14.
- [ ] Performance degradation identified. **Unverified**: No degradation curve across load levels was measured. E14.
- [ ] Breaking point found. **Unverified**: No saturation or breaking-point experiment was supplied. E14.
- [ ] Bottlenecks identified. **Unverified**: No measured load-test bottleneck analysis was supplied. Structural code risks are listed separately. E14.
- [ ] Scaling limits documented. **Partial**: Platform SQL limits and application tree/file/batch bounds are known; measured user/throughput capacity remains unknown. E1, E3, E7.
- [x] Recommendations made. **Verified**: This assessment records concrete measurement and optimization follow-ups below, based on source/test/build evidence. They are not load-test findings. E14.
- [ ] Changes implemented based on results. **Unverified**: No changes based on measured load-test results are evidenced; this task changes documentation only. E14.

### Capacity planning

- [ ] Current capacity documented. **Partial**: Configured limits are documented below; tested sustainable workload and headroom are not established. E1, E7, E11, E14.
- [ ] Growth projections estimated. **Open**: No issue/attachment/user growth forecast was supplied. E14.
- [ ] Scaling strategy planned. **Partial**: Batching and asynchronous consumers provide bounded execution; a quantified scaling plan against platform quotas is missing. E8, E14.
- [ ] Infrastructure costs estimated. **Open**: No workload-based compute/SQL/storage/LLM cost estimate was verified. E14.
- [ ] Scaling timeline established. **Open**: No growth-triggered scaling milestones or timeline was supplied. E14.

---

## Performance regression prevention

- [ ] Performance tests in CI/CD pipeline. **Partial**: npm test includes structural performance contracts and verify runs tests/build; no repository CI workflow or latency/size-budget gate was found. E3, E5, E12.
- [ ] Performance benchmarks established. **Partial**: Query-count contracts and fresh artifact sizes provide local structural baselines; no live latency/throughput benchmark. E3, E5, E12.
- [ ] Regression alerts configured. **Open**: The bundle-size warning is informational; no automated regression alert destination/threshold was found. E12.
- [ ] Performance reviews in code review process. **Unverified**: No enforced performance-review checklist or required review gate was found. E14.
- [ ] Performance tracking over time. **Open**: No longitudinal performance metric series was supplied. E6.
- [x] Documentation of performance changes. **Verified**: Capture batching, summary-reader boundaries and restore I/O reductions are documented; this checklist adds current evidence and gaps. E3, E5, E8.
- [ ] Root cause analysis for regressions. **Partial**: Tests document specific repeated-work regressions and the restore investigation records causes; no recurring performance incident/RCA process was verified. E3, E5, E8.

---

## Audited performance numbers

The code-level ratios below come from the rigorous re-benchmarking supplied by the user (7–9 runs, 100k–200k iterations per run); they were not independently rerun in this document-editing pass. The API formatting and payload figures come from the retained nine-run local audit in E21. All are local measurements or fixture counts, not deployed latency results.

| Code-level change | Audited result | Interpretation |
| --- | --- | --- |
| sha256Hex direct string update | 1.00–1.01x; about 0–3 ns/call | Noise; no meaningful measured gain. |
| logicalNodeId inlining | 1.08x | Modest local improvement. |
| contentFieldIds single pass | 1.34x | Modest local improvement. |
| encodeValue single-chunk branch | 2.51–2.83x | Local encoding-path improvement. |
| decodeValue single-row branch | 5.53x | Local decoding-path improvement. |
| Batch parameter loop unrolling | 1.25–1.28x; about 0.098 µs saved/call | Small absolute saving; endpoint benefit unmeasured. |
| Multi-part hash unrolling | 0.95–0.98x | Regression/noise. |
| isStructuralField fast path | 1.38–2.21x | Noisy and field-mix dependent. |
| Equivalent-digest cache | No accepted speedup ratio | Cache exists; the earlier benchmark comparator was misleading. |

| API measurement | Correct value | Scope |
| --- | --- | --- |
| Compact JSON serialization | Median 6.787 → 4.773 µs; paired median 1.43x; about 2.014 µs saved | Three-run synthetic summary; 9 pairs of 100,000 iterations. |
| JSON download size | 5,212 → 2,884 bytes; 44.7% smaller | Same synthetic summary; UTF-8 bytes. |
| Whole response size | 14,066 → 11,529 bytes; 18.0% smaller | Includes snapshot plus JSON/HTML exports; before transport compression. |
| Panel Jira calls | 3 | No-parent fixture: issue, profile and real transition reader. Ancestor checks may add calls. |
| Queue Jira calls | 51 for 50 candidates; peak issue-read concurrency 5 | One search plus 50 live reads; concurrency does not reduce call volume. |
| Same-key request cache | 30 reads → 1 factory call | One invocation only; 30 separate invocations still execute 30 factories. |
| Saved-summary issue-reader calls | 103 calls for 100 runs of one test and one coverage row | Two distinct issue IDs; this is the saved-summary read path. |
| Backend retry delays | 5, 10, 20, 40, 60 seconds | Local restore/vault worker behavior. |
| Deployed API latency, throughput, p95 or cold-start gain | Not measured | No production speedup claim. |

## Performance changes verified locally

The following implementation changes were verified locally on 28 October 2026. They are not measured reductions in deployed response time.

### Optimization: batched tree capture

- **Improvement:** The fixture with 120 nodes and one retained value per node uses 3 node INSERT statements plus 3 value INSERT statements and 1 metadata UPDATE. Compared with one insert per node/value (240), that is 6 inserts, a calculated 97.5% reduction in insert statement count.
- **Date:** Reverified 28 October 2026; original implementation date is not asserted.
- **Scope/technique:** `writeTreeCapture`, batches of 50 rows. E3.
- **Measurable impact:** The current statement count is asserted by a passing test. The 240-insert comparator is a calculated per-row model, not a historical tenant trace. No millisecond improvement is claimed.

### Optimization: request-scoped read coalescing

- **Improvement:** Two same-key local reads in one invocation execute the factory once.
- **Date:** Reverified 28 October 2026.
- **Scope/technique:** `memo` stores the in-flight Promise inside AsyncLocalStorage. E4.
- **Measurable impact:** Local assertions confirm deduplication, a fresh value in a new invocation, rejected-entry eviction, and isolation between overlapping scopes. No cross-invocation cache hit rate or tenant SQL saving was measured.

### Optimization: lightweight panel summary

- **Improvement:** The summary contract forbids tree, changelog, editmeta and retained-value readers and checks one issue read.
- **Date:** Reverified 28 October 2026.
- **Scope/technique:** Summary/detail separation with poisoned-reader regression fixtures. E5.
- **Measurable impact:** Contract tests pass; deployed p95/cold-start performance remains unmeasured. The deliberate `fields=*all` issue read is retained for drift correctness.

### Optimization: evidence-keyed report and attachment reuse

- **Improvement:** Reports reuse evidence/model keys; unchanged baseline attachments can reuse an existing content-addressed object after an existence check.
- **Date:** Source reviewed 28 October 2026; restore investigation dated 27 October 2026.
- **Scope/technique:** `reportHashFor`, SQL report cache, vault reuse. E4, E8.
- **Measurable impact:** Existing code and the restore investigation support reduced repeat work. No fresh live I/O count or latency comparison was collected; restore workers were not retested in this assessment.

### Optimization: inlined logicalnodeid and fast-path isstructuralfield

- **Improvement:** Inlining deterministic single-key JSON serialization in `logicalNodeId` bypasses construction and canonical traversal of a one-key wrapper; the existing one-key canonical fast path already skips sorting; inlining identity checks in `isStructuralField` avoids Set lookups and `String()` conversions on the fast path.
- **Date:** Implemented and verified 28 October 2026.
- **Scope/technique:** `src/lib/tree/model.js` and `src/lib/tree/structure.js`. E7, E16.
- **Measurable impact:** `test/code-level-optimization.test.js` confirms byte-for-byte digest parity. The supplied rigorous audit reports `contentFieldIds` at 1.34x and `logicalNodeId` at 1.08x. These are isolated local ratios, not application speedups; no heap profile was collected. E20.

### Optimization: value store chunk & decode allocation minimization

- **Improvement:** `encodeValue` returns single-chunk base64 payloads directly without `.slice()` copy; `decodeValue` bypasses sorting, validation callbacks, and `.map().join()` string allocations when decoding single-row values, reading raw bytes directly from buffer length instead of re-encoding to UTF-8.
- **Date:** Implemented and verified 28 October 2026.
- **Scope/technique:** `src/lib/valuestore.js`. E7, E16.
- **Measurable impact:** `test/code-level-optimization.test.js` asserts correctness. The supplied rigorous audit reports single-row `decodeValue` at 5.53x and single-chunk `encodeValue` at 2.51–2.83x. These are isolated local results; they do not establish an endpoint latency improvement. E20.

### Optimization: 2x unrolled batch SQL parameter generation & placeholder caching

- **Improvement:** `writeTreeCapture` caches fixed 50-row SQL placeholder strings and uses 2x loop unrolling when building multi-row parameter arrays.
- **Date:** Implemented and verified 28 October 2026.
- **Scope/technique:** `src/db/baselineTreeStore.js`. E3, E16.
- **Measurable impact:** Passing test confirms correct parameter generation for both even and odd batch sizes. The supplied rigorous audit reports 1.25–1.28x for parameter building, about 0.098 µs saved per measured call. Fixed placeholder reuse is a structural improvement; endpoint latency and zero-allocation claims are not established. E20.

### Optimization: direct string hashing in sha256Hex & 4x loop unrolling

- **Improvement:** `sha256Hex` updates string parts directly using native UTF-8 OpenSSL hashing without allocating intermediate `Buffer` instances, and unrolls multi-part loops by 4x.
- **Date:** Implemented and verified 28 October 2026.
- **Scope/technique:** `src/lib/hash.js`. E16.
- **Measurable impact:** Correctness assertions establish exact hash parity across variable argument counts. The supplied audit reports direct string hashing at 1.00–1.01x (noise) and multi-part unrolling at 0.95–0.98x (regression/noise). Removing an explicit Buffer conversion is not proof of a runtime win. E20.

---

## References

- [Lighthouse](https://developers.google.com/web/tools/lighthouse)
- [WebPageTest](https://www.webpagetest.org/)
- [Google PageSpeed Insights](https://pagespeed.web.dev/)
- [Web.dev Performance](https://web.dev/performance/)
- [Performance.now()](https://developer.mozilla.org/en-US/docs/Web/API/Performance)

---

## Evidence register

Paths below are relative to the repository root. Source inspection establishes implementation, not deployment or live acceptance. Earlier documents are labeled as such; their historical test counts are not reused as fresh results.

| ID | Evidence and scope |
| --- | --- |
| E1 | `manifest.yml`; `src/lib/db.js`; `test/db-logging.test.js` (fresh pass). The original 28 October snapshot called `sql.prepare(...).bindParams(...).execute()` and logged redacted failures without success-duration instrumentation or an application pool. Duration instrumentation was subsequently added (E27) and freshly audited (E29). [Forge SQL reference](https://developer.atlassian.com/platform/forge/storage-reference/sql/) checked 28 October 2026 confirms hosting, SQL limits and available console metrics; actual tenant configuration/usage was not inspected. |
| E2 | `src/db/migrations.js`, `src/db/configStore.js`, `src/db/itemStateStore.js`, `src/db/baselineTreeStore.js`, `src/db/driftStore.js`, `src/db/childBaselineStore.js`. Index definitions, lookup predicates, grouped/aggregate queries and row bounds were inspected; no EXPLAIN/cardinality/size output was obtained. |
| E3 | `src/db/baselineTreeStore.js`, constants `NODE_BATCH`/`VALUE_BATCH` and `writeTreeCapture`; `test/tree-storage.test.js`, especially the 120-node batching fixture (fresh pass). |
| E4 | `src/lib/cache.js`; memo consumers in `src/db/configStore.js`; `src/db/reportStore.js`; `src/lib/report.js` (`reportHashFor`). Four fresh standalone local assertion scenarios exercised request memo behavior. No full cache-consistency audit or same-request write/read test was run. |
| E5 | `src/usecases/panelSummary.js`, `src/usecases/queue.js`, `test/panel-performance-contract.test.js` (fresh pass). The existing design `docs/specs/2026-09-13-baseline-owned-recall-and-responsive-controls-design.md`, section 6, defines warm/cold/feedback objectives. Objectives are not acceptance results. |
| E6 | `src/lib/harnessLogger.js`, `scripts/harness.mjs`, `src/resolvers/{panel,admin,totp,testManagement}.js`, `test/harness.test.js` (fresh pass). Resolver wrappers log duration/outcome; CLI statistics compute min/average/P95/max from available events. No live log corpus, installed alert rules or dashboard was inspected. |
| E7 | `src/lib/tree/{model,jira,stableRead}.js`, `src/lib/vaultObjectStore.js`, `src/lib/valuestore.js`, `frontend/src/main.tsx`. Tree cap/queue/visited set, file/range caps, whole-buffer reads, synchronous gzip and lazy imports were inspected. No memory/CPU trace was collected in the initial assessment; later local profiling is recorded in E28 and freshly reproduced in E29. |
| E8 | `src/jobs/{runner,reconcile,restoreWorker,vaultWorker}.js`, `src/lib/restore/{queue,executor}.js`, `src/db/itemStateStore.js`, `src/lib/{interception,trackedFields,aiClassification,report}.js`, `src/triggers/retry.js`, `src/testmgmt/jira.js`. Existing `docs/acceptance/2026-10-27-restore-reliability.md` records earlier reliability work and remaining limits. These workers and retry paths were source-reviewed, not all freshly executed here. |
| E9 | `src/lib/retention.js`, `src/jobs/{prune,seal}.js`, `src/db/reportStore.js`. Retention policy and guarded archival logic are implemented; `prune.js` explicitly retains baseline values pending verified archival coverage. No tenant retention setup or archival run was accepted. |
| E10 | `src/testmgmt/{store,planningStore,retestStore,reportStore,sourceLinkStore,treeExclusion}.js`. SELECT *, joins, IN-based bulk readers, projections and bounded/truncated report results were inspected. No production query trace was collected. |
| E11 | `manifest.yml`, Forge SQL SDK architecture, main UI resource `frontend/dist`, and [Forge Custom UI hosting documentation](https://developer.atlassian.com/platform/forge/extend-ui-with-custom-options/) checked 28 October 2026. Platform ownership is an architecture classification; no SLA, physical deployment, cache-header, backup, CPU, memory, CDN or regional-performance guarantee is inferred. |
| E12 | `frontend/{package.json,vite.config.ts,index.html}`, `frontend/src/main.tsx`, `frontend/src/ui/tokens.css`, `frontend/public/{favicon,icons}.svg`, generated `frontend/dist` and fresh build output. No raster/font/video assets were found in the reviewed frontend source/public inventory. [Vite build options](https://vite.dev/config/build-options) and [build optimizations](https://vite.dev/guide/features#build-optimizations) checked 28 October 2026 support default minification, preload and chunk behavior. |
| E13 | [Web Vitals definitions and thresholds](https://web.dev/articles/vitals) and [INP replacing FID](https://web.dev/blog/inp-cwv-launch) checked 28 October 2026. Use LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1 at p75, segmented by device. Preserve the template's original wording while treating its FID row as obsolete. No browser metric was measured. |
| E14 | Workspace/package-script/test/document inventory: no dedicated k6/JMeter/Locust/Artillery harness, run dataset or repository CI configuration was found in reviewed files. Existing plans call for bounded-scale checks but do not prove execution. Follow-ups below are assessment recommendations, not a completed load test or permission to load the tenant. |
| E15 | Focused API Performance re-verification, 28 October 2026 (same day, follow-up pass): `src/usecases/access.js` (shared `{error, reason}` envelope), `src/usecases/queue.js` (pagination, bounded read concurrency), `src/testmgmt/{bug.js,jira.js,summary.js}` (throttled bug creation, Retry-After parsing, pretty-printed download JSON), `src/usecases/testSummary.js`, `src/resolvers/{panel.js,testManagement.js}` (every resolver definition traced), `src/lib/{restore/queue.js,vaultQueue.js,linkQueue.js,vaultObjectStore.js}` (keyed queue concurrency, ranged downloads), `src/db/baselineTreeStore.js` (tiered column-fallback query), `src/triggers/retry.js`, `src/jobs/{restoreWorker.js,vaultWorker.js}` (exponential backoff), `manifest.yml` (retired field module). `node --test test/queue.test.js` (fresh, 16/16 passing) and a fresh rerun of `test/panel-performance-contract.test.js` (35/35 passing) were executed directly in this pass. |
| E16 | Code-Level Optimization source implementation and verification, 28 October 2026: `test/code-level-optimization.test.js` (fresh pass, 5/5 passing); `src/lib/hash.js` (sortDeep string/boolean fast path, single-argument direct hashing, 4x loop unrolling for multi-part hashing); `src/lib/tree/model.js` (inlined logicalNodeId deterministic serialization); `src/lib/tree/structure.js` (inlined isStructuralField fast identity checks, single-pass contentFieldIds/contentFields); `src/lib/valuestore.js` (single-chunk encode without slice allocation, single-row decode without .sort()/.some()/.map().join(), raw length from buffer); `src/lib/db.js` (string/hex toBinaryParam, buffer fromBinaryColumn); `src/db/childBaselineStore.js` (eliminated redundant Buffer.from wrapping); `src/db/baselineTreeStore.js` (cached 50-row value placeholders, 2x loop unrolling on parameter building); `src/lib/tree/diff.js` (direct Map loops); `src/lib/content.js` (cached ADF empty document and null digests in digestsEquivalent). |
| E17 | API Performance source fix, 28 October 2026 (same follow-up pass as E15): `src/testmgmt/summary.js` compacted the standalone `.json` download (`JSON.stringify({ summaryId, digest, snapshot })`, no indentation), which is returned inline inside the `tm:summary:generate`/`tm:summary:read` resolver response (`src/usecases/testSummary.js:76,101`). Measured on a representative sample (3 runs with steps/signatures): 3979 → 2365 bytes, a 41% reduction. `npm test` (fresh, 2179/2179 passing) confirms no regression, including `test/testmgmt-coverage-summary.test.js:136-142`, which parses and asserts on `downloads.json.content`. A repository-wide grep confirmed the only remaining pretty-printed `JSON.stringify(..., null, 2)` calls are the `.html` download's human-read `<pre>` blocks (same file) and the temporary diagnostic webtrigger `src/jobs/probe.js:21`. Neither is a regression. |
| E18 | Adversarial API checklist audit, 28 October 2026: `docs/acceptance/2026-10-28-api-performance-adversarial-audit.md`. Source snapshot at review time `b718ada843dce74015e8a3ca4f31a25407624743` plus existing working-tree changes; relevant source hashes checked for stability. 144 existing local tests passed; 4 isolated counterexample/format fixtures passed; a separate 62-test run included exact worker-delay assertions and overlaps earlier worker coverage. Confirmed a 200-decision cap without continuation, a swallowed queue hydration 429, missing caller retry metadata, current compact summary JSON and actual bounded exponential delays. No product-source changes, deployment, load test or live acceptance; earlier E15/E17 evidence remains historical. |
| E19 | Pagination source fix for the 200-decision cap E18 found, 28 October 2026: `src/usecases/queue.js`. `decisionsFor` now requests `DECISIONS_HARD_CAP = 2000` instead of the implicit 200 and reports `overflow`; `list` pages the result in memory with a new `decodeToken`/`encodeToken` composite cursor and rebuilds its transition-exclusion `skip` set from the complete decision list on every call. `test/queue.test.js` updated (the `limit` now passed to `awaitingDecision`) and extended with a 201-decision, 3-page regression test asserting completeness, no duplicates, stable ordering and no decision ever misclassified as a transition. `node --test test/queue.test.js` (17/17) and `npm test` (2180/2180) both fresh passes. |
| E20 | User-supplied Speed Claims Audit in this conversation, 28 October 2026: 7–9 runs, median, 100k–200k iterations per run. Corrected code-level figures are recorded in Audited performance numbers. These results are supplied evidence, not a fresh independent run by this editing pass. No accepted 69.9x equivalent-digest caching claim or deployed API speedup is retained. |
| E21 | Local API speed audit: `docs/acceptance/2026-10-28-api-speed-claims-audit.md`, raw `docs/acceptance/api-speed-audit-2026-10-28/results.json`, and `scripts/audit-api-performance.mjs`. Nine paired 100k-iteration serialization runs, deterministic payload bytes, request-count fixtures and a 172-test local regression pass. Results are historical snapshot evidence; later error-wrapper changes are verified separately in E22. No live RTT, latency percentile, compression header or throughput measurement. |
| E22 | Current source read-back of `src/usecases/access.js` and `src/testmgmt/messages.js`: both now include retryGuidance in error envelopes. Nine fresh assertion repetitions in this document-update pass confirmed that each preserves supplied status 429 and retryAfterMs 3000. This credits the backend metadata contract only; it does not establish frontend retry acceptance or repair queue hydration swallowing non-OK responses. |
| E23 | Pagination hardening in response to an automated security review of the E19 fix, 28 October 2026: `src/usecases/queue.js`, `src/db/itemStateStore.js` (`issue_id ASC` tiebreaker on `awaitingDecision`). The decisions cursor changed from a row position/offset to a value cursor on `(last_drift_at, issue_id)`, immune to the set changing shape between calls. Two new `test/queue.test.js` cases: 201 decisions over 3 pages with no gaps/duplicates/leaks, and one that removes the earliest decision between two page calls and confirms the still-outstanding one is still returned (reproducing, then closing, exactly the failure mode the review described). `node --test test/queue.test.js` (18/18) and `npm test` (2181/2181) fresh passes. |
| E24 | Client-backoff contract completed end to end, 28 October 2026: `src/usecases/access.js`/`src/testmgmt/messages.js` (shared `retryGuidance` helper, additive `status`/`retryAfterMs` fields, built on E22) and `frontend/src/lib/result.ts` (new `ResultError extends Error`, replacing a bare `new Error(message)` that discarded the whole envelope). `npm run build:ui` passes (fresh production TypeScript/Vite build); `test/user-consent.test.js`'s existing exact-shape assertion on `respond()`'s ordinary-error output still passes unchanged, confirming no fields are fabricated. Repository-wide check of frontend `instanceof Error`/`.name` call sites found none that `ResultError` would break. No UI reads `status`/`retryAfterMs` yet to show a wait time or gate a retry. That work remains open because the adversarial audit cautioned against unsafe automatic replay of mutations. |
| E25 | Permission-existence-oracle fix in response to an automated security review of the E24 fix, 28 October 2026: `src/usecases/access.js`. `retryGuidance` no longer forwards `status` for every error that carries one. It forwards it only for `status === 429 \| 503`, the two codes the function's own contract claims to serve. `src/testmgmt/jira.js#json()` (confirmed by direct read) deliberately sets `error.status` to the raw 403/404 from Jira while mapping both to the same `reason: 'NOT_FOUND'`; before this fix, `retryGuidance` would have echoed that raw status straight back to the client, defeating the deliberate indistinguishability. New `test/user-consent.test.js` cases (fresh pass) assert a 403 and a 404 each produce `{}` from `retryGuidance` and no `status` field at all from a full `respond()` call, while 429/503 are unaffected and an ordinary 500 forwards nothing. `tmRespond` was spot-checked directly (same shared helper) for the same two cases with the same result. Full suite `npm test` (2183/2183) fresh pass. |
| E26 | Cache observability, 29 October 2026: `src/lib/cache.js` gained a per-scope `stats: { hits, misses, evictions }` alongside the existing AsyncLocalStorage-scoped map, incremented inside `memo()` at each hit/miss/eviction point, and a new `getCacheStats()` accessor (returns zeros outside any `withRequestCache()` scope rather than throwing). No existing export, signature or call site changed. `test/cache-observability.test.js` (new, fresh pass, 6/6): hit-only increment, miss-only increment including a post-eviction retry counted as a fresh miss, eviction-on-rejection, a fresh scope starting at zero, isolation between two concurrently-running overlapping scopes, and zero-outside-scope with no throw. The three existing test files that exercise `withRequestCache` (`test/config-corruption.test.js`, `test/controlled-field-precedence.test.js`, `test/transition-screen-proposed-drift-runtime.test.js`) re-run unchanged, 66/66 passing. None asserted on stats before, so the new tests do not duplicate their coverage. These are local in-memory counters for the current request scope only; no cross-request aggregation, dashboard, alert or live hit-ratio report is implemented or claimed. |
| E27 | SQL duration, slow-query log/alert and response-size instrumentation, 29 October 2026: `src/lib/db.js` gained a `SLOW_QUERY_MS` constant (2000, reasoned against the platform's documented 5 s SELECT timeout) and `executeQuery` now measures wall-clock duration around every successful and failed call, returns it as `durationMs`, and logs every query via a new `logQueryDuration` helper that tags one crossing the threshold `[SLOW_QUERY_ALERT]` (redacted the same way existing failure logs are). `src/lib/harnessLogger.js`'s `wrapWithHarness` also logs `responseBytes` (`Buffer.byteLength(JSON.stringify(result))`) on the existing success-path resolver log entry, guarded by try/catch so an unserializable result cannot throw. `src/jobs/alerts.js` and `src/lib/alerts.js` were read in full first; the Jira security-alert pipeline was deliberately NOT reused for the slow-query signal, since `db/alertStore.js` implements it by calling `executeQuery` itself (a circular-call risk) and it is scoped specifically to 21 CFR 11.300(d) unauthorized-use detection, rather than performance. Routing slow-query alerts through it would mislabel the signal. New `test/db-timing.test.js` (6/6 fresh pass) and two new cases in `test/harness.test.js` (fresh pass). Full suite `npm test`: 2197/2197 passing immediately after this change, 2199/2199 once E26 and E28 landed alongside it. |
| E28 | Recursive-helper removal and local memory/CPU profiling, 29 October 2026: both `src/lib/content.js` and `src/lib/tree/diff.js` were read in full and grepped for self-calling functions. Exactly one recursive content/diff helper existed: `normaliseAdf` (`src/lib/content.js`), now rewritten as an explicit stack-based walk. Pushing keys in descending order onto the LIFO stack preserves the original key insertion order and byte-for-byte output. Parity was verified against the original recursive implementation on 60 randomized/edge fixtures (byte-identical `JSON.stringify` output); the original independently confirmed to overflow the call stack around depth 2,000–3,000, the rewrite verified correct at depth 10,000. Both were checked in `test/baseline-content.test.js` (fresh pass, 16/16). `diffTree` in `tree/diff.js` was confirmed not recursive (plain loops over Maps); `src/lib/hash.js#sortDeep` is recursive but is a general hashing utility outside this scope, left untouched. New `scripts/profile-memory-cpu.mjs` (hash-checks `content.js`/`diff.js`/`model.js`/`valuestore.js`/`hash.js` before and after, makes no network/DB calls, mutates no product file) measured, via `process.memoryUsage()` with forced GC between phases, heapUsed/rss deltas for building a 500-node (`TREE_LIMIT`) tree (+0.5 MiB heap), `project()`-ing all 500 nodes (+2.37 MiB heap), `diffTree()` over two such trees (+0.06 MiB heap), and `encodeValue`/`decodeValue` of a 5.2 MB value-store payload (+0.26/+6.34 MiB heap); none show runaway growth at `TREE_LIMIT`. Separately, via `perf_hooks.performance.now()` (100 warmup + 7 × 2000-iteration trials on an identical 5,638-byte input, stable across 3 independent reruns), it ranked the checklist's three named CPU candidates by measured self-time: `gzipSync` level 9 ≈21.3 µs/op, content canonicalization (`normaliseAdf`) ≈8.8 µs/op, `sha256Hex` ≈2.4 µs/op. Raw output, environment details and source hashes retained in `docs/acceptance/2026-10-29-memory-cpu-profile/results.json`. Full suite `npm test`: 2199/2199 passing. |

| E29 | Full audit of all 50 previously checked rows, 29 October 2026: `docs/acceptance/2026-10-29-verified-50-audit.md` and `docs/acceptance/verified-50-audit-2026-10-29/`. Manual source review at `a87375aeb4431d81089537be8fe4418f6a505cc9`; 557 existing source/test/config/document hashes checked unchanged through tests, build and profiling. Fresh backend 2199/2199, UI 301/301, four additional ADF parity/depth and actual worker delay checks 4/4, and production UI build passed. A forced-GC 500-node / 5.2 MB value-store fixture and seven-trial CPU measurements were rerun with source hashes. Retained 45 locally scoped Verified rows and downgraded five monitoring/analysis/alert rows to Partial. Counters have no production consumer; warning logs have no reviewed route/recipient. No product-source changes, deployment, tenant mutation, live measurement or installed external alert-rule inspection. |
| E30 | Cache telemetry and slow-query alert correction, 29 October 2026. A same-day change had added rolling container telemetry, miss sampling and diagnosis, public `evict()`/`clear()` with eviction types, and an in-process slow-query destination/sink/cooldown pipeline to `src/lib/db.js`; none of it had a production caller, and the docs claimed operational alert routing. All of that was removed and `src/lib/db.js` restored, including the comment explaining why the SQL wrapper does not route alerts. What remains: `withRequestCache(fn, { label })` logs one `[CACHE_TELEMETRY]` line per outermost scope (hits, misses, evictions, `coldMisses`, `postEvictionMisses`, rates over hits + misses; silent when the cache was unused), a nested call joins the outer scope, and `wrapWithHarness` labels resolver scopes. `test/cache-rates-telemetry.test.js` (4/4). Full suite `npm test`: 2203/2203. Local only; no log query, dashboard or deployed alert rule was configured or inspected. |

## Initial local verification (historical)

Assessment date: **28 October 2026**, Asia/Kolkata. Repository commit: `5554807c3647531c02e80c9d903bf0fcc329a54a`. The existing untracked database checklist was present before this assessment; product source was updated with code-level optimizations and verified.

| Check | Result | What it proves |
| --- | --- | --- |
| `node --test test/panel-performance-contract.test.js test/tree-storage.test.js test/harness.test.js test/db-logging.test.js test/code-level-optimization.test.js` | Exit 0; **85 passed, 0 failed, 0 skipped** | Selected local structural, storage, logging, and code-level optimization behavior. Fixture timing is not production latency. |
| `node --test test/code-level-optimization.test.js` | Exit 0; **5 passed, 0 failed** | Verifies function call minimization, 2x/4x loop unrolling, inlining, elimination of redundant conversions, and string allocation minimization. |
| Standalone assertions importing `src/lib/cache.js` | Exit 0; **4 scenarios passed** | Same-invocation factory deduplication; fresh invocation; failed-entry eviction; overlapping-scope isolation. |
| `npm run build:ui` | Exit 0; TypeScript and Vite production build passed | Current source compiles and produces assets. Does not prove deployed page speed. |
| Largest shared JS chunk | `ui-BHu8FW-r.js`: **777.77 kB**, gzip estimate **210.98 kB** | Exceeds the default 500 kB minified chunk warning. Gzip is an estimate, not inspected transfer encoding. |
| Selected lazy chunks | TestPanel **71.61 kB**, admin **80.44 kB**, review **87.02 kB**, IssuePanel **23.31 kB** (raw build sizes) | Code splitting produces distinct resources; shared-dependency cost still applies. |
| CSS output | **28.77**, **31.76**, **36.80 kB** (raw build sizes) | CSS extraction/minification exists; unused CSS and render cost are unmeasured. |
| `node --test test/queue.test.js` (API Performance follow-up) | Exit 0; **16 passed, 0 failed** | Fresh confirmation of real pagination continuation (`nextPageToken`) in the approval queue, used as evidence for API Performance pagination. |

The initial 28 October assessment did not run the full backend/UI suites. The 29 October E29 audit freshly passed 2,199 backend tests, 301 UI tests and four additional audit checks, rebuilt the UI and repeated the scoped memory/CPU fixture. Live Forge metrics, browser profiling, Lighthouse, heap retainer graphs, regional comparisons and tenant load tests remain unperformed in this audit. Earlier acceptance results remain historical evidence.

## Known bounds and remaining work

Configured bounds are not sustainable-load capacity: tree reads cap at **500 nodes**, tree inserts batch **50 rows**, vault files cap at **250 MiB**, range downloads cap at **1 MiB**, and restore/vault workers declare **1024 MiB** and **600 s**. These do not establish concurrent-user capacity or attachment memory headroom.

Forge SQL currently documents **150 DML requests/s per install**, **1 MiB requests**, **4 MiB responses**, and query timeouts of **5 s SELECT / 10 s DML / 20 s DDL**. These are platform ceilings, not measured app throughput. Recheck [the SQL limits](https://developer.atlassian.com/platform/forge/storage-reference/sql/) when designing the workload.

1. Capture warm/cold panel and validator distributions on the intended tenant; record sample size, p50/p95/p99, errors and downstream SQL/Jira timing. Test the existing summary/feedback objectives separately from browser Web Vitals.
2. Inspect the generated dependency graph for the large shared UI chunk. Measure its initial-route transfer/parse cost before changing grouping; retain lazy screen boundaries and correctness checks.
3. Review SELECT * and unbounded project-listing paths with representative data and permitted execution-plan tools. Check missing/unused indexes from measured workloads rather than schema appearance.
4. SQL duration and response-size logs now exist; request-local cache counters are not consumed in production. Connect and analyze cache-rate telemetry, then verify installed dashboards and routed slow-query alert delivery. Local instrumentation alone does not prove ongoing monitoring.
5. Define an authorized staging load plan with expected/peak concurrency, issue/tree/attachment distributions, arrival rates, ramp/spike/soak durations and failure thresholds. Record SQL limits, memory, Jira throttling, backlog growth, retry amplification and workload-based costs.
6. Measure LCP/INP/CLS for the relevant Jira host and app iframe experience, documenting measurement boundaries. A local build and host PageSpeed score cannot substitute for this.

No percentage speedup, live readiness, unlimited scale or successful platform configuration is claimed without measurements. Completion of this document means every checklist row has been assessed, not that every performance requirement passes.
