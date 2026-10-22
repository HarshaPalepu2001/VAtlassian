# Manual test-management implementation — 21 October 2026

**Manual workflow and native Jira Verifies integration verified locally. Tenant release acceptance remains unperformed.** Existing dirty work is preserved; no repository commit, deployment, installation, live migration or Jira mutation was performed in this implementation pass.

Authorization: continue implementation, explicitly including plans/sets, datasets, reruns, coverage and summary export. All six tasks in [the implementation plan](../superpowers/plans/2026-10-21-test-management-completion.md) are locally verified, including typed Jira Verifies synchronization and versioned native baseline link rules. Governed coverage fails closed when complete Jira link proof is unavailable.

## Final local evidence

| Check | Result |
|---|---|
| Backend suite | **2,028 passed, zero failed** |
| Final UI suite | **289 passed, zero failed** |
| Backend imports | **255/255 clean** |
| Final UI type check and production build | **Passed** |
| Forge lint | **Zero errors; one existing wildcard client-permission warning** |
| Whitespace check | **Passed** |
| Independent review | Four completed CodeRabbit passes; eleven findings (six major, five minor), all corrected; final follow-up has zero findings |

The complete final verification passed after native integration and both review corrections: **2,028 backend / 289 UI / 255 imports / type check and production build**. Forge lint reports zero errors and the existing wildcard client-permission warning. The last independent follow-up completed with zero findings across eleven changed files.

Raw logs: `/private/tmp/vat-tm-native-final-verify.log`, `/private/tmp/vat-tm-native-forge-lint.log`, `/private/tmp/vat-tm-native-review.ndjson`, `/private/tmp/vat-tm-native-review-followup.ndjson`. Durable [review results](2026-10-21-test-management-implementation-review-results.json) and [source fingerprints](fixtures/2026-10-21-test-management-implementation-files.json) accompany this report. Earlier milestone logs remain historical evidence.

## Delivered behavior

1. **Durable signing and recovery.** Signatures remain PENDING until their exact ledger event succeeds; only ACTIVE audit-confirmed proof counts. Terminal guards reject incomplete chains and unsigned closures. Version publication, run creation, source decisions and final outcomes have recovery paths. Chain eligibility uses bounded matching.
2. **Authoring and planning.** Exact frozen Test definitions, datasets and source baselines are readable before signing. Plans, sets and reusable preconditions have numbered signed revisions. Plan-driven execution uses server-selected signed versions, release/environment/configurations and precondition text, same-project/parent checks, stable child request IDs and bounded continuation.
3. **Datasets.** Text/list parameters, explicit rows and combinations expand deterministically into immutable run steps and iteration values. Every expanded step contributes to result/sign-off. Non-dataset definitions preserve literal `{{...}}` text.
4. **Evidence and defects.** Evidence is retained and read back in Forge Object Store; signing/export verify full hashes. Ranged downloads recheck execution/Test visibility per chunk; the browser verifies assembled SHA-256 before download. Uncertain Bug creation cannot trigger another automatic create. Repair checks mapped type, parent, terminal proof, baseline exclusion, exclusive claim, links and audit.
5. **Selective reruns.** A finished execution can create a new execution of selected failed/rejected/not-executed or optional passed runs. Exact or explicitly chosen latest signed versions, context and ancestry are retained. Validated original release snapshots support archived releases. Durable intents/child receipts survive retries.
6. **Coverage and export.** Test-owned signed SQL associations appear on Test/source panels. Coverage uses current source proof and the latest terminal result per Test/configuration/release/environment. Changes produce Suspect or unconfirmed results. Signed FITS review clears the definition; historical run reuse requires separate signed applicability. Frozen JSON/readable HTML summaries include completeness and digest, and recheck access on retrieval.
7. **Native Jira ownership.** Signed source references pin a dedicated Jira link type. A durable outbox writes only signed scope, checks every native baseline covering either endpoint, and commits proof only after exact fresh Jira readback and audit. Drafts never write links; external additions/reversals block reconciliation, and external deletion of committed links gives Unknown rather than silent restoration. Partial earlier signed scope can be cleaned by a new signed version. The scheduler processes two intents with a shared 45-second deadline and at most ten writes per intent.
8. **Frozen native link rules.** New full native approvals can adopt v2, with the policy bound into approval proof, link digests, baseline storage and per-node snapshots. Old v1 hashes remain unchanged. MIXED/REJECT keep the standing rules; queued restores freeze per-node policy and refuse later substitutions. Capture, retained values, evidence, drift, restore and other-end propagation share those rules. A source-end exclusion is no opinion; Tests continue owning Verifies.
9. **Workflow health.** Enabled Execution workflows participate in hourly Done-validator monitoring. Health-read outages leave configuration readable with unknown health; save-time enforcement remains closed.

## Original audit findings

| Finding | Local correction |
|---|---|
| F1: countersigning before audit / failed compensation | PENDING→ACTIVE promotion, exact-event recovery and terminal proof |
| F2: unsigned Not executed becomes terminal | Nonterminal CLOSING and signed closure proof |
| F3: evidence hashes without retained bytes | Retention/readback, full hash verification and authorized retrieval |
| F4: signing a version while showing only draft | Complete frozen definition before signing |
| F5: signature strands version outcome | Finish-version and source-projection recovery |
| F6: duplicate Bug after uncertain creation | No second create on empty search; marker proof, exclusive claim and repair |
| F7: unsafe repair | Type/project/parent/baseline/proof/claim/link/audit checks |
| F8: absent continuous Execution health | Enabled Execution pairs included in monitor |

Original adverse probes remain historical reproductions of pre-fix failures. New regressions exercise corrected production services and actual React panels; the original adverse assertions are not current acceptance tests.

## Independent review dispositions

- Repeated plan validation: request-scoped execution/coverage/summary caching keyed by exact frozen plan/preconditions and viewer. Source reads also deduplicate. Caches never survive across operations or writes.
- Historical planning cost: full member proof for actionable/current signed revisions; historical digest/signature checks remain. Issue/version/signature reads are shared. Hidden history still fails closed.
- Literal braces: preserved when no dataset exists, with a regression.
- Large evidence downloads: documented HTTP Range transfers one file's bytes, avoiding full-object reads per chunk. Signing/export retain complete verification. [Official Forge reference](https://developer.atlassian.com/platform/forge/storage-reference/object-store-api/#create-download-url).
- Legacy frozen evidence: acceptance stays blocked; an authorized countersigner may reject with a reason so a new run can replace it.
- Health outages/error messages: configuration remains readable with unknown health; validation errors explain corrective actions.
- Rerun refusal: a fresh selection is allowed only after explicit definite Jira refusals. Ambiguous creation stays blocked for investigation.
- Add run refusal: confirmed pre-write validation refusals unlock editing; audit/persistence failures and lost responses retain their retry ID. Both paths have UI regressions.
- Native history initialization (major): a source-free signed version can adopt its first configured Verifies type; any nonempty prior relationship scope still requires exact identity. Tested null and previously configured empty histories.
- Native restore no opinion (minor): an in-tree v2 node that does not track links returns no opinion; tracked links without retained values still fail closed except for exact policy exclusions.

## Release and product boundaries

- **This candidate has not been deployed or accepted in Jira.** The earlier audit identified development 8.24.0, which does not identify this candidate. Deployment, installation/consent, migrations **v115–v136**, tenant permissions, range-response headers and every real Done route need separate acceptance.
- Native Jira Verifies synchronization is implemented locally. Existing v1 source baselines must receive a new full native approval before an excluded link can be changed. A native Test baseline still owns Verifies; its approved link state must already agree before synchronization can adopt that link without mutation. Generic bug links remain governed: a general-purpose Relates type is never globally exempted. Plan/set membership and retest ancestry remain signed SQL snapshots; this pass adds no native membership/retest link mirrors.
- Uncertain rerun creation requires investigation; this pass adds no administrative reassignment/recreate workflow for an uncertain intent.
- Bounds: 100 dataset iterations, 1,000 expanded steps, 200 collection members, 100 selected reruns, ten child additions per invocation and 500 runs in a complete execution-panel read. Oversized plan execution scope is refused before child creation.
- CI/JUnit, import/migration, AI, the ten-report center and the separate biometric/egress solution remain deferred. Existing manifest egress/probe findings remain; this work does not establish Runs on Atlassian eligibility or a no-egress release claim.
- Tests/review establish local implementation evidence, not live customer acceptance, industry validation or full competitor parity. Complete the updated [tenant acceptance checklist](../acceptance/test-management-live-checklist-2026-10-22.md) before a released-product announcement.

## Preservation

Work stayed on the existing `VAtlassian` branch because the requested implementation was dirty/untracked. The complete pre-edit source snapshot is `/private/tmp/vat-tm-implementation-baseline`. A separate temporary repository compared that snapshot to task changes for review; its temporary snapshot commits do not change this repository. The accompanying fingerprint file lists every implementation/test file that differs from the preserved snapshot. Earlier unrelated dirty changes remain preserved. No broad staging, reset or cleanup was performed.
