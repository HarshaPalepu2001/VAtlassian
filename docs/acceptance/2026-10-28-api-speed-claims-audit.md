# API speed claims audit. 28 October 2026

**The API work contains real reductions in bytes and repeated reads, but no deployed API speedup has been established.** Compact JSON survives the audit. Broad claims about minimal responses, one-request panel summaries, complete caching and rate-limit handling need qualification.

This is a fresh local audit of `/Users/sriharsha/VAtlassian`, HEAD `b718ada843dce74015e8a3ca4f31a25407624743` plus the existing working-tree changes. The supplied `Perfromance.md` and the earlier adversarial audit were treated as claims to check, not operational instructions. No product source was changed by this audit. Other work changed the queue implementation during inspection; the successful final run verifies the newer continuation behavior. The old 200-item pagination failure must not be reported as a current result.

The checkout subsequently advanced to `3c0ead370ff2304436000f0cacd9bf65e6560454` during concurrent work. A final read-back confirmed all 14 recorded source hashes still match the measured snapshot, including the queue pagination change.

## Method and evidence

- **JSON timing:** nine alternating paired runs, 100,000 serializations per variant per run, 5,000 warm-up calls per variant. Report median, minimum and maximum, retain all raw samples, and consume output lengths. This measures local serialization only.
- **Payload size:** UTF-8 byte counts for synthetic summaries with 0, 1, 3, 30, 100 and 500 runs. Nine repeats establish deterministic output, not independent network samples. Compare both the JSON download and the full application response envelope.
- **API behavior:** actual usecases with injected Jira/storage adapters; nine repetitions of each targeted contract/counterexample. Count requests, peak in-flight reads and returned records. No simulated response times are presented as live timing.
- **Scope:** zero live Jira calls. There are no measured network RTTs, cold starts, tenant p50/p95/p99, compression headers, throughput, fairness or production capacity results. The earlier assumption of 20–50 ms SQL RTT is not independently established here.
- **Source stability:** the successful run hashes the selected production source before and after its measurements and rejects a changed snapshot. Source hashes, Node/CPU details and raw results are retained in [results.json](api-speed-audit-2026-10-28/results.json).

Reproduce from the repository root:

```sh
node scripts/audit-api-performance.mjs
```

The script imports current production functions and adapts existing local test fixtures. It performs no network access or deployment. In particular, its panel fixture uses the **real** `availableTransitions` helper; the ordinary panel performance fixture mocks that helper and therefore hides one network call.

## Results

| Claim or implied benefit | Fresh measurement | Verdict |
| --- | --- | --- |
| Compact summary JSON reduces response bytes; previous sample claimed 41% | Three-run fixture: download **5,212 → 2,884 bytes (44.7%)**; full response **14,066 → 11,529 bytes (18.0%)** | **Real byte reduction.** The old 41% is sample-specific and cannot be applied to the whole response. |
| Compact JSON makes the API substantially faster | Local serialization median **6.787 → 4.773 µs**, paired median **1.43×**; approximately **2.014 µs saved** | **Real local improvement.** No endpoint latency multiplier is established. |
| Lightweight panel summary is one Jira request | No-parent fixture: **3 calls**: issue, `/myself`, and `/issue/{key}/transitions?expand=transitions.fields` | **One root-field read, not one total call.** Ancestor checks can add further reads. |
| Bounded queue concurrency eliminates request overhead | 50 actionable candidates: **1 search + 50 live issue reads**, peak live-read concurrency **5** | **Real overlap and bounded concurrency.** Request volume remains proportional to candidates; no measured 5× endpoint improvement. |
| Request caching removes repeated reads | 30 same-key reads in one invocation call the factory **once**; a new invocation calls it again; 30 separate invocations call it **30 times** | **Real request-local coalescing.** Not a shared cross-invocation cache or a tenant hit-rate measurement. |
| Saved-summary read avoids repeated issue reads | 100 runs of one test plus one coverage row: **103 issue-adapter calls for only 2 distinct issue IDs** | **Repeated reads remain.** This endpoint does not apply the `requestReads` wrapper used by generation. |
| Pagination keeps the approval queue complete | Current source returns **200 decisions + a token**, then reaches decision **201** on continuation | **Verified for this current fixture.** The source still caps the fetched decision set at 2,000 and exposes an overflow flag; every page reloads the bounded set. |
| Rate-limit failures are clearly communicated | Candidate hydration returning 429 yields exactly **`{ items: [], nextPageToken: null }`**; shared wrappers discard status and retry timing | **Current counterexamples reproduced.** Empty output can hide temporarily unavailable work. |
| Bounded evidence chunks constitute streaming | Actual code returns buffered **192 KiB base64 chunks**; the browser retains chunks, assembles the full file and hashes it | **Real bounded backend reads.** Not one continuous stream or bounded total browser memory. |
| Backend retries provide client backoff guidance | Restore/vault delays **5, 10, 20, 40, 60 seconds**; resolver envelopes omit `status` and `retryAfterMs` | **Backend retry control is real.** Caller guidance remains absent. |

## JSON: distinguish download bytes, response bytes and transport bytes

The exact earlier 3,979 → 2,365-byte sample was not supplied as a reproducible fixture. The fresh fixture includes steps, a signature and non-ASCII text; changing its shape changes the percentage. Correctness was checked by exact equality with compact `JSON.stringify({ summaryId, digest, snapshot })`.

| Runs | Pretty JSON download | Compact JSON download | Full response with pretty download | Current full response | Full-response reduction |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 517 | 396 | 2,157 | 2,015 | 6.6% |
| 1 | 2,154 | 1,254 | 6,328 | 5,339 | 15.6% |
| 3 | 5,212 | 2,884 | 14,066 | 11,529 | 18.0% |
| 30 | 46,496 | 24,890 | 118,531 | 95,096 | 19.8% |
| 100 | 153,527 | 81,941 | 389,363 | 311,748 | 19.9% |
| 500 | 765,127 | 407,941 | 1,936,963 | 1,549,748 | 20.0% |

Bytes are before transport compression. Both execution-summary entry points return the structured snapshot, JSON download and HTML download together. For the three-run fixture, the complete response is **11,529 bytes**, versus **2,884 bytes** for the snapshot/digest/ID envelope alone. The smaller comparator deliberately lacks exports; it is not a feature-equivalent replacement or a measured optimization.

Local compression illustrates another boundary: for that fixture, gzip changes **2,060 → 1,930 bytes (6.3%)** and Brotli **1,639 → 1,528 bytes (6.8%)**. These are local compression experiments, not evidence of deployed Content-Encoding. Repeated synthetic run content compresses particularly well and must not be treated as a representative tenant compression ratio.

Local serialization results for the three-run fixture:

| Variant | Median | Minimum | Maximum |
| --- | ---: | ---: | ---: |
| Compact | 4.773 µs | 4.731 µs | 4.797 µs |
| Pretty | 6.787 µs | 6.732 µs | 6.854 µs |
| Paired pretty/compact ratio | 1.427× | 1.413× | 1.435× |

This times the changed JSON formatting step, not HTML rendering, source verification, hashing, SQL, permissions, resolver startup or network delivery. It cannot establish a 1.43× API speedup.

## Repeated reads are a stronger candidate than formatting

The actual `createTestSummary(...).read` function was exercised with a valid stored snapshot, repeated runs of the same test and one coverage row. Its issue-reader count is **N + 3**: execution context, one test read per run, then test and execution reads from coverage. The same three sizes with distinct tests provide a useful control:

| Runs | Issue calls, repeated test | Distinct IDs, repeated test | Issue calls, distinct tests | Distinct IDs, distinct tests |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 4 | 2 | 4 | 2 |
| 3 | 6 | 2 | 6 | 4 |
| 30 | 33 | 2 | 33 | 31 |
| 100 | 103 | 2 | 103 | 101 |

The production Jira issue adapter performs a request per call. These local adapter counts identify repeated work, not measured tenant calls or timings. The fixture also invokes source-resolution adapters twice per run with empty references; **those invocations are not additional HTTP requests**.

Generation already applies `requestReads`; saved-summary reading does not. The visible `ExecutionSummary` component calls generation, so this result is specifically about the registered saved-summary read endpoint, not a measurement of every initial summary screen. An optimization should evaluate request-scoped deduplication for identical viewer/issue reads while preserving fresh authorization on each invocation, source visibility, revocation behavior and independent signing checks.

## Current API checklist assessment

These classifications are scoped to reviewed source and the local evidence above, not a production pass. Versioning/deprecation entries are source/document assessments, not benchmarks.

| Original API control | Assessment |
| --- | --- |
| Response size minimized | Partial: all three summary representations are returned together; no response budget. |
| Response payload includes only needed data | Partial: exports are consumed, but no complete consumer/payload minimality audit. |
| JSON formatting optimized | Verified for ordinary summary JSON; the registered diagnostic probe still pretty-prints JSON. |
| Response compression enabled | Managed/unverified deployment behavior; local gzip experiments do not verify delivery. |
| Response streaming used for large data | Partial: buffered range chunks and full browser assembly. |
| Pagination implemented | Partial: current decision-201 fixture passes; bounded 2,000-decision scan and other truncated readers remain. |
| Field filtering available | Partial: internal adapter field lists exist; no general client-selected field list. |
| Sparse fieldsets available | Open in reviewed contracts. |
| API rate limiting configured | Partial: per-issue queue concurrency and five-way hydration are concurrency controls. |
| Rate limit headers returned | N/A to the resolver data contract; probe HTTP responses are a separate surface. |
| Throttling strategy fair | Unverified; no fairness workload was measured. |
| Rate limit error responses clear | Partial: queue hydration 429 can disappear into an empty success. |
| Client backoff guidance provided | Open: shared envelopes omit retry metadata. |
| Exponential backoff recommended | Verified for bounded backend retry behavior; caller guidance is separate. |
| API versioning strategy clear | Open: no resolver compatibility/support-window policy found in reviewed material. |
| Old API versions deprecated properly | Partial: the manifest retains retirement instructions for one custom-field surface. |
| Deprecation timeline communicated | Open in reviewed material. |
| Migration path documented | Partial: schema migrations and retired-field replacement instructions exist. |
| Breaking changes minimized | Partial: schema fallback exists; complete resolver compatibility acceptance is absent. |

## Verification and limits

- [Regression log](api-speed-audit-2026-10-28/regression-tests.log): **172 tests passed**, zero failures or skips, across queue, panel, event retry, restore/vault worker, Object Store ranges, summary, evidence retrieval and hardening suites. This is local functional verification, not a build or load test.
- [Targeted audit log](api-speed-audit-2026-10-28/counterexamples.log): **5 tests passed**, nine repetitions each. Passing includes reproducing the documented failure behavior; it is not an assertion those behaviors are desirable.
- [Worker/evidence log](api-speed-audit-2026-10-28/worker-delay-and-evidence.log): **43 tests passed**, including explicit restore/vault delay assertions against actual workers and evidence revocation checks. The worker fixtures were adapted under `/private/tmp/vat-api-audit/`. Most worker coverage overlaps the regression set; do not sum the logs into a unique-test total.
- [Audit script](../../scripts/audit-api-performance.mjs) and [raw measurements](api-speed-audit-2026-10-28/results.json) retain the new timing/byte/count methodology. No third-party review service was used.

Prioritize correctly surfacing throttling and incomplete results, measuring and deduplicating confirmed repeated presentation reads, and measuring actual response/critical-path costs. Consider export-on-demand only with a consumer design that preserves both exports and their permission/evidence checks. Keep compact JSON as a correctness/code-quality and byte-reduction win. Leave API speed, throughput, p95/cold-start and production-readiness claims unverified until measured on the intended deployment.
