# API performance checklist adversarial audit — 28 October 2026

The updated checklist was treated as a set of claims to falsify. **Two API checkmarks remain justified within a narrow local scope: compact summary JSON and bounded backend exponential retries. Pagination is incomplete even within the approval queue. Client retry guidance and a resolver compatibility/versioning policy are open gaps.** No live API performance pass is established.

Scope: all 19 rows in the API Performance section, source review, existing local tests and isolated counterexample fixtures. Reviewed source at `b718ada843dce74015e8a3ca4f31a25407624743` plus the existing working-tree changes. Source files were changing during the initial inspection; the final API-relevant file hashes were checked for stability. No product code was changed by this audit. Other checklist sections and their newly added optimization claims were not re-audited.

## Findings

### Pending decisions stop at 200 without continuation

`awaitingDecision` defaults to `limit = 200` and issues `ORDER BY last_drift_at ASC LIMIT 200` (`src/db/itemStateStore.js`, function `awaitingDecision`). `queue.list` never passes an offset or cursor for that list and includes decisions only on the first page (`src/usecases/queue.js`, functions `list` and `decisionsFor`). Its `nextPageToken` belongs to the separate Jira transition search.

**Local counterexample:** the actual store function was run with a SQL adapter enforcing the literal LIMIT against 201 eligible pending records, then connected to the existing queue fixture. It returned 200 decisions and `nextPageToken: null`; the 201st record was absent. Supplying a transition token manually returned no decisions. The fixture establishes the application behavior under those inputs; it is not a live tenant reproduction.

The existing pagination test correctly proves transition continuation and that decisions do not repeat. It does not prove that every pending decision is reachable. An unchanged oldest set can keep newer pending decisions outside the visible queue. **Checklist correction: Pagination implemented → Partial.** Transition pagination remains credited.

### An upstream 429 can look like a successful empty queue

`liveActions` returns `null` for every non-OK issue response and for thrown reads (`src/usecases/queue.js`, function `liveActions`). A denied/unavailable candidate can therefore disappear from the result. Hiding an item the viewer cannot browse is appropriate; silently treating transient throttling as a complete empty result is a separate failure.

**Local counterexample:** Jira search returned one eligible candidate, then the candidate's live issue read returned status 429 with `Retry-After: 3`. The resolver returned exactly `{ items: [], nextPageToken: null }`, without an error, retry hint or incomplete-result flag. A caller cannot tell that work was hidden by throttling. This contradicts a uniformly clear rate-limit response, even though the bug-creation retry path is real. **Rate limit error responses clear remains Partial**, with this concrete gap recorded.

### Server retries do not provide client backoff guidance

The actual `respond` and `tmRespond` functions were given an error with `{ status: 429, retryAfterMs: 3000 }`. The generic result contained reason `ERROR`; test management used `SERVICE_UNAVAILABLE`. Both omitted the status and retry timing (`src/usecases/access.js`, `respond`; `src/testmgmt/messages.js`, `tmRespond`). The reviewed frontend has no corresponding retry-timing contract.

Finite worker retries are a different control. They do not tell a resolver caller when it may retry. **Checklist correction: Client backoff guidance provided → Open.** A future fix should distinguish transient failures while preserving permission filtering and avoiding unsafe automatic replay of mutations.

### Schema versions do not establish an API versioning policy

Ordered SQL migrations, versioned evidence and retained custom-field modules are useful compatibility mechanisms. They do not specify resolver contract guarantees, supported client versions, breaking-change handling or a support window. No such resolver policy was found in the reviewed material. A version token in an action name is not mandatory; an explicit compatibility strategy is what is missing. **Checklist correction: API versioning strategy clear → Open.** Other migration/retirement controls remain credited as Partial.

## Claims that survived challenge

- **Compact summary JSON:** the current `renderExecutionSummary` JSON download equals compact `JSON.stringify({ summaryId, digest, snapshot })`. Its earlier pretty-print issue has been fixed. Human-readable HTML intentionally retains formatted text. The temporary probe also pretty-prints JSON and is still declared in the manifest; a comment saying “temporary” does not prove absence from an installed environment. Verified is scoped to the ordinary application summary JSON, not every HTTP response. The historical 3979 → 2365-byte/41% figure in E17 was not independently reproduced here and remains that earlier sample's claim.
- **Backend exponential retries:** executing the actual restore and vault workers at retry counts 0–4 produced delays of **5, 10, 20, 40, 60 seconds** for each. Existing tests also verify retry exhaustion. Product-event schema-pending retry tests passed. This supports a checked backend retry control; it does not establish client guidance, fairness, jitter or live delivery latency.
- **Bounded range retrieval:** range validation and the app evidence chunk protocol exist and pass local checks. They do not establish a single continuously streamed HTTP response or bounded browser memory for the assembled file. Partial remains appropriate.
- **Response shaping and selected field lists:** these exist. Upstream `SELECT *` and Jira `fields=*all` do not by themselves prove an oversized resolver response; query volume and returned payload must be assessed separately.

## Remaining evidence gaps

Both summary entry points return the structured snapshot and prebuilt JSON/HTML downloads together (`src/usecases/testSummary.js`, functions `generate` and `read`). A synthetic one-run fixture produced an 8,424-byte compact response with downloads versus 1,893 bytes for its snapshot-only counterpart. This demonstrates duplicated representation in that fixture, not a production speedup or a recommendation to remove required export functionality. No response-byte acceptance budget or deployed compression capture was established.

Concurrency limits of one per issue and five concurrent queue issue reads are genuine controls. They neither implement a global/per-caller admission rate limit nor prove fairness. The platform can still impose its own limits; “unlimited distinct issues” was an overstatement in the prior explanation.

HTTP rate-limit headers remain N/A for the Forge resolver JSON contract specifically. The registered probe does have an HTTP header surface and returns only Content-Type in the reviewed helper; it must be considered separately if retained. No live header capture was made. N/A does not certify rate-limit headers across every entry point.

## Local verification

| Check | Result | Scope |
| --- | --- | --- |
| Seven existing files: queue, panel performance, event retries, restore worker, vault worker, object ranges, coverage/summary | **144 passed, 0 failed** | Local behavior; not a load test. |
| Isolated adversarial fixtures | **4 passed, 0 failed** | Confirmed decision cap, swallowed 429, dropped retry metadata and the current compact JSON/download representation. Passing means the described counterexample or narrowly scoped claim was reproduced. |
| Existing schema-pending, Jira-hardening, test-management-hardening and evidence-range suites, plus isolated copies of the restore/vault suites with delay assertions | **62 passed, 0 failed** | Includes two added worker-delay assertions. Some existing worker tests overlap the 144-test run; these counts must not be added into a unique-test total. |

Temporary reproduction scripts and logs were written under `/private/tmp/vat-api-audit/`. They adapt the existing fixtures and call actual production functions with injected dependencies; they make no Jira requests. No deployment, tenant changes, browser performance test, load test or third-party review service was used.

The checklist explanations and totals were updated without changing product source. The Downloads source copy is synchronized separately after verifying the final document.
