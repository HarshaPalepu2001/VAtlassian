# Governed verification implementation and acceptance

Approved scope: [local specification](../../.scratch/governed-verification/spec.md). Implementation plan and issue files are in `.scratch/governed-verification/`.

The local implementation connects an approved source baseline, signed verification assignment, one candidate execution, signed human review of CI results, an enforced closure evaluation, and a frozen JSON dossier. Deployment and live acceptance are separate release gates.

## Implemented path

1. Configure the source assignment, closure target and evidence exception chains in Test management administration. Each has a subject-specific default meaning; saved administrator meanings remain intact. Exception chains must demonstrably meet both governing approval floors. Governance author separation defaults to enabled.
2. On the source requirement, prepare named mandatory obligations with levels, methods, exact signed Test version IDs and all required contexts. The source's project and issue type determine authorization. Draft replacements leave the old assignment active; source baseline/digest changes make it stale.
3. Prepare exact runs on a Test Execution. New runs receive a monotonic SQL sequence before results/build identity exist. Classification and reported build identity are included in new signed content. An execution's first supplied candidate identity is immutably bound and audit-confirmed; a different identity requires another execution.
4. From the execution's CI intake tab, create a project token and an expiring execution grant for exact runs. Their management authorization uses the execution's scope and existing wildcard eligibility rules. The token secret is shown once; storage retains its hash.
5. Submit the bounded JSON template to the deployed static webtrigger with its Bearer token. Use exact run/revision/resolved-step/iteration identities, and replace all outcome/build/idempotency placeholders. Identical byte retries reuse the receipt; changed bytes under that key are rejected. The endpoint returns fixed acknowledgments only; authenticated Jira UI provides details.
6. The worker validates the preserved payload and pinned mappings, rechecks authority before writes and in SQL predicates, records recoverable per-run progress, and audit-confirms the entire receipt before APPLIED. Pending or partially written receipts block every affected run's signing and human corrections.
7. Human signatures explicitly affirm: “I reviewed these machine-recorded results and their evidence.” Machine attribution and original receipt results/logs remain preserved. Corrections require reasons and stay in the signed history. Signed failures retain the existing automatic-defect safeguards.
8. Separately approve the source's closure target: exact assignment revision, execution and reported build identity. Build identity is sender-attested; no independent compiler/runner/artifact attestation is claimed.
9. A source enrolled by a governing record acquires an additional Done check in `va-gate`. Every exact mandatory combination selects the latest server attempt without build filtering. Unfinished, rejected, failed or cancelled replacements block older passes. Complete current proof, signed PASSED outcome, evidence, defects/retests, source/assignment and target identity must all qualify.
10. The gate persists, audits and reads back an immutable evaluation before ALLOWED. Storage/audit failure denies. Recorded denials export too. JSON dossiers freeze the evaluation, selected attempts, approval meanings/proofs, original CI receipt/log bytes, candidate binding and exact approved exceptions. Export authorizes every referenced Test, including other receipt members. Later changes do not rewrite that snapshot.

## Integrity and recovery decisions

- Existing signed run rows and schema-1 canonical content are not backfilled or rewritten. Missing metadata displays **Not recorded**.
- Historical ordering is derived from matching `TM_RUN_CREATED` audit records before an immutable rollout cutoff in the new clock. It checks actor, execution, Test/version digests and available creation identity. Missing, conflicting or post-cutover legacy creation proof leaves ordering unproved and blocks closure. Native sequences begin after the cutoff. This prevents historical exceptions from depending on invented timestamp order.
- Exceptions accept only named missing historical metadata on otherwise valid signed passed evidence. New schema-2 omissions, recorded mismatches, failed outcomes, drift, broken proofs, blocking defects and missing retests are non-waivable. Accepted historical gaps display **VERIFIED_WITH_EXCEPTION**; absent build identity remains unproved.
- Pending receipts are serialized per execution. If an authority expires or is revoked during a partial application, processing stops and the historical receipt stays blocked. Prepare another execution/target rather than silently rewriting that receipt or its authority.
- Jira transition events are audit-confirmed independent observations. Source UI displays them separately. No evaluation linkage is inferred from timestamps; the validation-to-transition gap remains explicit.
- No submitted pipeline URL or external artifact is fetched. Nonempty CI evidence arrays are rejected; retained Jira attachments use the existing evidence ceremony after APPLIED. Raw JUnit remains deferred.

The static webtrigger declaration follows the [Forge webtrigger response contract](https://developer.atlassian.com/platform/forge/manifest-reference/modules/web-trigger/). The new trigger does not establish app-wide Runs on Atlassian eligibility: the existing dynamic probe and client egress declaration remain in the manifest.

## Local validation

**Latest `npm run verify`: passed — 2,283 backend tests, 316 UI tests, 271 module imports and TypeScript/Vite production build.** `git diff --check` passed. The build retains the shared chunk-size warning. Full commands and review reconciliation are recorded in `.scratch/governed-verification/progress.md`. Validation includes backend tests, UI behavior/transport tests, smoke checks, TypeScript/Vite build, module syntax, diff whitespace and offline installed Forge manifest validation. These checks use local boundaries and do not establish live Forge/Jira behavior.

A fresh independent review found five critical/important issues, all reproduced and corrected with regressions: ordinary Bug source bypass; proof functions bound to earlier runtime dependencies; historical ordering; incomplete frozen CI evidence; and execution reuse across candidates. Subject-specific governing defaults and Forge entrypoint context handling were also corrected. The original report remains at `.scratch/governed-verification/review-report.md`, with final reconciliation in `progress.md`.

## Outstanding release acceptance

| Boundary | State and required evidence |
| --- | --- |
| Authenticated Forge lint | Blocked: installed Forge credential is expired. Host retry reported “Your API token is no longer valid.” No login was performed. |
| Offline manifest validation | Installed Forge validator reports only the existing global `external.fetch.client` warning; this does not replace authenticated lint or eligibility verification. |
| Deployment/migrations | Not run. Apply migrations, confirm nullable historical metadata/cutoff behavior, deploy and verify installation/consent before exercising tenant data. |
| Workflow attachment | Confirm enabled `va-gate` on every required source Done route and execution Done route. Source enrollment alone cannot attach Jira validators. |
| Tenant authorization | Prove source-project/type approval roles, execution grant roles, issue security, author separation, wildcard grants and revocation on the tenant. |
| Validator execution identity | Prove human and supported automation/unconsented actor behavior. Unavailable user-scoped reads currently deny closure; source-only tests do not prove Forge invocation identity. |
| CI delivery/recovery | Prove endpoint authentication, queue delivery, identical/conflicting retries, crash recovery, expired/revoked authority and receipt-wide signing readiness live. |
| Live success/failure journeys | Prove signed candidate success; newer blank-build/failed attempt denial; drift; missing proof/evidence; blocking defects/missing retest; permitted historical exception; persistence/audit failure; frozen denied/allowed export; independent observed transition. Human signing remains a human action. |
| Eligibility/capacity/performance | Unproven. No no-egress, production timing, tenant capacity or Runs on Atlassian claim follows from these local tests. |

Broad Epic/Release dashboards, cross-execution aggregation, interchangeable obligations, automatic discovery, independent build attestation, raw JUnit and equivalent WebAuthn approval remain outside the approved first release.
