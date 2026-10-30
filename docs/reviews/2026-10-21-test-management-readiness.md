# Test-management readiness assessment. 21 October 2026

> Historical audit baseline. These defects were subsequently addressed locally in the [manual-scope implementation follow-up](2026-10-21-test-management-implementation-ledger.md), which records current checks and remaining release boundaries. Reproductions below describe the original failures.

**Verdict: real Jira-native manual test-management code exists, but an unqualified released/customer-ready test-management announcement is premature.** The current state is an implemented development slice requiring reliability fixes and live acceptance. It is not yet a complete planning, execution, traceability and reporting product, nor validated for the automotive/medical use stated in the design.

This assessment reads the current working tree, including untracked implementation files. Older statements in the design and previous research saying that nothing is built are superseded by the code now present. No implementation, Jira configuration, signatures, issues, deployment or installation was changed during this assessment. The additions from this review are this report and its local reproduction artifacts.

## What is implemented

| Area | Current implementation | Evidence |
|---|---|---|
| Jira integration | Dedicated Test management issue panel, admin route and resolver | `manifest.yml`, `frontend/src/main.tsx`, `src/resolvers/testManagement.js`, `src/resolvers/admin.js` |
| Project configuration | Map existing Test/Execution/optional Plan/Bug types, select defect link type, configure version/run sign-off chains; company-managed projects | `src/usecases/testManagementAdmin.js`, `frontend/src/admin/pages/TestManagementPage.tsx` |
| Test authoring | Objective, textual preconditions, ordered Action/Data/Expected steps, draft revision checks | `src/usecases/testAuthoring.js`, `frontend/src/testmgmt/TestView.tsx` |
| Versioning | Numbered immutable content snapshots and digests; publish, sign and reject; official runs select the latest signed version | `src/testmgmt/content.js`, `src/testmgmt/store.js`, `src/usecases/testAuthoring.js` |
| Manual execution | Per-step status, actual result, comment, attachment reference/hash, environment/configuration text and optional Jira release | `src/usecases/testExecution.js`, `frontend/src/testmgmt/ExecutionView.tsx` |
| Results and sign-off | Server result rules, N/A rationale, role eligibility, default Tester → QA separation, frozen run content after first sign-off | `src/testmgmt/results.js`, `chain.js`, `signing.js`, `src/usecases/testRunSigning.js` |
| Automatic defects | Intent row, marker reconciliation, app-created Bug after a fully signed Failed run, parent and links | `src/testmgmt/bug.js`, `src/usecases/testRunSigning.js`. See limitations below |
| Governance integration | Done guard, mapped test-management descendants excluded from parent baselines, ancestor-hold exemption, audit events | `src/testmgmt/executionGuard.js`, `treeExclusion.js`, `src/gate.js`, `src/lib/approval/runtime.js` |

These are executable features, not only a design or menu placeholder. Six `tm_*` table migrations exist (`v109`–`v114`). The focused test-management suite contains 44 tests across authoring/execution journeys, rules and administration.

## Fresh verification and delivery evidence

| Gate | Result from this review | What it establishes |
|---|---|---|
| Backend suite | 1,781 passed; 0 failed | Existing automated checks pass |
| UI suite | 260 passed; 0 failed | Existing UI checks pass; no dedicated tests referencing the new test-management components/resolver keys were found in `frontend/test` |
| Backend import smoke | 221/221 import cleanly | Resolver/module import wiring loads locally |
| Production UI build | Passed | Type checking and UI bundling succeed |
| Forge lint | 0 errors, 1 warning | Warning is the wildcard `external.fetch.client` permission |
| Development deployment | Successful deployment history confirmed; eligibility identifies deployed version **8.24.0** | Development deployment exists; deployment history has no source build tag identifying the reviewed dirty snapshot |
| Installation, consent, migrations and project setup | Not verified live in this audit | Deployment does not establish any of these gates |
| Live test-management acceptance | Not established | Repository contains a 25-journey checklist dated 22 October; setup is unchecked and the table records expectations rather than completed results |
| Production/customer delivery | Not established | No production release or customer acceptance was verified |
| Runs on Atlassian | **Not eligible**, checked against development 8.24.0 | CLI reports “App is egressing data” and a webtrigger that can egress data |

The full `npm run verify` completed successfully. The normal suite passing does not invalidate the adverse cases below: these cases are outside that suite's existing assertions.

The current manifest declares `external.fetch.client: "*"` and an untyped `va-probe` webtrigger. This is an eligibility/configuration finding, not proof that this test module sent customer data outside Atlassian. Atlassian's current [Runs on Atlassian rules](https://developer.atlassian.com/platform/forge/runs-on-atlassian-apps/) exclude unqualified external resource domains and dynamic/untyped webtriggers. A normal Jira test-management announcement does not require that badge; a no-egress or Runs on Atlassian claim does require resolving and rechecking it.

## Findings that prevent the signed, auditable release claim

Priorities below are assessed against the product's promised signed/auditable test cycle. Reproductions use production use-case functions with the repository's in-memory dependencies and injected boundary failures; they are local evidence, not observations of Jira incidents.

### F1. P1: a run can remain SIGNED after the tester signature is removed

**Source:** `src/testmgmt/signing.js:78`, `src/usecases/testRunSigning.js:80`, `src/testmgmt/store.js:175`.

`recordSignature` inserts a signature before awaiting its audit entry. Other requests can count that row immediately. If QA countersigns while the tester's audit write is pending, the run can become SIGNED. A subsequent failure of the tester's audit write deletes the tester signature, without reverting or invalidating the completed run.

**Reproduced:** held the tester's ledger write, completed QA sign-off, then failed the tester's ledger write. Final state was SIGNED, only signature step 1 (QA) remained, the tester received `LEDGER_UNAVAILABLE`, and the Done guard reported zero blocking runs. This does not require compensation deletion to fail. If deletion itself fails, the implementation also silently retains an unaudited signature.

**Required before release:** signatures must become effective only after durable audit confirmation; advancement and terminal guards must reject incomplete or unconfirmed chains, with recoverable interruption handling.

### F2. P1: Not executed becomes terminal before authentication and signature succeed

**Source:** `src/usecases/testRunSigning.js:131`, `src/testmgmt/executionGuard.js:18`, `src/testmgmt/store.js:175`.

`closeNotExecuted` first changes the run to NOT_EXECUTED, then invokes signing. Normal refusal results attempt a rollback, but thrown credential/SQL/signature errors bypass that rollback. The execution guard trusts the terminal state and does not require the closure signature.

**Reproduced:** a credential-storage exception left NOT_EXECUTED with zero closure signatures and zero blocking runs. The guard also returned zero blocking runs while authentication was still pending. Consequently an execution can pass the test guard without a successful signed closure.

**Required before release:** use a nonterminal closing state until the required signature is durable, and make the Done guard validate closure proof.

### F3. P1: deleted evidence still allows a fully signed Passed run

**Source:** `src/usecases/testExecution.js:186`, `src/testmgmt/jira.js:83`, `src/usecases/testRunSigning.js:24`.

Evidence attachment bytes are hashed when added. Run signing recomputes the digest from stored references/hashes, without checking current byte availability or creating a retained vault/Object Store copy. No protected retained reference is stored with the evidence.

**Reproduced:** attached evidence, removed the attachment from the execution, made later byte reads fail, and completed both sign-offs. The run became SIGNED/PASSED; the bytes were read only once, at attachment time. The panel still carries the earlier evidence hash.

**Required before release:** integrate protected evidence retention and retrieval/read-back, and distinguish an integrity-bound record from currently retrievable proof. Missing/invalid evidence must prevent any claim requiring complete evidence. This finding does not mean every manual test must contain an attachment.

### F4. P1: the version sign-off screen does not show the frozen test being signed

**Source:** `frontend/src/testmgmt/TestView.tsx:47` and `:87`.

The screen renders current draft text. Published-version cards show version number, digest, step count and signatures, then offer Sign; they do not render the version's frozen objective, preconditions, steps or expected results. The draft can change after publication without changing the published version.

**Rendered reproduction:** supplied published content A and a newer draft B to the actual React component. Its rendered output contained draft B and an enabled-path Sign control, while frozen action A was absent. A signer cannot review the exact snapshot through this screen. Historical signed definitions also have no complete viewer here.

**Required before release:** display the immutable version snapshot being approved, and preserve readable historical versions. A digest is an integrity identifier, not a human review of its contents.

### F5. P2: a completed version approval can become stranded

**Source:** `src/usecases/testAuthoring.js:129` and `:146`.

After the final version signature and its audit entry are durable, the state update to SIGNED/REJECTED is separate. Unlike run signing, version signing has no settle/recovery operation.

**Reproduced:** failed only the version-state update. After restoring SQL, the version remained PUBLISHED with its complete signature, no next step and `canSign: false`; retrying sign-off returned `VERSION_NOT_PUBLISHED`, and starting a run returned `NO_SIGNED_VERSION`.

**Required before release:** idempotently settle version outcomes from confirmed signatures and handle failed/losing state writes explicitly.

### F6. P2: the fixed search delay does not guarantee one bug per failed run

**Source:** `src/testmgmt/bug.js:96`–`:112`.

After an ambiguous create response, an empty marker search after five minutes permits another create. Complete pagination is not proof that a recently created issue is indexed. Nor is a mutable label a durable server-side idempotency key.

**Reproduced:** injected a create that succeeded but lost its answer, and a 20-minute simulated search-index delay. Retried after `SETTLE_MS`; two Jira-create calls succeeded for the same run, and the row recorded BUG-2 as CREATED. This shows the implementation's assumption, not evidence that Jira normally has a 20-minute delay.

**Required before release:** preserve uncertainty without a second create until absence is established by a stronger mechanism or an explicit audited repair decision. Do not advertise an unconditional exactly-once guarantee from the current implementation.

### F7. P1: repair accepts an unrelated work item as the automatic bug

**Source:** `src/usecases/testManagementAdmin.js:170`, `src/testmgmt/store.js:279`, `src/testmgmt/treeExclusion.js:47`.

Repair validates only that the selected issue exists in the same project. It does not validate the mapped Bug type, expected parent, exclusive run association or required links, and does not create the test/execution links. The state becomes CREATED, releasing the bug guard. Because `tm_bug` IDs also determine baseline-tree exclusion, an arbitrary selected issue can acquire that exemption without the enablement checks for mapped types.

**Reproduced:** a Failed run whose create was refused was repaired using a same-project Story. Repair succeeded, the bug row became CREATED, no links were written, and the execution guard reported zero blocking runs.

**Required before release:** validate the repair target and its governed-tree safety, reconcile required relationships, prevent reuse across runs, and expose an actual repair interface. The backend resolver `admin:tm:repairBug` exists, but no caller for it was found in the frontend; the runner currently instructs administrators to repair under Test management without providing that operation there.

### F8. P1 for continuous governance: Done-route enforcement is checked only at setup

**Source:** `src/usecases/testManagementAdmin.js:66`, `src/jobs/gatecheck.js:201`; acknowledged in `docs/acceptance/test-management-live-checklist-2026-10-22.md:66`.

Enablement checks all current Done routes. The hourly health job enumerates controlled-transition and baseline pairs, not every enabled test-management execution workflow. Removing a validator later, or adding a new Done transition, can therefore bypass the execution guard without a test-management health finding, especially where the execution type is not separately governed.

**Required before the continuous enforcement promise:** include enabled execution workflows in ongoing checks and surface an unenforced project as unhealthy. Monitoring detects missing validators; actual prevention still requires validators on every Jira route.

## Capability gaps, separated from deliberately deferred work

The current checklist explicitly lists these as absent, and the resolver/model/UI inventory agrees:

- Working Test Plans/Sets, ordered membership, signed selection and reusable preconditions; mapping a Plan type does not implement a Plan workspace.
- Datasets, parameters and iterations; reusable steps/tests and pre/post-action mechanics.
- Signed `Verifies` source association, operational/governed coverage, Suspect propagation/review and source-baseline applicability decisions. The draft's `verifies` array is only stored issue IDs, not this end-to-end capability.
- Selective rerun from an execution. A backend `retestOf` field exists, but the Add run UI does not send it or offer the finished-execution selection workflow.
- Signed frozen release scope, execution-summary export and an independently retrievable audit dossier.
- A test repository/board for planning and execution across issues; the current experience is issue panels with manually entered test keys.
- Configurable test types, rich/Gherkin/unstructured authoring, semantic status administration, structured configuration/environment catalogs and broader custom fields.

**Deferred by the latest owner decisions:** the ten-report Reporting Center/trace reports, CI/JUnit, file import and Xray/Zephyr migration; Sync Now is also explicitly excluded. Their absence should not be counted as a surprise defect or forced into a smaller manual-testing launch. AI is unimplemented and does not have to be a launch prerequisite. The verdict already follows from the actual reliability and acceptance gaps above, without requiring competitor parity or a future requirements workspace.

## Supplementary CodeRabbit review

The review completed over all 11 files in `src/testmgmt`, including untracked files: **1 major, 3 minor findings**. It did not cover every use-case or frontend file; the direct review and reproductions above cover those separately.

- **Major:** a failed audit compensation can leave an effective signature with no ledger entry. Current code confirms the swallowed delete failure; F1 also reproduces advancement before successful compensation.
- **Minor:** create-screen pagination stops when `isLast` is absent even if `total` indicates more fields. A local adapter probe with `total: 101` and 100 first-page fields returned 100 after one request. Confirm the live response shape when remediating.
- **Minor:** HTTP 429 becomes permanent NEEDS_REPAIR rather than a controlled transient retry. This matches the current all-4xx branch but creates avoidable manual recovery during throttling.
- **Minor:** distinct-signer matching uses exhaustive backtracking. A six-step local case with 40 Tester holders and the same sole QA/Approver visited 60,880 Tester entries before rejecting; larger organizations need a bounded matching implementation or measured limits.

No reviewer-supplied fix was executed and no production code was changed.

## Announcement decision and completion gates

| Proposed claim | Assessment today |
|---|---|
| Jira-native manual test-management functionality has been implemented | Supported by current code and passing normal local checks |
| Development build is available for controlled validation | Development deployment confirmed; setup and acceptance still need verification |
| Test management is released and customer-ready | Not supported |
| Complete AssureX-style capability parity | Not supported and not needed for a scoped manual release |
| Governed/regulated test-management readiness | Not supported |
| Runs on Atlassian / verified no-egress product | Current deployed eligibility fails |

Before a scoped customer announcement:

1. Resolve the signature/closure atomicity, exact-version review, evidence, defect and recovery findings, with regression cases at their real boundaries.
2. Define the supported release scope explicitly. If this is a manual-test release, identify its supported planning, rerun and summary capabilities and disclose what is deferred. Coverage/validation promises require their missing end-to-end proof.
3. Complete setup, migrations, roles and all relevant live journeys on the intended tenant, with result records and read-back. Exercise passing/failing/rejected/not-executed runs, permission loss, stale content, replay, interruptions, evidence loss, duplicate events, bugs/retests and every Done route. User authentication/signatures remain user actions.
4. Create a reproducible reviewed release snapshot and verify the customer environment's installation, consent, migration and acceptance gates independently of local tests or development deployment.
5. Resolve and recheck app eligibility before using any no-egress or Runs on Atlassian claim. Prepare the intended-use validation evidence before any automotive/medical readiness claim.

**Recommended description today:** an implemented Jira-native manual-testing core undergoing development validation. It has enough substance to demonstrate; the evidence does not yet support a released, reliable, complete test-management product.

## Reproduction artifacts

- `fixtures/2026-10-21-test-management-readiness-probes.mjs` contains six executable boundary/failure reproductions using the repository's in-memory world and production use cases. Run from a checkout with its dependencies installed: `node docs/reviews/fixtures/2026-10-21-test-management-readiness-probes.mjs`.
- `fixtures/2026-10-21-test-management-readiness-results.json` records adverse outcomes. Assertions deliberately establish the defects; exit code 0 means the defects reproduced, not that the product passed acceptance.
- F4 was separately checked by rendering the actual React component with different draft/published text. No live signature, Jira issue, or tenant state was used for these probes.
