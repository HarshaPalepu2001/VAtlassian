The interview is complete. The first release will prove:

**Baselined requirement → approved verification assignment → signed tests → CI results for one candidate → human-reviewed runs → enforced closure decision → frozen evidence dossier.**

Implementation, deployment, eligibility verification, and live acceptance remain outstanding.

**The governing records**

| Record | What it freezes |
|---|---|
| Verification Assignment | Source baseline/digest, named obligations, levels/methods, mandatory contexts, exact signed test versions, build-matching policy, approval chain |
| Approved Closure Target | Assignment revision, candidate execution, reported target build identity, human approval |
| Execution Intake Grant | Installation, project, token, execution, allowed runs, expiry, granting actor |
| CI Receipt | Submitted payload and digest, token identity, reported build, receipt time, mappings, application progress |
| Evidence Exception | Exact historical evidence digest, permitted missing metadata, rationale, scope, approval proof |
| Closure Evaluation | Source, assignment, target, selected attempts, proofs, exceptions, defects, policy, completeness findings, verdict |
| Observed Transition | Evidence that Jira completed a status transition; linked to an evaluation only through verified correlation |

Assignments, targets, and exceptions use the **source requirement’s project and issue-type authorization scope**. Intake grants use the **execution’s scope**. Existing wildcard grant semantics remain explicit.

**The execution flow**

1. An authorized human creates an assignment against an approved source baseline. Every declared obligation and its test-version/context combinations are mandatory. A replacement requires rationale, signatures, and audited activation. Drafts leave the existing assignment active; a source-baseline change makes it stale immediately.

2. A human prepares one TestExecution for one build candidate. Runs pin signed test versions, resolved steps, contexts, and review chains. Each authorized attempt receives a server-assigned sequence immediately, before build metadata exists. A different candidate uses another execution.

3. CI submits bounded JSON identifying exact prepared runs and resolved steps/iterations. The project token and execution grant authorize intake; both are rechecked before queued writes. Raw JUnit ingestion is deferred.

4. Intake preserves the original submission and machine attribution. Identical retries reuse the receipt; conflicting payloads under the same idempotency key fail. Workers track recoverable progress. **No affected run becomes signable until the entire receipt is APPLIED and audit-confirmed.** This is an all-or-nothing readiness rule; partial physical writes may exist during recovery.

5. Human reviewers sign the explicit meaning: **“I reviewed these machine-recorded results and their evidence.”** They do not become the machine’s executor. Corrections require reasons and preserve original results. Signing freezes the reviewed content; signing a failure preserves the failure and follows existing defect-creation safeguards.

6. An authorized human approves the closure target separately. CI-reported build values remain **sender-attested identity**. They do not establish independent compiler, runner, or artifact provenance.

**The governed closure rule**

For the chosen candidate execution, every mandatory obligation must have a qualifying latest attempt:

- Select by server attempt sequence within the exact test-version/context scope.
- Newer unfinished attempts block immediately, including attempts without build metadata.
- Never fall back from a failed, rejected, cancelled, or unfinished replacement to an older pass.
- Require a fully **SIGNED, PASSED** run, valid proofs, current source/assignment, matching target identity, available evidence, and satisfied defect/retest rules.
- Reject incomplete reads, inconsistent revisions, unresolved receipt processing, or unavailable proof.

**Q23 narrows Q19:** exceptions cannot authorize non-PASSED results. They cover only explicitly permitted missing historical metadata on otherwise valid, signed, passed evidence. Recorded build mismatches, failures, drift, broken proofs, missing retests, and blocking defects remain non-waivable.

Qualified evidence displays **VERIFIED_WITH_EXCEPTION**, naming the unresolved gap. Missing build identity remains unproved even when its absence is accepted.

Before returning **ALLOWED**, the gate must durably persist and audit-confirm its evaluation. Persistence failure denies closure. A storage outage can also prevent recording that denial.

**Historical integrity and reporting**

Existing signed rows, canonical content, and schema-1 digests remain untouched. Missing historical fields display **Not recorded**. New evidence includes classification, reported build identity, and human/machine provenance in its signed content.

The dossier exports a frozen evaluation, including denied evaluations where recorded. It identifies the selected attempts, approval meanings, exceptions, and evaluation time. Later changes do not rewrite that history.

Gate permission and completed Jira transition remain separate facts. Exact linkage requires demonstrated correlation; timestamp proximity is insufficient. The evaluation is an as-of record, with the gap between validation and Jira’s completed transition explicitly acknowledged.

**Proposed implementation defaults**

- Separate configurable assignment, target, and exception approval chains, with configured author/signer separation.
- Reject exception policies whose approval floor cannot be shown to meet both governing chains.
- Ordinary token expiry/revocation stops further processing without rewriting historical receipts.
- Fixed static webtrigger acknowledgments; detailed receipts appear in authenticated Jira UI.
- No server-side fetching of submitted pipeline URLs or external artifacts.
- Start with the existing supported human signing ceremony; claim WebAuthn support only after equivalent subject/digest/meaning verification.
- Bound payloads, result counts, and stored logs; reject oversized submissions explicitly.

Broad Epic/Release dashboards, cross-execution aggregation, interchangeable obligations, automatic execution discovery, independent build attestation, and raw JUnit intake are deferred.

Validation will separately establish local correctness, Forge deployment/eligibility, tenant permissions and workflow attachment, and the live success/failure journeys. The original day estimates should be replaced after implementation planning.

Please confirm that this captures our shared understanding, including the proposed defaults. The [grilling skill](/Users/sriharsha/.codex/plugins/cache/mattpocock/mattpocock-skills/1.3.2/skills/productivity/grilling/SKILL.md) requires: “Do not act on it until the user confirms you have reached a shared understanding.” This is the final design confirmation before implementation.