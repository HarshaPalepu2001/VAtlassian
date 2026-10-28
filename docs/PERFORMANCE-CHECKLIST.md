# Performance Checklist

Comprehensive performance optimization checklist. Covers database optimization, caching, code performance, asset optimization, and load testing.

> **Completed assessment: 28 October 2026.** Scope: VAtlassian source at commit `5554807c3647531c02e80c9d903bf0fcc329a54a`, focused local tests and a fresh production build. This fills the supplied checklist; it does not implement every optimization in the template. No deployment, tenant mutation, production load test or Developer Console inspection was performed.
>
> This completed assessment is saved in both `docs/PERFORMANCE-CHECKLIST.md` and `/Users/sriharsha/Downloads/Perfromance.md`. The existing untracked `docs/DATABASE-CHECKLIST.md` is preserved and is not treated as independent proof. Document text was treated as checklist content, not authorization to run additional operational actions.

**Status key:** `[x] Verified` = directly supported in the stated local scope; `[ ] Partial` = some controls/evidence exist; `[ ] Open` = a gap was found in reviewed code/configuration; `[ ] Unverified` = measurement or operational evidence is missing; `[ ] Managed` = platform responsibility, not independently accepted; `[ ] N/A` = the literal control does not apply to this architecture. Only Verified items are checked. Managed and N/A rows are assessed, not silently counted as passes. “Not found” refers to the reviewed workspace and supplied evidence, not proof that an external team has never configured it.

**Assessment totals:** Verified: **32**; Partial: **74**; Open: **39**; Unverified: **62**; Managed: **34**; N/A: **42**. All 283 original checklist items retain their wording and order. `E1`–`E15` refer to the evidence register below. No overall performance-readiness pass is asserted. (The API Performance section was re-verified in a focused follow-up pass; one item — "JSON formatting optimized" — moved from Verified to Partial on that re-check, and every other API Performance row was re-derived from source rather than carried over. Totals above reflect that single change.)

## Table of Contents

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
12. [Performance Optimization Wins](#performance-optimization-wins)
13. [References](#references)
14. [Evidence Register](#evidence-register)
15. [Fresh Local Verification](#fresh-local-verification)
16. [Known Bounds and Remaining Work](#known-bounds-and-remaining-work)

---

## Database Performance

### Connection Management

- [ ] Connection pooling configured — **Managed**: Forge SQL is accessed through its SDK; no application-owned connection pool is configured. E1.
- [ ] Connection pool size optimized — **Managed**: No pool-size setting exists in the app; platform capacity still needs tenant measurement. E1.
- [ ] Idle timeout configured — **Managed**: No application-owned SQL idle timeout; SDK access is used. E1.
- [ ] Max connection limits set — **Managed**: No application connection limit is declared; service quotas are separate from a tuned pool. E1.
- [ ] Connection leaks prevented — **N/A**: The app does not open or release persistent SQL connections. This does not establish that all application resources are leak-free. E1.
- [ ] Database connection errors monitored — **Partial**: SQL failures produce redacted error and statement summaries; no connection-specific alert or live review was verified. E1.
- [ ] Slow connection acquisition monitored — **Managed**: Connection acquisition is not instrumented separately by the app. E1.

### Query Performance

- [ ] Slow query log enabled — **Open**: The SQL wrapper logs failures, not successful query durations or slow-query thresholds. E1.
- [ ] Query execution plans reviewed — **Unverified**: No execution-plan output for representative tenant queries was found. E1, E2.
- [ ] Long-running queries identified — **Unverified**: No live query-duration sample or ranked slow-query report was supplied. E1, E6.
- [ ] Query timeouts configured — **Managed**: Forge enforces SQL query timeouts; the app does not tune them. See the platform reference in E1.
- [ ] Query complexity assessed — **Partial**: Bounded reads and batch sizes show local complexity controls; no complete query-cost inventory or plan review. E2, E3.
- [x] Inefficient queries optimized — **Verified**: Tree capture uses multi-row inserts; the 120-node fixture verifies three node inserts and three value inserts. This proves query-count reduction only. E3.
- [ ] Full table scans minimized — **Partial**: Lookup indexes and bounded queries exist; unbounded project listing and plan verification remain to review. E2, E10.

### Indexing Strategy

- [ ] Index strategy documented — **Partial**: Index definitions are recorded in migrations; a measured query-to-index rationale is incomplete. E2.
- [ ] Indexed columns chosen wisely — **Partial**: Indexes include issue, project, actor and state/time lookup patterns; suitability under real data is unverified. E2.
- [ ] Index cardinality analyzed — **Unverified**: No live cardinality or selectivity measurements were found. E2.
- [ ] Composite indexes used appropriately — **Partial**: Composite lookup indexes exist, including approval and reviewer/project/state paths; actual plan usage is unverified. E2.
- [ ] Unused indexes removed — **Unverified**: No workload-based unused-index report or removal evidence was found. E2.
- [ ] Index size monitored — **Unverified**: No index-size measurements or growth trend were supplied. E2.
- [ ] Index fragmentation addressed — **Managed**: Physical index maintenance belongs to the hosted database; no maintenance result was inspected. E1.
- [ ] Index rebuild scheduled — **Managed**: No app-managed rebuild schedule; do not infer a verified platform schedule. E1.

### Database Optimization

- [ ] Database statistics updated — **Managed**: Database statistics maintenance is outside the app; no statistics freshness evidence was inspected. E1.
- [ ] Query optimizer configured — **Managed**: No application-owned database optimizer configuration. E1.
- [ ] Partitioning strategy (if applicable) — **N/A**: No table-partitioning scheme is declared; assess data growth and retention before proposing one. Per-install isolation is a different control. E1, E2.
- [ ] Materialized views used (if applicable) — **N/A**: No materialized-view implementation is declared; projections are ordinary application-maintained tables. E2, E10.
- [x] Denormalization considered — **Verified**: Stored field digests/tree counts and test source projections demonstrate deliberate derived representations. Their presence is not a latency benchmark. E2, E3, E10.
- [ ] Archive old data strategy — **Partial**: Retention and sealing policy exist; retained baseline values are deliberately not pruned without archival coverage. No live archival acceptance was run. E9.
- [ ] VACUUM/ANALYZE run regularly — **N/A**: VACUUM is a PostgreSQL-specific operation; this app uses Forge SQL. No app ANALYZE schedule is evidenced. E1.
- [ ] Database parameter tuning done — **Managed**: Database server parameters are not configured by this application. E1.

---

## Query Optimization

### SELECT Query Optimization

- [ ] SELECT * avoided (only needed columns) — **Open**: SELECT * remains in test-management stores, planning, reports, retest and source-link reads. E10.
- [ ] JOIN complexity minimized — **Partial**: Some lookups use simple joins or batched reads; no complete join-cost assessment. E2, E10.
- [ ] JOIN order optimized — **Unverified**: No execution plans establish join order or optimizer decisions. E2, E10.
- [ ] Subqueries optimized — **Unverified**: Report retention includes a NOT IN subquery; no representative plan or timing review. E4.
- [ ] DISTINCT used only when necessary — **Partial**: DISTINCT is used for unique fields/scopes and capture verification; necessity was not audited for every query. E2, E3.
- [ ] GROUP BY optimized — **Unverified**: GROUP BY exists in capture, drift and child-baseline queries; no plan/timing evidence. E2, E3.
- [ ] HAVING clauses optimized — **N/A**: No HAVING clause was found in the reviewed database/store paths. E2, E10.
- [ ] UNION ALL preferred over UNION — **N/A**: No UNION query was found in the reviewed database/store paths. E2, E10.

### N+1 Query Prevention

- [ ] N+1 queries identified and eliminated — **Partial**: Queue and test-management readers batch related entities; this is not proof that every N+1 path is eliminated. E5, E10.
- [x] Eager loading used (includes, joins) — **Verified**: Queue hydration loads related baseline data in bulk; store readers also use joins/IN queries. E5, E10.
- [x] Batch loading implemented — **Verified**: Batch readers exist for signatures, bugs, versions and queue baseline data. E5, E10.
- [ ] Query log analyzed for duplicates — **Open**: No successful SQL query stream or duplicate-query analysis was found. Failure summaries are insufficient. E1.
- [ ] ORM query analysis done — **N/A**: The app uses direct prepared SQL rather than an ORM. E1.
- [x] Lazy loading vs. eager loading trade-offs considered — **Verified**: The panel summary explicitly excludes heavy evidence/tree readers; detailed evidence loads separately, enforced by a passing contract test. E5.

### INSERT/UPDATE/DELETE Optimization

- [x] Bulk operations used for multiple records — **Verified**: Tree capture writes nodes and value chunks in multi-row statements. E3.
- [ ] Batch insert/update/delete implemented — **Partial**: Tree inserts are batched; not every update/delete path has been assessed for statement count and payload size. E3, E10.
- [ ] Unnecessary writes eliminated — **Partial**: Idempotent retries and completed-action journals avoid some repeat work; no global unnecessary-write audit. E8.
- [ ] Update-only-changed-fields pattern used — **Partial**: Restore planning targets changed content; full SQL config/report replacements still exist. E4, E8.
- [ ] Transaction batching optimized — **N/A**: No application transaction-batch implementation was found; multi-row SQL and durable/CAS workflows are used instead. E1, E3, E8.
- [ ] Lock contention minimized — **Partial**: Optimistic claims, finite leases and keyed queue concurrency reduce conflicts; no live contention measurement. E8.

### Stored Procedures & Functions

- [ ] Stored procedures used appropriately — **N/A**: No stored procedures are defined in the app migrations. E2.
- [ ] Function performance assessed — **Partial**: Resolver durations are logged and selected hot paths have structural tests; no comprehensive function profiling. E5, E6.
- [ ] Recursive functions avoided — **Partial**: Tree traversal uses a queue and visited set; recursive content/diff helpers still require workload profiling. E7.
- [ ] Trigger impact on performance evaluated — **Partial**: Jira event handlers and scheduled jobs have some bounds/retries; no measured trigger-overhead study. These are not SQL triggers. E8.
- [ ] Stored procedure logic reviewed for optimization — **N/A**: No stored-procedure logic exists to optimize in this schema. E2.

---

## Caching Strategy

### Application Caching

- [x] Caching layer implemented (Redis/Memcached) — **Verified**: A request-scoped Map/AsyncLocalStorage cache and SQL-backed AI report cache are implemented. Redis/Memcached is not used. E4.
- [x] Cache invalidation strategy documented — **Verified**: Request lifetime and evidence/model-based report keys are documented beside their implementations. E4.
- [ ] Cache TTLs optimized — **Partial**: Request entries expire with their invocation; reports use evidence keys and retention. No measured TTL tuning was done. E4, E9.
- [ ] Cache warming implemented — **N/A**: No cache warmer is implemented; request memoization initializes on demand. E4.
- [x] Cache bust strategy implemented — **Verified**: A new invocation has a fresh memo scope; changed report evidence/model creates a new key. This is not HTTP cache invalidation. E4.
- [ ] Cache stampede prevention implemented — **Partial**: In-flight Promises coalesce within one invocation; cross-invocation report generation is not shown to have a distributed single-flight lock. E4.
- [ ] Distributed cache configured (if needed) — **N/A**: No Redis/Memcached deployment is declared; the report cache persists through Forge SQL. Cross-worker stampede risk remains to measure. E1, E4.
- [ ] Cache consistency maintained — **Partial**: Invocation isolation and failure eviction pass local assertions; same-invocation read-after-write behavior and all consumers still need a full audit. E4.

### Cache Types

- [x] Query result caching implemented — **Verified**: Config/control SQL results are memoized within a request. E4.
- [x] Object/entity caching implemented — **Verified**: Decoded configuration and report objects are cached in the relevant read paths. E4.
- [ ] Page/fragment caching implemented — **N/A**: No server-rendered page or fragment cache exists in the Forge Custom UI architecture. E11.
- [ ] Session caching configured — **N/A**: The app does not configure a separate server-session cache; Forge supplies invocation context. E11.
- [ ] Authentication token caching — **N/A**: No performance-oriented authentication-token cache is configured. Fresh authorization must remain a separate correctness requirement. E4, E11.
- [x] Configuration data caching — **Verified**: getConfig and projectConfig use request-scoped memoization. E4.
- [ ] Reference data caching — **Partial**: Controlled fields, transitions and some test-project metadata are memoized; reference-cache coverage has not been audited end to end. E4, E10.

### Cache Monitoring

- [ ] Cache hit rate monitored — **Open**: No cache hit counters or hit-ratio reporting were found in the cache implementation. E4.
- [ ] Cache miss rate analyzed — **Open**: No cache-miss instrumentation or analysis was found. E4.
- [ ] Cache eviction rate tracked — **Open**: Failed Promises are evicted, but eviction counts/rates are not recorded. E4.
- [ ] Cache memory usage monitored — **Open**: No cache-entry count, memory measurement or size alert was found. E4.
- [ ] Cache performance alerts configured — **Open**: No cache-specific performance alert configuration was found. E4, E6.
- [ ] Slow cache operations identified — **Open**: No per-cache-operation latency measurement was found. E4.

### HTTP Caching Headers

- [ ] Cache-Control headers set appropriately — **Managed**: Forge hosts Custom UI resources; actual deployed Cache-Control headers were not inspected. E11.
- [ ] ETag headers implemented — **Unverified**: No app ETag implementation or deployed response capture was found. E11.
- [ ] Last-Modified headers set — **Unverified**: No app Last-Modified policy or deployed response capture was found. E11.
- [ ] Expires headers configured — **Unverified**: No app Expires policy or deployed response capture was found. E11.
- [ ] Public vs. private caching configured — **Unverified**: No deployed public/private cache-policy review was performed; sensitive resolver data needs separate treatment from static assets. E11.
- [ ] Conditional requests handled (304 Not Modified) — **Unverified**: No conditional GET/304 test or deployed response evidence was supplied. E11.
- [ ] Cache validator freshness optimized — **Unverified**: No freshness/validator tuning measurements were found. E11.

### CDN Configuration

- [ ] CDN enabled for static assets — **Managed**: Static resources are declared for Forge hosting; deployed CDN behavior was not independently captured. E11.
- [ ] CDN cache keys configured — **Managed**: No app-owned CDN cache-key configuration is declared. E11.
- [ ] CDN cache TTLs optimized — **Managed**: No app-owned CDN TTL configuration or measured validation. E11.
- [ ] CDN compression enabled — **Unverified**: Build gzip estimates do not prove CDN transfer compression; inspect deployed Content-Encoding. E11, E12.
- [ ] CDN geographic distribution considered — **Managed**: Hosting distribution is controlled by the platform; no regional latency study was run. E11.
- [ ] CDN purge strategy documented — **Partial**: Build assets use content-hashed filenames; no operational CDN purge runbook was found. E12.
- [ ] CDN performance monitored — **Unverified**: No CDN timing dashboard or response sample was inspected. E11.

---

## Code Performance

### Algorithm Optimization

- [ ] Algorithm complexity analyzed (Big O) — **Partial**: Query counts, batching and collection caps are reasoned about locally; no complete Big O inventory. E3, E7.
- [ ] Inefficient loops identified — **Partial**: The expensive per-node capture-write pattern has a regression test; no whole-program loop profile. E3.
- [ ] Nested loop complexity reduced — **Partial**: Some fan-out is batched and maps replace repeated lookup work; no global nested-loop audit. E3, E5, E7.
- [ ] Sorting algorithms optimized — **Unverified**: Canonical/report-key sorting exists, but no sort workload benchmark was supplied. E4, E7.
- [ ] Search algorithms optimized — **Partial**: Map/Set and indexed lookups exist; no comparative search benchmark. E2, E5, E7.
- [x] Data structure choice justified — **Verified**: Queue hydration uses maps and tree traversal uses a visited set for identity lookup and cycle detection. E5, E7.
- [ ] Recursive functions evaluated — **Unverified**: No stack-depth/recursive-helper performance assessment was found. E7.

### Memory Optimization

- [ ] Memory profiling done — **Unverified**: No heap snapshot, allocation profile or retained-memory report was supplied. E7.
- [ ] Memory leaks prevented — **Partial**: Caches are invocation-scoped and UI effects clean up some timers; no sustained-run heap evidence proves leak freedom. E4, E7.
- [ ] Large object allocation minimized — **Partial**: File and tree limits exist, but vault reads and hashing still materialize whole buffers. E7.
- [ ] String concatenation optimized — **Unverified**: No string-allocation or concatenation profile was found. E7.
- [x] Collection sizes limited — **Verified**: TREE_LIMIT is 500; vault files are capped at 250 MiB and download ranges at 1 MiB. These are limits, not tested capacity. E7.
- [x] Lazy initialization used — **Verified**: Screens and job modules use lazy imports; Object Store setup is loaded on demand. E7, E8, E12.
- [ ] Object reuse patterns implemented — **Partial**: Memoized objects and content-addressed vaulted bytes are reused; no general allocation-reuse assessment. E4, E7.
- [ ] Garbage collection tuning considered — **Managed**: Node runtime GC is platform-controlled; no app GC tuning evidence. E11.

### Concurrency & Parallelization

- [ ] CPU-intensive operations identified — **Partial**: Synchronous level-9 gzip, hashing and content canonicalization are visible CPU candidates; no CPU trace ranks them. E7.
- [x] Parallelization opportunities found — **Verified**: Independent reads use Promise.all and several Jira readers use bounded batches. E3, E5, E8.
- [ ] Thread pool configured — **N/A**: No application-owned worker-thread pool is configured. Async I/O is not a thread pool. E8, E11.
- [ ] Deadlock prevention implemented — **Partial**: Finite leases and durable CAS/journal operations exist; no live deadlock/contention study was performed. E8.
- [ ] Race condition prevention — **Partial**: Compare-and-swap claims, version guards and per-issue queue concurrency exist; this is not proof of all races eliminated. E8.
- [ ] Lock contention minimized — **Partial**: Per-issue serialization and optimistic claims are present; contention under representative concurrency is unmeasured. E8.
- [x] Async operations used appropriately — **Verified**: SDK/network calls are asynchronous and independent reads are parallelized in selected paths. E3, E5, E8.

### Code-Level Optimization

- [x] Hot path code optimized — **Verified**: The panel summary avoids tree/changelog/editmeta/value readers, with a passing boundary test. E5.
- [ ] Function call overhead minimized — **Unverified**: No CPU/function-overhead profile was supplied. E6, E7.
- [ ] Loop unrolling considered — **N/A**: No profile justifies manual loop unrolling in this JavaScript application. E7.
- [ ] Inlining opportunities identified — **Unverified**: No measured inlining opportunity or compiler-output study was supplied. E7, E12.
- [x] Compiler optimizations enabled — **Verified**: The production TypeScript/Vite build succeeds with default optimization and minification enabled. E12.
- [ ] Unnecessary type conversions removed — **Unverified**: No conversion-cost audit was performed; explicit binary/base64 conversions are required by the SQL wire representation. E1.
- [ ] String allocation minimized — **Unverified**: No string-allocation measurements were supplied. E7.

---

## Asset Optimization

### JavaScript Optimization

- [x] JavaScript minified — **Verified**: Fresh production output contains minified JavaScript. E12.
- [ ] JavaScript bundled efficiently — **Partial**: Lazy chunks are generated, but the shared ui chunk is 777.77 kB (210.98 kB gzip estimate) and triggers the build warning. E12.
- [ ] Unused JavaScript removed — **Partial**: Bundler dead-code elimination is enabled; no dependency/unused-code coverage audit proves all unused JavaScript removed. E12.
- [x] JavaScript size measured — **Verified**: Fresh build reports per-chunk raw and gzip-estimated sizes; see validation below. E12.
- [ ] Parse/compile time monitored — **Unverified**: No browser parse/compile-time trace was captured. E12.
- [ ] Execution time profiled — **Unverified**: No browser JavaScript execution profile was captured. E12.
- [x] Async/defer attributes used appropriately — **Verified**: HTML uses module scripts; production HTML includes generated modulepreload hints. E12.
- [x] Code splitting implemented — **Verified**: React.lazy screens and build chunk groups produce distinct panel/admin/review/test chunks. E12.
- [x] Tree shaking enabled — **Verified**: The production bundler's default dead-code elimination is enabled; this does not certify that every dependency is necessary. E12.

### CSS Optimization

- [x] CSS minified — **Verified**: Fresh production output contains minified CSS. E12.
- [ ] CSS bundled efficiently — **Partial**: CSS is extracted into three assets; route-level usage and render cost have not been measured. E12.
- [ ] Unused CSS removed (PurgeCSS/UnCSS) — **Open**: No PurgeCSS/UnCSS or equivalent verified unused-style audit was found. E12.
- [ ] CSS specificity optimized — **Unverified**: No systematic specificity audit was performed. E12.
- [ ] Selectors optimized for performance — **Unverified**: No selector matching/render-cost profile was supplied. E12.
- [ ] Media queries used appropriately — **Partial**: Responsive rules exist, including a 720px breakpoint; no device performance/visual run was performed. E12.
- [ ] Critical CSS inlined — **Open**: No critical-CSS extraction/inlining is configured in the reviewed build. E12.
- [ ] Fonts optimized (subsetting, loading strategy) — **Partial**: System font stacks avoid packaged font downloads; custom font subsetting is inapplicable. E12.

### Image Optimization

- [ ] Images compressed — **N/A**: No bundled raster image assets were found in frontend source/public. Jira evidence attachments are a separate workload. E12.
- [ ] Image formats optimized (WebP, AVIF) — **N/A**: No bundled raster assets require WebP/AVIF conversion in the reviewed UI. E12.
- [ ] Image sizes appropriate for display — **Unverified**: No rendered-image sizing audit was performed; local SVGs alone do not prove display sizing. E12.
- [ ] Responsive images served — **N/A**: No raster srcset/picture pipeline was found in the application UI. E12.
- [ ] Image lazy loading implemented — **N/A**: No application-owned raster image gallery/lazy-image pipeline was found; attachment evidence needs separate assessment. E12.
- [ ] SVG images optimized — **Unverified**: Two public SVG files exist, but no SVG optimization pass or measured reduction was found. E12.
- [ ] Image sprites considered — **Partial**: An icons.svg symbol file exists; actual runtime use and network benefit were not established. E12.
- [ ] Image CDN used — **N/A**: No separate image CDN is declared by the app. Forge static hosting remains platform-managed. E11, E12.

### Font Optimization

- [ ] Font file size minimized — **N/A**: No packaged font files were found; local system stacks avoid a font transfer. E12.
- [ ] Font subsetting used — **N/A**: No bundled webfont requires subsetting. E12.
- [ ] Font loading strategy optimized (font-display) — **N/A**: No @font-face/webfont request is configured in reviewed UI source; font-display does not apply to a system stack. E12.
- [ ] WOFF2 format used — **N/A**: No webfont asset is shipped by the app source/public inventory. E12.
- [x] Fallback fonts specified — **Verified**: System sans-serif and monospace stacks include fallback families. E12.
- [ ] Font preloading used (critical fonts) — **N/A**: There is no application webfont download to preload. E12.
- [x] Number of font families limited — **Verified**: The shared tokens define system sans-serif and monospace families. E12.

### Video Optimization

- [ ] Video compression optimized — **N/A**: No bundled video assets or video-player pipeline were found. E12.
- [ ] Multiple video formats provided — **N/A**: No application video-format variants are served. E12.
- [ ] Thumbnail images provided — **N/A**: No application video-thumbnail pipeline exists. E12.
- [ ] Video lazy loading used — **N/A**: No application video lazy-loading pipeline exists. E12.
- [ ] Autoplay considered (performance impact) — **N/A**: No application video autoplay behavior was found. E12.
- [ ] Progressive download vs. streaming evaluated — **N/A**: No application video delivery pipeline requires this choice. E12.

---

## API Performance

> **Re-verified in depth, 28 October 2026 (same assessment day, follow-up pass).** Every row below was re-derived from the current source — resolver definitions, the shared error envelope, all three queue consumers, the Jira retry-after parser, and a fresh test run — rather than carried over from the first pass. See `E15`.

### API Response Optimization

- [ ] Response size minimized — **Partial**: `panelSummary.getSummary` builds its payload as an explicit, hand-shaped object field-by-field (`src/usecases/panelSummary.js:307-384`) rather than forwarding the Jira issue, and test-management report readers truncate with a `LIMIT n+1` pattern (`src/testmgmt/reportStore.js:26-27`). But there is no response-byte budget anywhere, and `readIssueSummary`, `panelAccess.snapshot()` and others deliberately request `fields=*all` for drift correctness (`src/usecases/panelSummary.js:48`, `src/usecases/panelAccess.js:33`). E5, E10, E15.
- [ ] Response payload includes only needed data — **Partial**: The panel-summary hot path is carefully shaped (above); by contrast every test-management store (`src/testmgmt/store.js`, `reportStore.js`, `planningStore.js`, `sourceLinkStore.js`, `retestStore.js`) reads `SELECT *` and relies on the caller to project only what it needs, so minimality is enforced per-call-site, not by the query layer. No audit covers every resolver. E5, E10, E15.
- [ ] JSON formatting optimized — **Partial** (revised from Verified): Resolver/Jira/store serialization is compact everywhere else checked, but `tm:summary:generate`/`tm:summary:read` embed a genuinely pretty-printed JSON string inside that same compact envelope: `renderExecutionSummary` calls `JSON.stringify(..., null, 2)` to build the downloadable `.json` and `.html` content (`src/testmgmt/summary.js:12-15`), and `src/usecases/testSummary.js:76,101` returns that whole object under `downloads` in the ordinary resolver response — not as a separate file transfer. That is one concrete, reproducible counterexample to the earlier blanket "Verified," found by tracing `renderExecutionSummary`'s only two callers. E1, E4, E5, E15.
- [ ] Response compression enabled (gzip, brotli) — **Managed**: Forge transports resolver/static responses; no deployed Content-Encoding evidence was captured. E11.
- [ ] Response streaming used for large data — **Partial**: `vaultObjectStore.getContentRange` performs real HTTP Range reads with `Content-Range`/length validation and truncation detection (`src/lib/vaultObjectStore.js:72-103`); whole-object vault/attachment reads elsewhere still materialize full buffers, and no end-to-end chunked resolver response exists. E7, E15.
- [x] Pagination implemented — **Verified**: `queue.list`/`transitionItems` return a real `nextPageToken` (`src/usecases/queue.js:63-66,139-186`), and a fresh run of `test/queue.test.js` (16/16 passing, re-run 28 October 2026) directly exercises continuing a page from that token ("a page is filled from further searches…", "loading more continues the transition search and does not repeat the decisions"). Test-management report/decision readers instead fetch `LIMIT n+1` and expose only a `complete` boolean with no continuation token (`src/testmgmt/reportStore.js:26-27`) — truncation-aware, not paginated. Verified for the approval queue specifically; still not every endpoint. E5, E10, E15.
- [ ] Field filtering available — **Partial**: Several internal Jira reads explicitly request a narrow field list (`src/usecases/queue.js:193,217` — `fields: ['summary','status','project','issuetype']`; `src/usecases/evidence.js:18`; `src/usecases/harness.js:45`), but no resolver accepts a client-supplied field-selection parameter — every payload shape is fixed server-side per endpoint. E5, E8, E15.
- [ ] Sparse fieldsets available — **Open**: Confirmed by search — no resolver payload destructures a client `fields`/`select` parameter; the one `fields` match in the codebase (`src/usecases/panelAccess.js:55`) is `scopeFromIssue`'s internal drift-scoping concept, unrelated to a client-chosen sparse fieldset. E5, E10, E15.

### API Rate & Throttling

- [ ] API rate limiting configured — **Partial**: All three Forge consumer queues enforce per-issue concurrency limit 1 — `restore:${issueId}` (`src/lib/restore/queue.js:24`), `vault:${issueId}` (`src/lib/vaultQueue.js:34,55`), `link:${otherIssueId}` (`src/lib/linkQueue.js:18`) — and the approval queue bounds live Jira reads to `READ_CONCURRENCY = 5` (`src/usecases/queue.js:51,160-163`). None of this is a global or per-caller admission limiter: unlimited distinct issues still run concurrently, and neither the shared resolver wrapper (`src/lib/harnessLogger.js`) nor the request cache (`src/lib/cache.js`) implements one. E8, E15.
- [ ] Rate limit headers returned — **N/A**: Forge resolver invocations return a plain JSON value with no app-controlled HTTP header contract. Upstream `Retry-After` is read by the app for its own retry decisions (see below) but is never re-exposed to the resolver's caller. E8, E11.
- [ ] Throttling strategy fair — **Unverified**: The per-issue concurrency keys above serialize work per issue but give no cross-user or cross-tenant fairness guarantee, and no fairness test or admission policy was found. E8.
- [ ] Rate limit error responses clear — **Partial**: The bug-creation path is a strong, concrete example: `createIssueAsApp` parses Jira's `retry-after` response header into a normalized `retryAfterMs` (handling both a seconds value and an HTTP-date, `src/testmgmt/jira.js:111-116`), and `createWithThrottleRetry` retries at most twice and only while the delay is ≤5000ms (`src/testmgmt/bug.js:161-172`) before giving up with an explicit, auditable reason, `RATE_LIMITED_RETRY_EXHAUSTED` (`src/testmgmt/bug.js:113`). That is one well-built, traced path — the generic resolver error envelope used everywhere else (`src/usecases/access.js:33-40`) carries only `{ error, reason }`, with no rate-limit-specific shape, so this is not yet a uniform contract. E8, E15.
- [ ] Client backoff guidance provided — **Partial**: Every resolver built on `respond()`/`fail()` returns the identical `{ error, reason }` envelope (`src/usecases/access.js:13-40`) — a stable reason-code contract, but with no retry-timing field a client could act on. Real backoff delays exist only inside the three worker/retry paths above (restore, vault, link consumers; bug creation) and never reach the frontend. E8, E15.
- [x] Exponential backoff recommended — **Verified**: Three independent, bounded exponential-backoff implementations were read directly: product-event retries (`src/triggers/retry.js:13`, capped at 900s, with the `SCHEMA_PENDING` reason using a longer 120s base delay so 120+240+480+900s outlasts the five-minute migration window), the restore worker (`src/jobs/restoreWorker.js:357`, capped at 60s), and the vault worker (`src/jobs/vaultWorker.js:64`, capped at 60s, retry count clamped to 4). E8, E15.

### API Versioning & Deprecation

- [ ] API versioning strategy clear — **Partial**: The database schema is version-sequenced and append-only (`src/db/migrations.js`, ids `v001` through `v143`), but resolver action names (`panel:getSummary`, `tm:summary:generate`, …) carry no version token anywhere, and no written compatibility/versioning policy exists for the resolver contract itself. E2, E5, E15.
- [ ] Old API versions deprecated properly — **Partial**: `manifest.yml:116-126` keeps the retired `va-device-approval-field` custom-field module registered, with an explicit comment instructing "Remove this field from transition screens," rather than deleting it outright — so existing receipts and screens that still carry it keep working. That is one concrete, well-documented retirement; it is not a full inventory of every deprecated surface. E11, E15.
- [ ] Deprecation timeline communicated — **Open**: Confirmed — no sunset date, version-support window, or deprecation calendar exists anywhere in the manifest or reviewed documents. E11.
- [ ] Migration path documented — **Partial**: The same manifest comment gives an explicit swap instruction for the retired field, and `src/db/migrations.js` is a readable, ordered schema history; neither adds up to a general migration guide for resolver/API consumers. E2, E11, E15.
- [ ] Breaking changes minimized — **Partial**: `readBaselineTree` in `src/db/baselineTreeStore.js:213-224` is concrete, working compatibility logic, not a vague claim: it tries a 3-tier query (tier 2 — `COALESCE(n.link_policy, b.link_policy)`; tier 1 — the pre-migration column location; tier 0 — neither), catching "unknown column" errors to step down a tier, so a baseline tree recorded under an older schema still reads correctly today without a migration having run first. This is real, demonstrated schema compatibility — but it is one mechanism found by tracing one store, not a published contract or an assessment covering every store. E1, E2, E15.

---

## Frontend Performance

### Critical Rendering Path

- [ ] Critical resources identified — **Partial**: Entry/shared/route resources are visible in the build; no browser critical-path waterfall was captured. E12.
- [ ] Resource priority configured — **Partial**: Vite generates modulepreload links; no measured priority tuning for deployed Jira iframe loads. E12.
- [ ] DNS prefetch used — **N/A**: No additional external content origin requiring DNS-prefetch is declared by the UI code reviewed. E11, E12.
- [ ] Preconnect used for critical origins — **N/A**: No measured external critical-origin handshake justifies adding a preconnect hint. E11, E12.
- [ ] Prefetch used for non-critical resources — **Open**: No explicit non-critical route prefetch policy was found. E12.
- [ ] Resource hints optimized — **Partial**: Default preload hints exist; no waterfall comparison establishes optimal hints. E12.
- [ ] Render-blocking resources minimized — **Partial**: Module scripts and lazy routes reduce initial work; shared CSS/UI cost still needs browser measurement. E12.
- [ ] First Contentful Paint (FCP) optimized — **Unverified**: No deployed FCP measurement or before/after result was supplied. E12.

### Core Web Vitals

- [ ] Largest Contentful Paint (LCP) < 2.5s — **Unverified**: No measured LCP distribution for Jira host/iframe; do not infer this from build duration. E12, E13.
- [ ] First Input Delay (FID) < 100ms — **N/A**: Legacy template metric: FID has been replaced by INP. Preserve this row for traceability; measure INP <= 200 ms at p75 instead. E13.
- [ ] Cumulative Layout Shift (CLS) < 0.1 — **Unverified**: No measured CLS distribution was supplied. E13.
- [ ] Core Web Vitals monitored — **Open**: No web-vitals/PerformanceObserver collection was found in the reviewed frontend. E12, E13.
- [ ] Performance metrics tracked over time — **Open**: No retained browser metric series or trend report was supplied. E6, E13.

### Page Load Optimization

- [ ] Page load time measured (real user monitoring) — **Open**: No real-user page-load collection was found in the reviewed frontend. E12.
- [ ] Initial page load optimized — **Partial**: Lazy screens and fast summary/detail separation are implemented; actual warm/cold page timings remain unmeasured. E5, E12.
- [ ] Time to Interactive (TTI) optimized — **Unverified**: No deployed interactivity trace or test result was supplied. E12.
- [ ] Page speed test scores reviewed — **Unverified**: No PageSpeed/WebPageTest result was supplied for this app. E12.
- [ ] Lighthouse audit scores reviewed — **Unverified**: No current Lighthouse report was supplied or run in this assessment. E12.
- [ ] Performance budgets defined — **Partial**: The design sets warm summary p95 <= 2 s, cold target <= 5 s and feedback <= 100 ms; these are goals, not measured acceptance or CI budgets. E5.

---

## Infrastructure Performance

### Server Configuration

- [ ] Web server optimized (nginx/Apache tuning) — **N/A**: No application-owned nginx/Apache server exists; Forge hosts the app. E11.
- [ ] Worker processes configured — **Managed**: Forge manages execution processes; the manifest declares consumer functions, not OS workers. E11.
- [ ] Buffer sizes optimized — **Managed**: No server/socket buffer tuning is exposed by app configuration. E11.
- [ ] Keepalive connections configured — **Managed**: No app-owned connection keepalive setting is declared. E11.
- [ ] Compression enabled — **Unverified**: Actual deployed transfer compression has not been inspected. Build gzip estimates are not server evidence. E11, E12.
- [ ] Caching headers configured — **Unverified**: Actual deployed cache headers have not been inspected. E11.
- [ ] Load balancing configured (if multiple servers) — **Managed**: Platform execution/hosting is managed; no app load-balancer configuration or load result was inspected. E11.

### Database Server

- [ ] Database server resources adequate — **Unverified**: No representative SQL workload, utilization/headroom sample or capacity result was supplied. E1.
- [ ] CPU utilization monitored — **Managed**: Database host CPU monitoring is outside this code; no tenant console evidence was inspected. E1.
- [ ] Memory utilization monitored — **Managed**: Database host memory monitoring is outside this code; no console evidence was inspected. E1.
- [ ] Disk I/O monitored — **Managed**: Database disk I/O telemetry is outside this code; no console evidence was inspected. E1.
- [ ] Database configuration tuned — **Managed**: No application-owned database server tuning settings. E1.
- [ ] Query cache configured (if applicable) — **N/A**: No configurable SQL server query-cache setting is used by this application; request memoization is separate. E1, E4.
- [ ] Buffer pool size optimized — **Managed**: No app-owned database buffer-pool setting. E1.

### Application Server

- [ ] Application server memory configured — **Partial**: Restore/vault workers declare 1024 MiB; other functions use platform defaults. No heap/headroom benchmark validates sizing. E7, E11.
- [ ] Heap size optimized — **Managed**: No explicit Node heap-size override or heap-sizing study. E11.
- [ ] Garbage collection tuned — **Managed**: No app GC configuration or profiling evidence. E11.
- [ ] Thread pool configured — **N/A**: No application server thread pool is declared. E11.
- [ ] Worker process count optimized — **Managed**: No OS worker count is configured; queue concurrency is a separate application control. E8, E11.
- [x] Timeout configurations reviewed — **Verified**: Restore/vault/link worker timeouts are declared at 600 s; scheduled sweeps and LLM calls have explicit budgets. This verifies reviewable bounds, not deadline success. E8, E11.

### Network Infrastructure

- [ ] Bandwidth adequate — **Unverified**: No deployed transfer-throughput or bandwidth-headroom measurement was supplied. E11.
- [ ] Latency acceptable — **Unverified**: No live warm/cold/regional latency sample was collected. E5.
- [ ] Network hops minimized — **Partial**: Batching, request memoization and summary separation reduce round trips; deployed network-hop optimization was not measured. E3, E4, E5.
- [ ] Geographic distribution optimized — **Managed**: Platform hosting geography is not tuned in this app; no regional comparison was run. E11.
- [ ] CDN configured — **Managed**: Forge hosts the declared static resource; no separate CDN configuration/acceptance evidence. E11.
- [ ] Network monitoring enabled — **Unverified**: No network timing collection, network alert or deployed waterfall was inspected. E11, E12.

---

## Monitoring & Measurement

### Performance Metrics

- [ ] Response time tracked (p50, p95, p99) — **Partial**: Resolver duration logs and harness P95 summaries exist; no p50/p99 service-level dashboard or retained live sample was verified. E6.
- [ ] Throughput measured (requests/second) — **Open**: No requests-per-second time series or accepted throughput measurement was supplied. E6.
- [ ] Error rate monitored — **Partial**: Errors/outcomes are logged and summarized; no verified error-rate threshold/alert configuration. E1, E6.
- [ ] Request size tracked — **Open**: No general request-byte instrumentation was found in reviewed wrappers. E1, E6.
- [ ] Response size tracked — **Open**: No general response-byte instrumentation was found in reviewed wrappers. E1, E6.
- [ ] Database query time measured — **Open**: The app SQL wrapper does not measure query duration. Forge offers SQL metrics, but tenant-console evidence was not inspected. E1.
- [ ] Cache hit rate tracked — **Open**: No hit/miss counters are implemented in the request memo cache. E4.
- [ ] API latency monitored — **Partial**: Resolvers record duration; downstream Jira/SQL latency is not separated consistently and live monitoring was not verified. E1, E6.

### Performance Dashboard

- [ ] Real-time performance dashboard created — **Partial**: A log watcher and CLI statistics exist; no dedicated real-time performance dashboard was supplied. E6.
- [ ] Key metrics displayed — **Partial**: CLI statistics show outcomes and duration summaries; no verified service-level metric dashboard. E6.
- [ ] Historical trends shown — **Open**: No retained performance trend dashboard was found. E6.
- [ ] Bottlenecks identified visually — **Open**: No flame-graph/waterfall/dashboard evidence of visual bottleneck identification was supplied. E6.
- [ ] Alerts configured for anomalies — **Open**: No performance anomaly rules, destinations or trigger test was supplied. Governance alerts are not performance alerting. E6.
- [ ] Performance reports generated — **Partial**: Harness can summarize supplied logs; this assessment supplies a local build/test report, not a live performance trend report. E6, E12.

### Profiling & Analysis

- [ ] Application profiling done regularly — **Unverified**: No recurring profiler runs or profile archive was supplied. E6.
- [ ] Database profiling done — **Unverified**: No SQL trace/plan/profile capture from a live installation was supplied. E1.
- [ ] Memory profiling done — **Unverified**: No heap profile or allocation trace was supplied. E7.
- [ ] CPU profiling done — **Unverified**: No CPU profile was supplied. E7.
- [ ] I/O profiling done — **Unverified**: No disk/network I/O profile was supplied. E6, E7.
- [ ] Flame graphs analyzed — **Unverified**: No flame graph was supplied or generated. E6.
- [ ] Hot spots identified — **Partial**: Source and tests identify repeated SQL/tree work and the build flags a large shared UI chunk; no deployed profiler ranks hot spots. E3, E5, E12.

### Performance Alerts

- [ ] High response time alert configured — **Open**: No latency alert threshold/destination/test evidence was supplied. E6.
- [ ] High error rate alert configured — **Open**: No error-rate alert threshold/destination/test evidence was supplied. E6.
- [ ] High CPU usage alert configured — **Managed**: Host CPU alerting is platform-owned; no customer-facing alert setup was verified. E11.
- [ ] High memory usage alert configured — **Managed**: Host memory alerting is platform-owned; no customer-facing alert setup was verified. E11.
- [ ] Database connection pool exhaustion alert — **N/A**: There is no app-owned connection pool to exhaust; SQL throttling/service-error alerts still need verification. E1.
- [ ] Cache eviction rate alert — **Open**: No cache-eviction alert exists in the reviewed cache code. E4.
- [ ] Slow query alert configured — **Open**: No per-query timing threshold or slow-query alert is implemented in the SQL wrapper. E1.

---

## Load Testing

### Load Test Preparation

- [ ] Load test plan documented — **Open**: Design documents call for scale/performance checks, but no executable workload plan with arrival rates, duration and acceptance thresholds was found. E5, E14.
- [ ] Test scenarios defined (happy path, edge cases) — **Partial**: Functional/failure fixtures cover panel loading, tree capture and retries; they are not realistic arrival-rate load scenarios. E3, E5, E8.
- [ ] Expected load estimated — **Open**: No tenant count, concurrent-user model, issue volume or requests-per-second forecast was supplied. E14.
- [ ] Peak load identified — **Open**: No peak-hour concurrency or burst estimate was supplied. E14.
- [ ] Load test duration determined — **Open**: No load-test duration is defined by an executable test plan. E14.
- [ ] Ramp-up strategy planned — **Open**: No arrival-rate/ramp-up schedule was found. E14.
- [ ] Test data prepared — **Partial**: The 120-node fixture and functional test data exist; no representative tenant-scale load dataset was validated. E3, E14.

### Load Test Execution

- [ ] Baseline load test run — **Unverified**: No baseline load run was executed or evidenced. The local unit run is not a load test. E14.
- [ ] Stress testing completed — **Unverified**: No stress run was executed or evidenced. E14.
- [ ] Spike testing completed — **Unverified**: No spike run was executed or evidenced. E14.
- [ ] Sustained load testing completed — **Unverified**: No sustained/soak run was executed or evidenced. E14.
- [ ] Load test from multiple geographic locations — **Unverified**: No multi-region run was executed or evidenced. E14.
- [ ] Load test captures various metrics — **Unverified**: No load-run latency/throughput/error/resource dataset was supplied. E14.
- [ ] Load test alerts trigger appropriately — **Unverified**: No alert-trigger test under load was supplied. E14.

### Load Test Analysis

- [ ] Load test results analyzed — **Unverified**: No load-run results exist in this assessment to analyze. E14.
- [ ] Performance degradation identified — **Unverified**: No degradation curve across load levels was measured. E14.
- [ ] Breaking point found — **Unverified**: No saturation or breaking-point experiment was supplied. E14.
- [ ] Bottlenecks identified — **Unverified**: No measured load-test bottleneck analysis was supplied. Structural code risks are listed separately. E14.
- [ ] Scaling limits documented — **Partial**: Platform SQL limits and application tree/file/batch bounds are known; measured user/throughput capacity remains unknown. E1, E3, E7.
- [x] Recommendations made — **Verified**: This assessment records concrete measurement and optimization follow-ups below, based on source/test/build evidence. They are not load-test findings. E14.
- [ ] Changes implemented based on results — **Unverified**: No changes based on measured load-test results are evidenced; this task changes documentation only. E14.

### Capacity Planning

- [ ] Current capacity documented — **Partial**: Configured limits are documented below; tested sustainable workload and headroom are not established. E1, E7, E11, E14.
- [ ] Growth projections estimated — **Open**: No issue/attachment/user growth forecast was supplied. E14.
- [ ] Scaling strategy planned — **Partial**: Batching and asynchronous consumers provide bounded execution; a quantified scaling plan against platform quotas is missing. E8, E14.
- [ ] Vertical vs. horizontal scaling evaluated — **N/A**: Forge infrastructure scaling is managed; application memory/concurrency choices still require measured capacity planning. E11, E14.
- [ ] Infrastructure costs estimated — **Open**: No workload-based compute/SQL/storage/LLM cost estimate was verified. E14.
- [ ] Scaling timeline established — **Open**: No growth-triggered scaling milestones or timeline was supplied. E14.

---

## Performance Regression Prevention

- [ ] Performance tests in CI/CD pipeline — **Partial**: npm test includes structural performance contracts and verify runs tests/build; no repository CI workflow or latency/size-budget gate was found. E3, E5, E12.
- [ ] Performance benchmarks established — **Partial**: Query-count contracts and fresh artifact sizes provide local structural baselines; no live latency/throughput benchmark. E3, E5, E12.
- [ ] Regression alerts configured — **Open**: The bundle-size warning is informational; no automated regression alert destination/threshold was found. E12.
- [ ] Performance reviews in code review process — **Unverified**: No enforced performance-review checklist or required review gate was found. E14.
- [ ] Performance tracking over time — **Open**: No longitudinal performance metric series was supplied. E6.
- [x] Documentation of performance changes — **Verified**: Capture batching, summary-reader boundaries and restore I/O reductions are documented; this checklist adds current evidence and gaps. E3, E5, E8.
- [ ] Root cause analysis for regressions — **Partial**: Tests document specific repeated-work regressions and the restore investigation records causes; no recurring performance incident/RCA process was verified. E3, E5, E8.

---

## Performance Optimization Wins

The following are structural implementation wins verified locally on 28 October 2026. They are not measured reductions in deployed response time.

### Optimization: Batched tree capture

- **Improvement:** The fixture with 120 nodes and one retained value per node uses 3 node INSERT statements plus 3 value INSERT statements and 1 metadata UPDATE. Compared with one insert per node/value (240), that is 6 inserts, a calculated 97.5% reduction in insert statement count.
- **Date:** Reverified 28 October 2026; original implementation date is not asserted.
- **Scope/technique:** `writeTreeCapture`, batches of 50 rows. E3.
- **Measurable impact:** The current statement count is asserted by a passing test. The 240-insert comparator is a calculated per-row model, not a historical tenant trace. No millisecond improvement is claimed.

### Optimization: Request-scoped read coalescing

- **Improvement:** Two same-key local reads in one invocation execute the factory once.
- **Date:** Reverified 28 October 2026.
- **Scope/technique:** `memo` stores the in-flight Promise inside AsyncLocalStorage. E4.
- **Measurable impact:** Local assertions confirm deduplication, a fresh value in a new invocation, rejected-entry eviction, and isolation between overlapping scopes. No cross-invocation cache hit rate or tenant SQL saving was measured.

### Optimization: Lightweight panel summary

- **Improvement:** The summary contract forbids tree, changelog, editmeta and retained-value readers and checks one issue read.
- **Date:** Reverified 28 October 2026.
- **Scope/technique:** Summary/detail separation with poisoned-reader regression fixtures. E5.
- **Measurable impact:** Contract tests pass; deployed p95/cold-start performance remains unmeasured. The deliberate `fields=*all` issue read is retained for drift correctness.

### Optimization: Evidence-keyed report and attachment reuse

- **Improvement:** Reports reuse evidence/model keys; unchanged baseline attachments can reuse an existing content-addressed object after an existence check.
- **Date:** Source reviewed 28 October 2026; restore investigation dated 27 October 2026.
- **Scope/technique:** `reportHashFor`, SQL report cache, vault reuse. E4, E8.
- **Measurable impact:** Existing code and the restore investigation support reduced repeat work. No fresh live I/O count or latency comparison was collected; restore workers were not retested in this assessment.

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
| E1 | `manifest.yml`; `src/lib/db.js`; `test/db-logging.test.js` (fresh pass). The wrapper calls `sql.prepare(...).bindParams(...).execute()`, logs redacted failures, and contains no success-duration instrumentation or application pool. [Forge SQL reference](https://developer.atlassian.com/platform/forge/storage-reference/sql/) checked 28 October 2026 confirms hosting, SQL limits and available console metrics; actual tenant configuration/usage was not inspected. |
| E2 | `src/db/migrations.js`, `src/db/configStore.js`, `src/db/itemStateStore.js`, `src/db/baselineTreeStore.js`, `src/db/driftStore.js`, `src/db/childBaselineStore.js`. Index definitions, lookup predicates, grouped/aggregate queries and row bounds were inspected; no EXPLAIN/cardinality/size output was obtained. |
| E3 | `src/db/baselineTreeStore.js`, constants `NODE_BATCH`/`VALUE_BATCH` and `writeTreeCapture`; `test/tree-storage.test.js`, especially the 120-node batching fixture (fresh pass). |
| E4 | `src/lib/cache.js`; memo consumers in `src/db/configStore.js`; `src/db/reportStore.js`; `src/lib/report.js` (`reportHashFor`). Four fresh standalone local assertion scenarios exercised request memo behavior. No full cache-consistency audit or same-request write/read test was run. |
| E5 | `src/usecases/panelSummary.js`, `src/usecases/queue.js`, `test/panel-performance-contract.test.js` (fresh pass). The existing design `docs/specs/2026-09-13-baseline-owned-recall-and-responsive-controls-design.md`, section 6, defines warm/cold/feedback objectives. Objectives are not acceptance results. |
| E6 | `src/lib/harnessLogger.js`, `scripts/harness.mjs`, `src/resolvers/{panel,admin,totp,testManagement}.js`, `test/harness.test.js` (fresh pass). Resolver wrappers log duration/outcome; CLI statistics compute min/average/P95/max from available events. No live log corpus, installed alert rules or dashboard was inspected. |
| E7 | `src/lib/tree/{model,jira,stableRead}.js`, `src/lib/vaultObjectStore.js`, `src/lib/valuestore.js`, `frontend/src/main.tsx`. Tree cap/queue/visited set, file/range caps, whole-buffer reads, synchronous gzip and lazy imports were inspected. No memory/CPU trace was collected. |
| E8 | `src/jobs/{runner,reconcile,restoreWorker,vaultWorker}.js`, `src/lib/restore/{queue,executor}.js`, `src/db/itemStateStore.js`, `src/lib/{interception,trackedFields,aiClassification,report}.js`, `src/triggers/retry.js`, `src/testmgmt/jira.js`. Existing `docs/acceptance/2026-10-27-restore-reliability.md` records earlier reliability work and remaining limits. These workers and retry paths were source-reviewed, not all freshly executed here. |
| E9 | `src/lib/retention.js`, `src/jobs/{prune,seal}.js`, `src/db/reportStore.js`. Retention policy and guarded archival logic are implemented; `prune.js` explicitly retains baseline values pending verified archival coverage. No tenant retention setup or archival run was accepted. |
| E10 | `src/testmgmt/{store,planningStore,retestStore,reportStore,sourceLinkStore,treeExclusion}.js`. SELECT *, joins, IN-based bulk readers, projections and bounded/truncated report results were inspected. No production query trace was collected. |
| E11 | `manifest.yml`, Forge SQL SDK architecture, main UI resource `frontend/dist`, and [Forge Custom UI hosting documentation](https://developer.atlassian.com/platform/forge/extend-ui-with-custom-options/) checked 28 October 2026. Platform ownership is an architecture classification; no SLA, physical deployment, cache-header, backup, CPU, memory, CDN or regional-performance guarantee is inferred. |
| E12 | `frontend/{package.json,vite.config.ts,index.html}`, `frontend/src/main.tsx`, `frontend/src/ui/tokens.css`, `frontend/public/{favicon,icons}.svg`, generated `frontend/dist` and fresh build output. No raster/font/video assets were found in the reviewed frontend source/public inventory. [Vite build options](https://vite.dev/config/build-options) and [build optimizations](https://vite.dev/guide/features#build-optimizations) checked 28 October 2026 support default minification, preload and chunk behavior. |
| E13 | [Web Vitals definitions and thresholds](https://web.dev/articles/vitals) and [INP replacing FID](https://web.dev/blog/inp-cwv-launch) checked 28 October 2026. Use LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1 at p75, segmented by device. Preserve the template's original wording while treating its FID row as obsolete. No browser metric was measured. |
| E14 | Workspace/package-script/test/document inventory: no dedicated k6/JMeter/Locust/Artillery harness, run dataset or repository CI configuration was found in reviewed files. Existing plans call for bounded-scale checks but do not prove execution. Follow-ups below are assessment recommendations, not a completed load test or permission to load the tenant. |
| E15 | Focused API Performance re-verification, 28 October 2026 (same day, follow-up pass): `src/usecases/access.js` (shared `{error, reason}` envelope), `src/usecases/queue.js` (pagination, bounded read concurrency), `src/testmgmt/{bug.js,jira.js,summary.js}` (throttled bug creation, Retry-After parsing, pretty-printed download JSON), `src/usecases/testSummary.js`, `src/resolvers/{panel.js,testManagement.js}` (every resolver definition traced), `src/lib/{restore/queue.js,vaultQueue.js,linkQueue.js,vaultObjectStore.js}` (keyed queue concurrency, ranged downloads), `src/db/baselineTreeStore.js` (tiered column-fallback query), `src/triggers/retry.js`, `src/jobs/{restoreWorker.js,vaultWorker.js}` (exponential backoff), `manifest.yml` (retired field module). `node --test test/queue.test.js` (fresh, 16/16 passing) and a fresh rerun of `test/panel-performance-contract.test.js` (35/35 passing) were executed directly in this pass. |

## Fresh local verification

Assessment date: **28 October 2026**, Asia/Kolkata. Repository commit: `5554807c3647531c02e80c9d903bf0fcc329a54a`. The existing untracked database checklist was present before this assessment; no product source was changed.

| Check | Result | What it proves |
| --- | --- | --- |
| `node --test test/panel-performance-contract.test.js test/tree-storage.test.js test/harness.test.js test/db-logging.test.js` | Exit 0; **80 passed, 0 failed, 0 skipped** | Selected local structural, storage and logging behavior. Fixture timing is not production latency. |
| Standalone assertions importing `src/lib/cache.js` | Exit 0; **4 scenarios passed** | Same-invocation factory deduplication; fresh invocation; failed-entry eviction; overlapping-scope isolation. |
| `npm run build:ui` | Exit 0; TypeScript and Vite production build passed | Current source compiles and produces assets. Does not prove deployed page speed. |
| Largest shared JS chunk | `ui-BHu8FW-r.js`: **777.77 kB**, gzip estimate **210.98 kB** | Exceeds the default 500 kB minified chunk warning. Gzip is an estimate, not inspected transfer encoding. |
| Selected lazy chunks | TestPanel **71.61 kB**, admin **80.44 kB**, review **87.02 kB**, IssuePanel **23.31 kB** (raw build sizes) | Code splitting produces distinct resources; shared-dependency cost still applies. |
| CSS output | **28.77**, **31.76**, **36.80 kB** (raw build sizes) | CSS extraction/minification exists; unused CSS and render cost are unmeasured. |
| `node --test test/queue.test.js` (API Performance follow-up) | Exit 0; **16 passed, 0 failed** | Fresh confirmation of real pagination continuation (`nextPageToken`) in the approval queue, used as evidence for API Performance pagination. |

The full backend/UI test suites, live Forge metrics, browser profiler, Lighthouse, heap profiles, regional comparisons and tenant load tests were not run. Existing acceptance documents remain historical evidence rather than current live measurements.

## Known bounds and remaining work

Configured bounds are not sustainable-load capacity: tree reads cap at **500 nodes**, tree inserts batch **50 rows**, vault files cap at **250 MiB**, range downloads cap at **1 MiB**, and restore/vault workers declare **1024 MiB** and **600 s**. These do not establish concurrent-user capacity or attachment memory headroom.

Forge SQL currently documents **150 DML requests/s per install**, **1 MiB requests**, **4 MiB responses**, and query timeouts of **5 s SELECT / 10 s DML / 20 s DDL**. These are platform ceilings, not measured app throughput. Recheck [the SQL limits](https://developer.atlassian.com/platform/forge/storage-reference/sql/) when designing the workload.

1. Capture warm/cold panel and validator distributions on the intended tenant; record sample size, p50/p95/p99, errors and downstream SQL/Jira timing. Test the existing summary/feedback objectives separately from browser Web Vitals.
2. Inspect the generated dependency graph for the large shared UI chunk. Measure its initial-route transfer/parse cost before changing grouping; retain lazy screen boundaries and correctness checks.
3. Review SELECT * and unbounded project-listing paths with representative data and permitted execution-plan tools. Check missing/unused indexes from measured workloads rather than schema appearance.
4. Add privacy-preserving SQL duration and cache hit/miss/entry instrumentation if needed, then verify installed dashboards and alert delivery. Resolver duration logs alone do not attribute downstream costs.
5. Define an authorized staging load plan with expected/peak concurrency, issue/tree/attachment distributions, arrival rates, ramp/spike/soak durations and failure thresholds. Record SQL limits, memory, Jira throttling, backlog growth, retry amplification and workload-based costs.
6. Measure LCP/INP/CLS for the relevant Jira host and app iframe experience, documenting measurement boundaries. A local build and host PageSpeed score cannot substitute for this.

No percentage speedup, live readiness, unlimited scale or successful platform configuration is claimed without measurements. Completion of this document means every checklist row has been assessed, not that every performance requirement passes.
