# Merging Forge Signature and Forge Baseline into VAtlassian ALM

## Context

Two Forge apps exist as separate repos with separate app ids and separate Forge SQL databases:

- `/Users/sriharsha/Forge Signature ` (note trailing space) has TOTP-based 21 CFR Part 11 e-signature. App id `62c59525-…`, tables `va_*`, branch `Version-2`, clean tree. **Zero egress** (no `remotes`, no `permissions.external`, verified), which is what makes it Runs-on-Atlassian eligible. ~19k lines. Its architecture has pure policy modules with no I/O, manifest↔code wiring tests, single-definition invariants.
- `/Users/sriharsha/Forge Baseline` captures a hashed, versioned snapshot of controlled fields on approval; drift detection, ADF diff, restore, AI field classification. App id `03bdbc73-…`, tables `bl_*`, branch `Not-Base-Version`. ~27.5k lines. It has more domain logic and less structural separation.

Baseline already vendored four modules from Signature (`ARCHITECTURE.md:189-192`): `ledger.js` *"verbatim"*, `eligibility.js` *"signer eligibility IS reviewer eligibility"*, `errors.js`, `content.js` *"vendored + extended"*. Baseline's doc states: *"Authentication is a silent feature. Baselining is the product."* The apps share copied code across two repos, but their databases cannot reconcile.

Jira lacks native automotive/regulated ALM capabilities that Signature, Baseline and later Traceability aim to provide. Two apps require auditors to correlate two hash chains and maintain duplicated code. Forge SQL databases are app-scoped, so a third traceability plugin cannot read either app's baselines or signatures. A trace matrix needs to answer *"coverage as of approved baseline v3"* to provide the baseline-aware query Codebeamer sells.

Approval uses interchangeable providers; the baseline retains the record. A capture consumes an `ApprovalRecord` regardless of how the approval was obtained. Today Baseline violates this: `src/gate.js:395` hardcodes `UNAUTHENTICATED_DECISION` when a decision lacks a WebAuthn `signature_id`. Replace that branch with an assurance-level comparison to support other approval providers.

## Decisions already made

| Decision | Rationale |
|---|---|
| **New repo `/Users/sriharsha/vatlassian-alm`, fresh `forge register`.** Both source repos stay untouched as read-only references. | Neither app is in production. The new app needs assembly rather than data migration. |
| **One consolidated migration set (~30 entries), not ~70 replayed.** | Zero installs means nothing to replay. This consolidation is possible before installation; append-only migrations start at v001 of the new app. |
| **WebAuthn/biometric dropped entirely.** Code stays alive on `Not-Base-Version` in the untouched repo. | It does not meet the intended compliance model. The popup ships without `@forge/bridge` by design, *"a popup has no Forge host to postMessage to"*, and runs outside the Forge session. Its `external.fetch.client: "*"` block would forfeit Runs on Atlassian for the whole merged app. Dropping it removes ~3,500 lines and restores eligibility. A `BIOMETRIC` assurance level stays reserved so management can reverse this without restructuring. |
| **Name: VAtlassian.** Repo `vatlassian-alm`, module keys `va-*`, tables `va_*`, CSS `va-*`. | Signature's schema and deny strings already use it; the largest body of ported code needs no rename. |
| **AI in scope; `llm` module declared in the first manifest.** | Adding `sql` or `llm` to a published app forces a major version bump + admin re-consent. Declare in phase 0, consume in phase 5. |
| **Traceability: seam only, no tables.** | Signature's `control-wiring.test.js` asserts that code references every table. A reserved empty table would fail that check. |
| **Confluence scopes dropped from v1.** | `grep -rni confluence` over Signature's `src/` + `frontend/src/` returns one hit, a comment in `migrations.js:127`. No code calls a Confluence API. The two scopes widen the consent request without a consumer. Add them in the release that ships sealed export. |

---

## Module merge

Both manifests declare overlapping modules. One row per merged module:

| Concern | Signature | Baseline | Merged | Winner |
|---|---|---|---|---|
| Storage | `sql: main` | `sql: main` | `sql: main` | Consolidated schema (§ below) |
| AI | — | `llm: bl-llm` | `llm: va-llm` | Baseline (sole impl) |
| Validator | `sig-gate` | `bl-gate` | `va-gate` | **Composed.** Signature's fail-closed skeleton + `rawCodeSubmitted()` credential-leak trap; Baseline's `block_on_drift`, re-checked eligibility, CAS consume |
| Approval field | `sig-signature-code` (UI Kit `render: native`) | `bl-auth-field` (Custom UI) | `va-approval-field` | **Signature's UI Kit**, extended to branch on the edge's required assurance. Baseline chose Custom UI only to host the WebAuthn ceremony; that reason is gone. Keep `view` declared. Without it Jira prints the stored id |
| Issue panel | `sig-panel` "Electronic Signature" | `bl-panel` "Baseline" | `va-panel` "Approval & Baseline" | **New composed screen**, one `panel:getState` |
| Issue context | — | `bl-context` | `va-context` | Baseline. Must use one indexed read because it renders on every issue view |
| Global page | `sig-queue` "My Signatures" | `bl-queue` "Baseline reviews" | `va-worklist` "My approvals" | Signature's `QueueList.tsx` base + Baseline's drift columns |
| Admin page | `sig-admin` (manifest `sections`/`route`) | `bl-admin` (in-app `?tab=`) | `va-admin` + `va-admin-configure` | **Signature's `sections` + `view.createHistory()`.** Deletes ~90 lines of Baseline's custom URL-state code |
| Personal settings | `sig-totp-settings` | — | `va-authenticator` | Signature |
| `trigger-on-issue-updated` | ✓ | ✓ (**exact key + event collision**) | `va-on-issue-updated` | Signature's shell (receipt dedupe, `productionDeps()`) calling Baseline's `lib/collect.js`. Double-collection would produce duplicate drift rows and duplicate ledger events |
| transitioned / deleted / issue-link triggers | — | ✓ | `va-on-issue-{transitioned,deleted,link}` | Baseline |
| Scheduled ×3 | ✓ | ✓ | same three keys | Baseline's `safely()` wrapper + union of both job lists. Wire `job-seal`. Signature declares it, `jobs/seal.js` is 207 implemented lines, and nothing calls it |
| Resources | `main-ui` + 2 UI Kit | `main-ui` + `webauthn.html` | `main-ui` + 2 UI Kit | Signature. The second Vite entry, `modulePreload.resolveDependencies`, `vendor-webauthn` and `scripts/check-popup-bundle.mjs` exist only for the popup. Remove them. Baseline's `codeSplitting.groups` (`ui`/`admin`/`review`) remains useful for code splitting |

**Scopes:** `storage:app`, `read:jira-work`, `write:jira-work`, `read:jira-user`, `manage:jira-configuration`, plus `manage:jira-project` *only if a caller is proven* (Baseline declares it; no obvious consumer found). A test enforces the absence of `remotes` and `permissions.external`.

---

## Consolidated schema in one `va_*` namespace

Keep Signature's tables unchanged. Map Baseline's tables as follows:

| `bl_*` | `va_*` | Resolution |
|---|---|---|
| `bl_config`, `bl_audit`, `bl_event_receipt` | `va_config`, `va_audit`, `va_event_receipt` | Identical shapes. **One ledger, one hash chain.** `signature_id` → `approval_id`. `EVENT` = union of both vocabularies |
| `bl_gated_transition` | `va_controlled_transition` | Union, **minus `require_auth`** (the boolean assurance replaces), **plus `required_assurance`** and `capture_baseline` |
| `bl_controlled_field` | `va_controlled_field` | `bl_` side is the superset (`store_values`, `materiality`, `writable`, `schema_type`) |
| `bl_reviewer` | `va_eligibility` | Same concept. `bl_`'s `issue_type_id='*'` wildcard is the superset. Keep the `va_` name to match the 11.10(g) term "authority checks" |
| `bl_review` | `va_item_state` | Union. State enum = union, deduped (`UNSIGNED`→`UNAPPROVED`, `CLEAN`≡`BASELINED`) |
| `bl_baseline` | `va_baseline` | **+ `approval_id`, + `assurance_level`.** Drop `signature_id`/`decision_id` |
| `bl_baseline_value` | `va_baseline_value` | Verbatim, including `(issue_id, version, field_id, seq)` chunking to meet the 6 MiB row / 4 MiB response limits |
| `bl_drift`, `bl_restore` | `va_drift`, `va_restore` | Verbatim; `decision_id` → `approval_id` |
| `bl_report` | `va_ai_report` | Renamed because "report" is ambiguous once restore reports and export records share a schema |
| `bl_write_suppression` | `va_write_suppression` | Required or every restore re-triggers itself as drift |
| **`bl_decision` + `va_signature`** | **`va_approval`** | The central merge is described below |
| `bl_credential`, `bl_auth_challenge`, `bl_signature` | — | Not ported (WebAuthn) |

**Dropped from Signature: `va_content_change`.** It and `bl_drift` model the same fact. `va_content_change` is item-level with a TEXT blob; `bl_drift` is per-field, author-attributed, materiality-classified, joinable to a restorable value, and is what the diff/report/restore engines read. Signature's content-review admin screen survives as a filter over `va_drift WHERE approval_id IS NULL`.

### The `va_approval` ApprovalRecord

`va_signature` (edge binding, `meaning`, `printed_name`, `content_hash`, `covers_from/to_hash`, PENDING/CONSUMED/VOID, `expires_at`) ∪ `bl_decision` (baseline linkage, `drift_count`, `report_hash`, `note`, CAS consume), with four columns replacing both apps' hard-wired credential assumptions:

```
assurance_level   VARCHAR(24)  -- NATIVE_TRANSITION | JSM_APPROVAL | ESIGNATURE | BIOMETRIC
provider_id       VARCHAR(32)  -- native | jsm | totp | (webauthn)
provider_ref      VARCHAR(255)
provider_evidence TEXT         -- canonical JSON, provider-shaped
evidence_hash     CHAR(64)
```

The row **is** the capability token the validator consumes, unchanged in shape from both apps:
`UPDATE va_approval SET state='CONSUMED', consumed_at=? WHERE approval_id=? AND state='PENDING' AND expires_at > ?`

Store the assurance level twice: on `va_approval` (what the approval *was*) and on `va_baseline` (what the record *is backed by*). The baseline outlives the approval under any retention policy; its assurance claim must remain verifiable after approval pruning. `lib/exportRecord.js` emits it on both, with a plain-English line per level.

Ordering `NATIVE_TRANSITION < JSM_APPROVAL < ESIGNATURE < BIOMETRIC` lives once in `src/lib/approval/levels.js`. `va_controlled_transition.required_assurance` names a floor; the gate compares. New deny reason `INSUFFICIENT_ASSURANCE` replaces `UNAUTHENTICATED_DECISION` and names the level obtained, the level required, and how to obtain it.

### Traceability seams (structural, not schematic)

1. Use `va_baseline.baseline_id` to link trace data. `va_baseline_value` gives per-field approved content, `va_drift` per-field change, `va_approval` who signed. A matrix joins on `(baseline_id, field_id)`.
2. Keep `va-on-issue-link` wired to supply edges for a trace graph.
3. **Reserved names as a comment block in `migrations.js`, not DDL:** `va_trace_node`, `va_trace_edge`, `va_trace_run`; `va_config` key prefix `trace.*`.
4. **`va_controlled_field.materiality`/`field_kind`** already classify fields. Add a requirement/verification role as one enum value rather than a new table.

---

## Port plan

**Verbatim from Signature:** `lib/{hash,totp,ledger,signatures,issueLookup,adf,retention,exportRecord,alerts,gateDrift,deviceCheck,directory,directoryReconcile,credentialRecovery}.js`, `db/alertStore.js`, `jobs/{migrate,verify,seal,gatecheck,devicecheck,alerts,reconcile,rehash}.js`, `resolvers/{totp,credentialKey}.js`, `src/ui-kit/view.jsx`, `frontend/src/ui/*`, `frontend/src/admin/pages/*`, `totp/TotpEnrollment.tsx`, `queue/QueueList.tsx`, tsconfig + oxlint, and 15 of 22 test files.

**From Baseline, with named changes:** `lib/content.js` (superset, 444 vs 192), `lib/eligibility.js` (superset with wildcard issue type), `lib/changelog.js` (superset, 245 vs 40), `lib/{db,db/store}.js` (supersets), `lib/{baseline,capture,collect,valuestore,materiality,decision,report,aiClassification,trackedFields,recall,record,roles,transitions}.js`, `lib/diff/*` and `lib/restore/*` (retarget table names only. Keep the diff engine unchanged), `db/{baselineStore,driftStore,restoreStore,reportStore,configStore}.js`, `db/reviewStore.js` → `db/itemStateStore.js`, `triggers/{issue-transitioned,issue-deleted,issue-link}.js`, `jobs/{prune,adoptFields}.js`, `test/smoke.mjs`, and the frontend screens (→ TypeScript, § below).

**Vendored-pair resolutions:** `ledger.js` → **Signature** (keeps the measured-starvation rationale; take the union `EVENT` enum). `content.js`, `eligibility.js`, `changelog.js`, `db.js`, `db/store.js` → **Baseline** (strict supersets). `errors.js` → **neither**; union both `DENY` dictionaries, delete `UNAUTHENTICATED_DECISION`, add `INSUFFICIENT_ASSURANCE`, and resolve the `SCREEN_EVIDENCE` conflict. Signature exports an object and Baseline a string; a silent shape change here fails at runtime, not at build. `interception.js` → **split**: Signature's interface (8 exports vs 4), Baseline's `supersedeOnReviewEntry()` (Signature's `supersede()` would disarm drift detection the moment an item moves onward, which would defeat baseline governance).

**Deliberately not ported:** the WebAuthn set (`lib/webauthn.js`, `resolvers/auth.js`, `db/{credentialStore,challengeStore,signatureStore}.js`, `lib/browserKey.js`, `frontend/webauthn.html`, `popup/`, `panel/{WebAuthnPopup,EnrolChoice,AuthField,deviceAuth}`, `scripts/check-popup-bundle.mjs`, 5 test files, `@simplewebauthn/server`, migrations v035–v044); debris (`scratch.js`, `src/test-fields.js`, `db.sqlite3`, committed `frontend/dist/`, Signature's `.archive/`); and eleven duplicate approval entry points. Baseline's `authoriseFirstApproval`/`recordFirstApprovalOnly`/`recordFirstApprovalRejectOnly`/`firstApproval`/`recordOnly` and Signature's `panel:{sign,signContent,preauthorize,rejectContent,reject}` all become `approval:submit` + `approval:retryTransition`.

---

## Resolver decomposition

Both apps hit ~2,200 lines in `panel.js` for the same documented reason: a Custom UI `invoke()` reaches only its own module's declared resolver, so every screen shares one function for its endpoints. Keep their business logic in separate use-case modules.

> **R1** — Resolver files contain only imports, `resolver.define()` calls, and argument extraction. No SQL, no `@forge/api`, no `@forge/sql`, no business branching.
> **R2** — Every `resolver.define('<domain>:<name>')` delegates to exported `<name>` in `src/usecases/<domain>.js`. The key is the function's address.
> **R3** — Ceilings: resolver file ≤ 400 lines, any `define` body ≤ 25, use-case module ≤ 300, `src/lib/**` ≤ 500.
> **R4** — Exactly one resolver key writes `va_approval`. `INSERT INTO va_approval` appears in exactly one file.
> **R5** — For every manifest module, every `invoke()` reachable from the screen it renders must be defined on the resolver it declares.

Enforced by **`test/resolver-wiring.test.js`**, written in the style of Signature's existing `test/control-wiring.test.js` (which already asserts *"every table created by a migration is referenced by some code"* and *"every event this app claims to record is actually appended somewhere"*). It asserts: no duplicate keys app-wide; every key has a use case; resolvers match no SQL/Forge-API pattern; the line ceilings; the approval-endpoint set equals the pinned `['approval:submit','approval:retryTransition']` (an exact set, so a sixth path fails rather than passing silently); R5 by walking the import graph from each frontend component and each resolver handler; and that every `ASSURANCE_LEVEL` has exactly one provider module under `src/lib/approval/providers/` exporting the same three functions, with no file outside `registry.js` importing a provider directly. This keeps BIOMETRIC support behind the provider interface.

Target: `resolvers/panel.js` ≈ 250 lines of dispatch over `usecases/{panelState,approval,drift,restore,queue,report}.js`; `resolvers/admin.js` ≈ 300 over `usecases/{admins,eligibility,transitions,fields,evidence,retention}.js`.

---

## Frontend

**TypeScript on Signature's design system.** `frontend/src/ui/tokens.css` (909 lines vs Baseline's 710) + `primitives.tsx` + `format.ts` is the more complete system, already typed, already linted with oxlint. One mechanical `fs-` → `va-` class rename lands as a single phase-0 commit, before any Baseline component arrives, so nothing is ported twice. Baseline's ~6,700 `.jsx` lines convert to `.tsx`, of which ~1,290 (WebAuthn popup, deviceAuth, EnrolChoice) aren't ported at all.

Baseline's `BaselinePanel.jsx` (678) splits into `panel/IssuePanel.tsx` shell + `sections/{BaselineRecord,DriftSection}.tsx`, with its fetch/poll logic becoming `panel/usePanelState.ts` (from `useFreshState.js`). `DiffView`/`DiffModal`/`ReportView` move to `review/` and stay in the lazy `review` chunk. `AdminConsole.jsx` (1,308, 14 components in one file) splits into route files matching Signature's `admin/pages/*` structure, with the AI classification flow living on `FieldsPage.tsx`.

**One merged issue panel**, one `panel:getState` returning `{ eligibility, approval, record, drift }`. Render order: drift banner → approval control → baseline record, with the most urgent fact first and evidence last. The **assurance chip** on the record header shows the approval provider: a customer can see that one issue was approved by a Part 11 e-signature and another by a workflow transition, and that the app knows the difference. Same string goes into `exportRecord`. `va-context` calls `panel:getGlanceState` only. It uses one indexed read and calls neither the diff engine nor the LLM (asserted by test; both modules render on every issue view).

---

## Build sequence

Each phase ends with something installable and operable, not with files moved.

**Phase 0. Verify the app setup end to end before adding domain code.** Repo skeleton, the full merged manifest (including `sql` and `llm`, both declared now to avoid a later re-consent), `lib/db.js`, migrations containing only `va_config` + `va_audit`, `lib/ledger.js` + `db/store.js`, `jobs/migrate.js`, the frontend bundle with the module-key switch and renamed tokens, throwaway "hello, I am `<moduleKey>`" screens on all eight surfaces, and the three wiring tests.
*Exit:* `forge deploy && forge install` on a dev site; all eight surfaces open and name their module key; the admin left nav renders all routes from the manifest and browser-back works; migrations report applied within five minutes; `npm run verify` green.
**And the one thing that must be settled here:** put the throwaway UI Kit `edit` component on a real transition screen and confirm it renders instead of Jira's built-in string editor. See risk 1. This check is required to complete phase 0.

**Phase 1. Identity, authority and evidence.** `va_{admin,eligibility,credential,credential_reset_grant,controlled_transition}`; `resolvers/admin.js` + `usecases/{admins,eligibility,transitions}.js`; TOTP enrolment; `jobs/{verify,directoryReconcile,devicecheck,alerts}.js`; the union `EVENT` enum.
*Exit:* an admin bootstraps, grants an approver eligibility on a project, declares a controlled edge; a user enrols TOTP and verifies a code; all of it lands in `va_audit` and `admin:verifyLedger` walks the chain clean. Signature's 15 ported tests pass.

**Phase 2. Implement approval before adding baseline code.** `src/lib/approval/{levels,record,registry}.js` + `providers/{native,esignature,jsm}.js` (jsm present, wired, returning a recorded `NOT_CONFIGURED` refusal); `db/approvalStore.js`; `usecases/approval.js` with the single `submit()`; `src/gate.js` consuming `va_approval` by CAS with `INSUFFICIENT_ASSURANCE`; `src/ui-kit/edit.jsx` branching on required assurance.
*Exit, demonstrated on a dev site:* a controlled transition is blocked with a message naming the required assurance. The approver approves in the panel with a TOTP code; the transition succeeds; `assurance_level = 'ESIGNATURE'`. An admin then lowers that edge to `NATIVE_TRANSITION`; the same transition now succeeds from the transition screen with a plain confirm and records `NATIVE_TRANSITION` with no code change. This demonstrates provider interchangeability.
Also instrument the gate and record p99 latency. Signature's `BUILD-PLAN.md` §3.2 calls validator latency the #1 build risk and says measure it in week 1; it later materialised on AUT-1 as an unlogged kill presenting as "couldn't invoke validator". Do it before phase 3 adds anything to that path.

**Phase 3. Capture and the baseline record.** `lib/{content,trackedFields,aiClassification,baseline,capture,valuestore}.js`, `va_{controlled_field,baseline,baseline_value}`, `triggers/issue-transitioned.js`, `db/baselineStore.js`, admin `FieldsPage`, panel `BaselineRecord`, `jobs/adoptFields.js`.
*Exit:* approving a gated transition produces `va_baseline` v1 with per-field digests, retained values for opted-in fields, honest `fidelity` grading (`EXACT`/`RECONSTRUCTED`/`PARTIAL`), and the approval's assurance level stamped on the row. `admin:exportRecords` emits it in both human-readable and electronic form.

**Phase 4. Drift, diff and restore.** `lib/{collect,materiality,changelog,interception,decision}.js`, `lib/diff/*`, `lib/restore/*`, `va_{drift,write_suppression}`, the three remaining triggers, `jobs/{reconcile,rehash}.js`, `review/DiffView.tsx`, the gate's `block_on_drift` clause.
*Exit:* edit a controlled field on a baselined issue; the panel shows attributed, typed, per-field drift within seconds. Approve ratifies to v2 with a new `va_approval` row. Reject restores every restorable field, verifies by re-read, and reports honestly what it could not put back. The gate blocks the next controlled transition while drift is undecided.

**Phase 5. AI, evidence and retention.** `lib/report.js`, `va_ai_report` caching, `ReportView.tsx` with citation chips; `jobs/{gatecheck,seal,prune}.js`; `lib/{retention,exportRecord,gateDrift,alerts}.js` fully wired; admin Evidence routes.
*Exit:* a report generates once per evidence set; every `driftId` the model emits is validated against the set actually sent, and ungrounded groups are flagged. Removing the `llm` module leaves a working panel with a rule-based summary. Daily chain verify green and sealing a segment.

**Phase 6. Hardening.** oxlint clean; `smoke.mjs` importing every backend module; the 1 GiB storage budget modelled against the combined ledger-plus-values footprint; `PORT-LOG.md` mapping every merged file to its source path; docs recovered from Signature's `backup-before-push` branch (`git show backup-before-push:BUILD-PLAN.md`) and rewritten for the merged product.

---

## Risks and pre-flight checks

1. **Verify UI Kit `edit` in the transition dialog during phase 0, before registering the field key.** `Forge Signature /manifest.yml:175-186` records, dated 2026-08-21 and *still marked unexplained*, that the transition dialog rendered Jira's built-in string editor while `view` mounted correctly from a sibling resource, and that the gate logged `{"hasToken":false,"hasRawCode":false}` on two attempts with a code in the box. The value never reached the validator. The manifest's leading theory is that Jira **froze the field's metadata at first registration** and kept serving the original. A fresh app id resets that metadata once; verify it before using the field. Fallback is Baseline's Custom UI form (a five-line manifest change; both implementations already exist to copy). If neither works, dropping the transition-screen route and making the panel the only approval path is a product decision to take deliberately, not a bug to chase across three deploys.
2. **`edit.experience` is not CLI-validated.** Signature records that `@forge/manifest` 13.3.1 accepts bogus values on a permissive `anyOf` branch. A typo deploys silently and reappears as a deny loop with no other symptom. Re-verify `'issue-transition'`/`'issue-view'` against the published enum and pin both as exact strings in `test/manifest-lint.test.js`.
3. **After first deploy, open Jira's custom field admin** and confirm the registered field's name and description match the manifest. If not, the registration froze on something else and the key must change before any customer data exists. A new key creates a new field rather than renaming the old one.
4. **Verify `llm` and Runs on Atlassian eligibility.** Baseline's manifest and `ARCHITECTURE.md` §9 assert it as a quotation from Atlassian's docs; that is a claim inside a repo, not independently confirmed. Check the Forge LLMs reference and the Runs on Atlassian eligibility page before the module ships. The fallback already exists. Both `lib/report.js` and `lib/aiClassification.js` import `@forge/llm` lazily and degrade to `ruleBasedSummary`/`heuristicClassify`. Let no code path depend on the model being present.
5. **`permissions.external` and `remotes` must never appear.** One line decides Runs on Atlassian, which is the strongest commercial argument for regulated buyers. `test/manifest-lint.test.js` reads `manifest.yml` and fails on either key.
6. **Storage ceiling.** `BUILD-PLAN.md` §3.3 models 1 GiB as ~2.9 years for a signature-only ledger. The merged app also stores field *values*. The ceiling arrives sooner but the difference has not been modelled. Model it before first publish. Related: Signature's `lib/retention.js` and Baseline's `jobs/prune.js` currently disagree about what may be deleted. One policy module decides and it should be `retention.js`, because it is the one that refuses to prune without evidence the record survives elsewhere.
7. **Forge SQL constraints must survive the port intact:** no `LIMIT ?` (already asserted by `intercept-wiring.test.js`, keep that test), no transactions, no foreign keys, no `AUTO_INCREMENT`, hashes computed in Node never via `SHA2()`, 6 MiB row / 4 MiB response (which is why `va_baseline_value`'s per-field chunking is not optional).
8. **`jira:workflowValidator` and `jira:personalSettingsPage` are Preview.** Both are required and have a one-month deprecation window. Monitor the changelog.
9. Keep `manage:jira-project` only if a caller requires it.
10. **`configurationDescription` expressions fail silently when wrong.** Both apps use different ones; verify the merged expression renders in the workflow editor.

## Verification

- `npm run verify` (`node --test test/*.test.js` + `test/smoke.mjs`) green at every phase. Combined target ≈ 450+ tests: Signature's 22 files minus none, Baseline's 22 minus the 5 WebAuthn files, plus `manifest-lint`, `resolver-wiring` and `assurance-wiring`.
- Each phase's *Exit* criterion above is executed on a live Jira dev site via `forge deploy && forge install --upgrade`, not asserted from tests alone. Phases 0, 2 and 4 in particular are only complete when demonstrated in the product.
- The phase-2 exit verifies the architectural goal by running the same transition under two assurance levels with no code change.