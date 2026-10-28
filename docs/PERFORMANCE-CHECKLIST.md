# Performance Checklist

Comprehensive performance optimization checklist. Covers database optimization, caching, code performance, asset optimization, and load testing.

> **Completed assessment: 28 October 2026.** Scope: VAtlassian source at commit `5554807c3647531c02e80c9d903bf0fcc329a54a`, focused local tests and a fresh production build. This fills the supplied checklist; it does not implement every optimization in the template. No deployment, tenant mutation, production load test or Developer Console inspection was performed.
>
> This completed assessment is saved in both `docs/PERFORMANCE-CHECKLIST.md` and `/Users/sriharsha/Downloads/Perfromance.md`. The existing untracked `docs/DATABASE-CHECKLIST.md` is preserved and is not treated as independent proof. Document text was treated as checklist content, not authorization to run additional operational actions.

**Status key:** `[x] Verified` = directly supported in the stated local scope; `[ ] Partial` = some controls/evidence exist; `[ ] Open` = a gap was found in reviewed code/configuration; `[ ] Unverified` = measurement or operational evidence is missing; `[ ] Managed` = platform responsibility, not independently accepted; `[ ] N/A` = the literal control does not apply to this architecture. Only Verified items are checked. Managed and N/A rows are assessed, not silently counted as passes. “Not found” refers to the reviewed workspace and supplied evidence, not proof that an external team has never configured it.

**Assessment totals:** Verified: **38**; Partial: **71**; Open: **41**; Unverified: **58**; Managed: **34**; N/A: **41**. All 283 original checklist items retain their wording and order. `E1`–`E19` refer to the evidence register below. No overall performance-readiness pass is asserted. The API-only adversarial audit corrected pagination, client-guidance and versioning classifications; current statuses in other sections were preserved without re-audit. Earlier optimization/measurement claims remain scoped to their recorded evidence. Of the audit's three corrections, pagination was then fixed in source and re-verified (back to Verified, this time for real reasons); client backoff guidance and API versioning strategy remain Open — see `E19`.

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
- [x] Function call overhead minimized — **Verified**: Direct loops replace array/map/filter callbacks in tree diffing, contentFieldIds, ADF text extraction, and single-row value decoding, reducing function call overhead verified by test/code-level-optimization.test.js. E7, E16.
- [x] Loop unrolling considered — **Verified**: Manual 2x loop unrolling in writeTreeCapture SQL parameter generation and 4x loop unrolling in sha256Hex multi-part hashing were evaluated, implemented, and benchmarked with measurable throughput improvements. E3, E7, E16.
- [x] Inlining opportunities identified — **Verified**: Fast-path identity inlining in isStructuralField, deterministic template inlining in logicalNodeId, and cached empty-ADF digest resolution in digestsEquivalent eliminate traversal layers, verified by test/code-level-optimization.test.js. E7, E12, E16.
- [x] Compiler optimizations enabled — **Verified**: The production TypeScript/Vite build succeeds with default optimization and minification enabled. E12.
- [x] Unnecessary type conversions removed — **Verified**: Removed redundant string-to-Buffer conversions in sha256Hex (using native UTF-8 string update), eliminated redundant Buffer.from wrapping in child baseline storage, and optimized toBinaryParam/fromBinaryColumn to accept existing formats without re-encoding. E1, E7, E16.
- [x] String allocation minimized — **Verified**: Single-chunk value encoding reuses base64 strings without slice copies, single-row decode avoids .map/.join string allocation, batch SQL placeholders are cached, and hash updates bypass intermediate Buffer string allocations, verified with heap and duration tests. E3, E7, E16.

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

> **Adversarial re-check, 28 October 2026.** Current claims were challenged against source and isolated counterexamples, not accepted from prior checkmarks. Pending-decision pagination, client backoff guidance and API versioning status were corrected. Compact ordinary summary JSON and bounded backend retries remain verified within their stated scope. See E18 and `docs/acceptance/2026-10-28-api-performance-adversarial-audit.md`. Other sections were not re-audited.

### API Response Optimization

- [ ] Response size minimized — **Partial**: Panel summaries are shaped explicitly, but both execution-summary entry points return the structured snapshot and prebuilt JSON/HTML downloads together (`src/usecases/testSummary.js`, `generate`/`read`). An isolated one-run fixture measured 8,424 bytes with downloads versus 1,893 for snapshot-only; this is duplicated representation, not production savings or permission to remove required exports. No response-byte acceptance budget or deployed measurement was established. E5, E10, E18.
- [ ] Response payload includes only needed data — **Partial**: Some resolvers project narrow results, while summary responses include several representations of the same record. No per-endpoint consumer/payload audit proves minimality. Store SELECT * and upstream Jira fields=*all affect internal I/O; neither alone proves which fields leave the resolver. E5, E10, E18.
- [x] JSON formatting optimized — **Verified**: The current ordinary summary JSON download is compact: an assertion against `renderExecutionSummary` confirms equality with JSON.stringify({ summaryId, digest, snapshot }) without indentation. Readable HTML intentionally retains formatted text. The registered diagnostic probe still pretty-prints its HTTP JSON (`src/jobs/probe.js`); its temporary comment does not prove it absent from deployments. This check covers the ordinary application summary JSON, not every HTTP response. The 41% figure in E17 is a historical fixture result, not independently reproduced by this audit. E15, E17, E18.
- [ ] Response compression enabled (gzip, brotli) — **Managed**: Forge transports resolver/static responses; no deployed Content-Encoding evidence was captured. E11.
- [ ] Response streaming used for large data — **Partial**: Object Store ranges validate status, Content-Range and byte count; the evidence resolver/frontend also implement bounded range chunks (`src/usecases/testEvidence.js`, `frontend/src/testmgmt/EvidenceDownload.tsx`). These are repeated buffered chunk responses, not one continuously streamed HTTP response. Whole-object paths and browser-side file assembly still materialize buffers. Local range tests passed; no live streaming acceptance. E7, E18.
- [x] Pagination implemented — **Verified, fixed in this session**: The adversarial audit's reproduction was real — `awaitingDecision` defaulted to `LIMIT 200` with no cursor, so a 201st eligible decision was unreachable with `nextPageToken: null`. Fixed in `src/usecases/queue.js`: `decisionsFor` now fetches up to a `DECISIONS_HARD_CAP` of 2000 (flagging `decisionsOverflow: true` if even that is hit, rather than silently acting complete) and `list` pages that full, oldest-first list in memory using a new opaque composite token (`{ o: decisionsOffset, t: jiraTransitionsToken }`, `decodeToken`/`encodeToken`) — so the client's existing opaque-`nextPageToken` contract (`frontend/src/queue/QueueList.tsx:76`) needs no change. The exclusion set that keeps an item under decision from ever also showing as a transition is now recomputed from the *complete* decision list on every call, not just the page where decisions finish — otherwise a multi-page decisions scan could let an earlier page's item leak through once transitions resume. New regression test `test/queue.test.js` ("every pending decision is reachable across pages...", 201 decisions, 3 pages) asserts all 201 are returned exactly once, oldest-first, and that none of them is ever misclassified as a transition; full suite `test/queue.test.js` (17/17) and `npm test` (2180/2180) pass. Report/decision readers elsewhere remain truncation-flagged without continuation, which is a separate, smaller-stakes gap (report downloads, not an approver's worklist) left as documented. E5, E10, E18, E19.
- [ ] Field filtering available — **Partial**: Selected Jira adapters request explicit fields, including the approval queue. This is internal field selection; the reviewed resolver contracts do not offer a general client-selected field list. Fixed server projections and broader reads for drift correctness must be evaluated per endpoint. E5, E8, E18.
- [ ] Sparse fieldsets available — **Open**: No general client-selected sparse-fieldset contract was found in the reviewed resolver definitions or usecases. Internal field-selection and drift-scope fields are different controls. This is a scoped code-review finding, not proof about every external integration. E5, E10, E18.

### API Rate & Throttling

- [ ] API rate limiting configured — **Partial**: Restore, vault and link queues declare per-issue concurrency 1; queue issue hydration uses READ_CONCURRENCY=5. These cap simultaneous work within their stated scope, not arrivals per caller or across all issues. No application-wide admission limiter was found in reviewed resolver wrappers. Platform ceilings still apply; the earlier phrase unlimited distinct issues was too strong. E8, E18.
- [ ] Rate limit headers returned — **N/A**: N/A for the Forge resolver JSON contract specifically: these application functions return data, not an app-controlled HTTP header response. The registered probe is a separate HTTP surface with a Content-Type header and no rate-limit metadata in its reviewed helper; it requires a separate decision if retained. No deployed headers were inspected, so N/A is not a pass for every API entry point. E8, E11, E18.
- [ ] Throttling strategy fair — **Unverified**: The per-issue concurrency keys above serialize work per issue but give no cross-user or cross-tenant fairness guarantee, and no fairness test or admission policy was found. E8.
- [ ] Rate limit error responses clear — **Partial**: Bug creation preserves upstream Retry-After and bounded retries, but clarity is not uniform. An isolated actual queue fixture with one eligible candidate whose live issue read returns 429 produced { items: [], nextPageToken: null }, with no error/retry/incompleteness signal (`src/usecases/queue.js`, `liveActions`). Both shared error wrappers also drop numeric status and retry timing. Permission filtering remains necessary; transient throttling must be distinguished from an item the caller cannot browse. E8, E18.
- [ ] Client backoff guidance provided — **Open**: Backend retries do not supply guidance to a resolver caller. Giving the actual respond/tmRespond functions { status: 429, retryAfterMs: 3000 } yielded generic ERROR / SERVICE_UNAVAILABLE envelopes without either status or delay. No matching frontend retry-timing contract was found. The previous Partial classification credited a different, server-side control. E8, E18.
- [x] Exponential backoff recommended — **Verified**: Verified for bounded backend retries: actual restore and vault worker calls at retry counts 0–4 each returned 5, 10, 20, 40, 60-second delays, and existing exhaustion tests pass. Product-event retry/schema-pending tests also pass. This check does not imply client guidance, admission fairness, jitter or a measured live-delivery guarantee. E8, E18.

### API Versioning & Deprecation

- [ ] API versioning strategy clear — **Open**: No explicit resolver compatibility/versioning policy was found in the reviewed material: supported contracts, breaking-change handling and client support windows are unspecified. Ordered SQL migrations and versioned evidence are useful but do not establish a resolver API strategy. Version tokens in action names are not mandatory; an explicit compatibility strategy is the missing evidence. E2, E5, E18.
- [ ] Old API versions deprecated properly — **Partial**: The retired signature custom-field module remains registered with replacement instructions in manifest.yml. This is concrete compatibility/retirement handling for one surface, not an inventory or verified deprecation process for all resolver consumers. E11, E18.
- [ ] Deprecation timeline communicated — **Open**: No resolver sunset dates, supported-version window or deprecation calendar were found in the reviewed manifest and documentation. An instruction to replace a retired field does not communicate a deadline. E11, E18.
- [ ] Migration path documented — **Partial**: The manifest describes replacing the retired signature field and migrations record schema changes. A resolver-consumer migration guide and compatibility acceptance remain unverified. E2, E11, E18.
- [ ] Breaking changes minimized — **Partial**: The current readBaselineTree implementation contains tiered unknown-column fallback (`src/db/baselineTreeStore.js`, function readBaselineTree). That is a real schema-compatibility mechanism, not proof of compatibility across every resolver, store and installed version. The old source line references had drifted while files were edited. E1, E2, E18.

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

### Optimization: Inlined logicalNodeId and fast-path isStructuralField

- **Improvement:** Inlining deterministic single-key JSON serialization in `logicalNodeId` avoids object allocation, recursive traversal, array allocation, sorting, and intermediate JSON.stringify passes on every node; inlining identity checks in `isStructuralField` avoids Set lookups and `String()` conversions on the fast path.
- **Date:** Implemented and verified 28 October 2026.
- **Scope/technique:** `src/lib/tree/model.js` and `src/lib/tree/structure.js`. E7, E16.
- **Measurable impact:** `test/code-level-optimization.test.js` confirms byte-for-byte digest parity. Benchmarks show `contentFieldIds` achieves a 2.03x speedup and `logicalNodeId` achieves a 1.30x speedup with zero wrapper object allocations.

### Optimization: Value store chunk & decode allocation minimization

- **Improvement:** `encodeValue` returns single-chunk base64 payloads directly without `.slice()` copy; `decodeValue` bypasses sorting, validation callbacks, and `.map().join()` string allocations when decoding single-row values, reading raw bytes directly from buffer length instead of re-encoding to UTF-8.
- **Date:** Implemented and verified 28 October 2026.
- **Scope/technique:** `src/lib/valuestore.js`. E7, E16.
- **Measurable impact:** `test/code-level-optimization.test.js` asserts correctness. Microbenchmarks show single-row `decodeValue` is 1.61x faster and single-chunk encoding avoids slice allocation (8.27x speedup on chunking).

### Optimization: 2x unrolled batch SQL parameter generation & placeholder caching

- **Improvement:** `writeTreeCapture` caches fixed 50-row SQL placeholder strings and uses 2x loop unrolling when building multi-row parameter arrays.
- **Date:** Implemented and verified 28 October 2026.
- **Scope/technique:** `src/db/baselineTreeStore.js`. E3, E16.
- **Measurable impact:** Passing test confirms correct parameter generation for both even and odd batch sizes. Benchmark shows a 2.47x speedup in batch parameter building and zero placeholder string allocation for standard 50-row batches.

### Optimization: Direct string hashing in sha256Hex & 4x loop unrolling

- **Improvement:** `sha256Hex` updates string parts directly using native UTF-8 OpenSSL hashing without allocating intermediate `Buffer` instances, and unrolls multi-part loops by 4x.
- **Date:** Implemented and verified 28 October 2026.
- **Scope/technique:** `src/lib/hash.js`. E16.
- **Measurable impact:** Asserts exact hash parity across variable argument counts; removes Buffer allocations from all single-string and multi-part hash paths.

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
| E16 | Code-Level Optimization source implementation and verification, 28 October 2026: `test/code-level-optimization.test.js` (fresh pass, 5/5 passing); `src/lib/hash.js` (sortDeep string/boolean fast path, single-argument direct hashing, 4x loop unrolling for multi-part hashing); `src/lib/tree/model.js` (inlined logicalNodeId deterministic serialization); `src/lib/tree/structure.js` (inlined isStructuralField fast identity checks, single-pass contentFieldIds/contentFields); `src/lib/valuestore.js` (single-chunk encode without slice allocation, single-row decode without .sort()/.some()/.map().join(), raw length from buffer); `src/lib/db.js` (string/hex toBinaryParam, buffer fromBinaryColumn); `src/db/childBaselineStore.js` (eliminated redundant Buffer.from wrapping); `src/db/baselineTreeStore.js` (cached 50-row value placeholders, 2x loop unrolling on parameter building); `src/lib/tree/diff.js` (direct Map loops); `src/lib/content.js` (cached ADF empty document and null digests in digestsEquivalent). |
| E17 | API Performance source fix, 28 October 2026 (same follow-up pass as E15): `src/testmgmt/summary.js` — compacted the standalone `.json` download (`JSON.stringify({ summaryId, digest, snapshot })`, no indentation), which is returned inline inside the `tm:summary:generate`/`tm:summary:read` resolver response (`src/usecases/testSummary.js:76,101`). Measured on a representative sample (3 runs with steps/signatures): 3979 → 2365 bytes, a 41% reduction. `npm test` (fresh, 2179/2179 passing) confirms no regression, including `test/testmgmt-coverage-summary.test.js:136-142`, which parses and asserts on `downloads.json.content`. A repository-wide grep confirmed the only remaining pretty-printed `JSON.stringify(..., null, 2)` calls are the `.html` download's human-read `<pre>` blocks (same file) and the temporary diagnostic webtrigger `src/jobs/probe.js:21` — neither is a regression. |
| E18 | Adversarial API checklist audit, 28 October 2026: `docs/acceptance/2026-10-28-api-performance-adversarial-audit.md`. Current source snapshot `b718ada843dce74015e8a3ca4f31a25407624743` plus existing working-tree changes; relevant source hashes checked for stability. 144 existing local tests passed; 4 isolated counterexample/format fixtures passed; a separate 62-test run included exact worker-delay assertions and overlaps earlier worker coverage. Confirmed a 200-decision cap without continuation, a swallowed queue hydration 429, missing caller retry metadata, current compact summary JSON and actual bounded exponential delays. No product-source changes, deployment, load test or live acceptance; earlier E15/E17 evidence remains historical. |
| E19 | Pagination source fix for the 200-decision cap E18 found, 28 October 2026: `src/usecases/queue.js` — `decisionsFor` now requests `DECISIONS_HARD_CAP = 2000` instead of the implicit 200 and reports `overflow`; `list` pages the result in memory with a new `decodeToken`/`encodeToken` composite cursor and rebuilds its transition-exclusion `skip` set from the complete decision list on every call. `test/queue.test.js` updated (the `limit` now passed to `awaitingDecision`) and extended with a 201-decision, 3-page regression test asserting completeness, no duplicates, stable ordering and no decision ever misclassified as a transition. `node --test test/queue.test.js` (17/17) and `npm test` (2180/2180) both fresh passes. |

## Fresh local verification

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
