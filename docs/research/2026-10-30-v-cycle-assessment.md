# V-cycle coverage assessment — 30 October 2026

## Conclusion and scope

VAtlassian has a substantial implementation of governed manual testing inside Jira. It does not yet establish complete V-cycle coverage or an accepted end-to-end compliant delivery process. The principal boundaries are the external-requirement handoff, automatic test/build evidence, planning and management across the whole delivery scope, and a release-wide acceptance decision.

This assessment reads the current dirty working tree and the repository's recorded acceptance evidence. It does not run the application, refresh Jira, rerun tests, deploy, sign, or change product code. “Implemented” below means source paths exist and were inspected; it does not mean every path was freshly exercised or accepted on a tenant. Existing plans describe aspirations as well as delivered work and are not implementation proof.

The official [ISTQB CTFL overview](https://istqb.org/certifications/certified-tester-foundation-level-ctfl-v4-0/) was read on 30 October 2026. It describes lifecycle alignment, test levels/types, static review, analysis/design, planning, risk, monitoring/control/completion, configuration management and defect management. It provides a process reference, not certification of this product. The search service was unavailable; the official page was read directly in the browser instead.

## What the V-cycle means for this scenario

A simplified V-cycle pairs each description of the intended product with evidence that the implemented product satisfies it:

| Definition or design | Corresponding testing question |
|---|---|
| User needs / intended use | Acceptance / validation: does the product solve the intended problem in the intended setting? |
| System / product requirements | System testing: does the complete product satisfy the specified behavior and constraints? |
| Architecture / interfaces | Integration testing: do components and external systems interact correctly? |
| Detailed component design | Component / unit testing: does each component work correctly? |

Names and boundaries vary by industry. Sprint delivery can repeat these activities incrementally. QA can prepare tests as soon as a feature's expected behavior is understood. Testing also includes reviewing ambiguous requirements before implementation, not only finding bugs afterward.

Manual versus automated is a different distinction from test level. A manual system test and an automated system test can test the same requirement. A generic case record does not, by itself, provide the specialized execution, measurements, independence, or acceptance controls needed at every level.

External requirements management is compatible with this approach. The handoff still needs identifiable, versioned requirements and a controlled way to detect and assess later changes.

## Current capability inventory

| Team activity | Current source evidence | Practical boundary |
|---|---|---|
| Define repeatable cases | Objective, preconditions, ordered action/data/expected steps; validation; signed numbered snapshots. [content](../../src/testmgmt/content.js), [authoring](../../src/usecases/testAuthoring.js) | Testers supply the scenarios and decide whether expected results actually cover the requirement. |
| Organize test work | Signed plans/sets and reusable preconditions, required members, configurations, release and environment. [planning model](../../src/testmgmt/planning.js), [planning use cases](../../src/usecases/testPlanning.js), [plan execution](../../src/usecases/testPlanExecution.js) | Explicit member selection; no native sprint-scope discovery, workload scheduling or risk model was found in the inspected module. Ordinary Jira fields/boards can support coordination separately. |
| Test variants | Explicit dataset rows and bounded combinations resolved into frozen run steps. [planning](../../src/testmgmt/planning.js:15) | Enumerates chosen inputs; does not decide whether they provide sufficient boundary, negative, security or safety coverage. |
| Execute a case | Signed version selected; environment/configuration/release and source/planning context retained; per-step actuals/results and correction history. [execution](../../src/usecases/testExecution.js) | Manual execution. The stored model has no dedicated immutable tested build/commit/artifact digest. Free text or attachments could record one manually, without an enforced build binding. |
| Compute truthful outcomes | Failed/Blocked/Not run/N/A semantics; all steps must pass for a full pass; N/A needs a reason. [results](../../src/testmgmt/results.js) | A valid signed Failed result is a truthful record of failure, not product acceptance. |
| Retain proof | Attachment bytes copied into Forge Object Store, read back, size/hash verified, authorized retrieval. [evidence](../../src/testmgmt/evidence.js:13) | An intact screenshot or log proves retained bytes; its adequacy and meaning still require review. Tenant retrieval/retention acceptance remains separate. |
| Review and approve | Frozen run digest; configured role chain; default distinct Tester then QA; optional author separation for definitions/plans. [chain](../../src/testmgmt/chain.js), [run signing](../../src/usecases/testRunSigning.js:56), [authorship](../../src/testmgmt/authorship.js) | Defaults/settings are not evidence that the customer's grants and independent-review policy are configured and effective. |
| Return defects to development | Automatic Jira bug after a fully signed Failed run; contextual description, test/execution links, durable reconciliation and repair. [bug](../../src/testmgmt/bug.js), [signing](../../src/usecases/testRunSigning.js:178) | The automatic bug waits for final review. The inspected runner does not provide a general immediate exploratory defect-reporting workflow. Teams can use Jira's normal issue creation separately. |
| Verify a fix / run regression | Selected reruns create a new execution and retain original provenance; signed exact/latest version selection. [retest](../../src/usecases/testRetest.js), [coverage proof](../../src/testmgmt/coverage.js:33) | Testing the fix and selecting affected regression tests still require engineering judgment; no CI runner/result importer was found. |
| Trace sources and changes | Signed source associations, dedicated native Verifies links, live baseline comparison, operational/governed coverage, signed FITS/applicability decisions. [sources](../../src/testmgmt/sources.js), [coverage](../../src/usecases/testCoverage.js), [source decisions](../../src/testmgmt/sourceDecisions.js) | Current references require visible Jira issues in the same project/site. This is not automatic external-requirement synchronization. |
| Export a record | Stored execution snapshot, digest, completeness and JSON/HTML downloads. [summary use case](../../src/usecases/testSummary.js), [rendering](../../src/testmgmt/summary.js) | An execution report is not the entire release's signed requirements/test scope or release approval. COMPLETE describes record checks, not all tests passing. |
| Enforce closure | Done guard checks proof, terminal runs and creation of failed-run bugs. [execution guard](../../src/testmgmt/executionGuard.js:16) | Rejected and Not executed are terminal; a signed failure with its bug can cease blocking execution closure. This guard does not require all release requirements to pass or all bugs to be fixed. |

The Jira work items provide the shared identities and workflow surfaces. Detailed definitions, versions, results, signatures and planning records live in Forge SQL; retained evidence lives in Forge Object Store. It is therefore a Jira-integrated workflow, rather than all test data being ordinary Jira fields.

Test-management types and identified automatic bugs are deliberately excluded from their parent's governed baseline tree. They have their own test signatures/history; recording testing should not invalidate an approved development Epic merely by adding a child. This makes the explicit source/test links and coverage checks essential. See [tree exclusion](../../src/testmgmt/treeExclusion.js:4).

## External requirements: the missing handoff contract

The source resolver accepts Jira issue identities and pins their digest and optional VAtlassian baseline id/version/hash. It rejects a different site/project or a source the viewer cannot read. See [sources.js:42](../../src/testmgmt/sources.js:42).

For a requirement maintained outside Jira, a controlled handoff could record its external identifier, exact revision/baseline, accepted text or immutable evidence, acceptance criteria, and owner in a governed Jira source record. That is a proposed operating model, not an existing automatic importer. The company must also detect external revisions and update/review the handoff; the current module cannot discover a changed external document on its own.

Linking a test only to a Story can demonstrate coverage of that Story. It does not prove coverage of every external requirement or that the Story faithfully implements the agreed requirement. A mutable URL alone does not identify the exact revision tested.

Current test/source coverage can answer questions about the registered Jira sources. No observed evidence establishes a complete external requirement inventory or a signed release-wide denominator against which to claim “100% covered.”

## Remaining V-cycle capabilities and proof boundaries

1. **Controlled external requirement intake and change notification.** Full requirements authoring is not a prerequisite, but a reliable revision-aware handoff is.
2. **Test-level and verification-method coverage.** Generic manual cases can describe unit, integration, system or acceptance procedures. The inspected model does not enforce the separate purposes, scope, techniques, independence and acceptance rules of those levels. Analysis, inspection and demonstration are also valid forms of evidence in relevant processes; a step-based test runner is not a full verification-method framework.
3. **Automated execution/results and build identity.** No dedicated CI/JUnit/Cucumber result ingestion or immutable code/build/artifact pin was found in the inspected test-management routes/models. External tools can execute unit, integration, performance, security or hardware tests; VAtlassian would need trustworthy evidence intake to consolidate their results rather than manual transcription alone.
4. **Delivery-wide test management.** Plans exist. A sprint-oriented incoming-work view, risk prioritization, assignments/capacity, environment readiness, progress trends and exploratory-session support are not established by those plans. Some coordination can be supplied through ordinary Jira functionality.
5. **Release-wide acceptance.** Signed plan revisions and frozen execution summaries exist. A separate signed release scope that aggregates every required source/test/configuration and applies exit criteria, defect dispositions and authorized risk acceptance was not found. Execution Done and report COMPLETE must not be advertised as release approval.
6. **Live acceptance and customer validation.** Source implementation, automated test evidence, deployment, installation/consent, tenant configuration, effective permissions and successful real-user journeys are separate claims. Applicable compliance frameworks require a scoped assessment of the organization's process and use of the tool; signatures/hashes alone cannot establish all compliance requirements.

## Recorded live evidence, read afresh from the repo

The [live evidence file](../acceptance/test-management-live-evidence-2026-10-22.md) contains later updates through 25 October, superseding earlier incomplete rows:

- It records published/signed v1 on VAT-83 and unsigned v2 leaving v1 runnable.
- Its 24 October entry records a run on VAT-84 selecting signed v1 and an append-only Failed-to-Passed correction with a reason.
- Tester sign-off was blocked by a locked credential; non-Tester refusal and distinct QA completion remained unrun in that record.
- The [checklist](../acceptance/test-management-live-checklist-2026-10-22.md) still labels additional manual/native-link journeys as not run on the tenant.

These are recorded observations, not a fresh 30 October tenant audit. The historical local pass counts in the [implementation ledger](../reviews/2026-10-21-test-management-implementation-ledger.md) were not rerun here. They must not be presented as current passing results or proof that the current dirty snapshot is deployed.

## An illustrative company workflow

Suppose external requirement R-104 revision C says an operator must be locked out after three failed sign-in attempts. The team agrees and controls a Jira representation of revision C, implements linked work, and QA designs normal, boundary and negative cases before delivery. QA publishes/reviews cases, selects them into a signed plan, runs them on a known build/configuration, and records observations and evidence. A reviewed Failed run creates a Jira bug; developers fix it; QA reruns while retaining the original failure. If revision D later changes the lockout behavior, the handoff must first bring that external change into Jira, after which linked test coverage can identify the changed source and require review/new execution or justified applicability.

The current product contains many of these middle steps. External change intake, enforced build evidence and the final release-wide acceptance decision remain boundaries. The justified positioning is **governed manual testing and traceability alongside Jira development**, with substantial implementation and incomplete end-to-end acceptance evidence.
