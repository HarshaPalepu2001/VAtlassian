# Task 2: CI intake implementation

Implemented locally; no commits, deployment, installation changes, Jira mutation, or signing ceremony performed by this task.

## Exports and integration

- `src/usecases/testIntake.js`: `createTestIntake(deps)` returns `view({issueKey},actor)`, `createToken({issueKey,label,expiresAt},actor)`, `revokeToken({issueKey,tokenId},actor)`, `grant({issueKey,tokenId,runIds,expiresAt},actor)`, `revokeGrant({issueKey,grantId},actor)`, `receipt({issueKey,receiptId},actor)`, `retry({issueKey,receiptId},actor)`, `receive({authorization,body})`, and `process({receiptId})`.
- Resolver adapters: `getIntake`, `createIntakeToken`, `revokeIntakeToken`, `grantIntake`, `revokeIntakeGrant`, `getIntakeReceipt`, `retryIntakeReceipt`. Parent owns binding to `tm:intake:*` names.
- `src/testmgmt/intakeStore.js`: `createIntakeStore({query?})`, `INTAKE_MIGRATIONS` (v169 through v180). Parent imports migration array and composes store methods into runtime. v180 includes unique nullable `open_execution_id`, admitting one pending receipt per execution. APPLIED releases that admission lock for subsequent batches. Identical idempotency retries use the existing receipt. Concurrent different payloads for one execution are rejected while a receipt is pending.
- `src/testmgmt/intake.js`: `assertIntakeReady(run,deps)` returns `true` or throws; readiness checks all immutable receipt mappings for the run even before physical run reservation. Every receipt must be complete, APPLIED and confirmed against its exact ledger event. Missing machine receipt, corrupted original payload, mismatched provenance and inconsistent mappings fail closed.
- `src/jobs/ciIntake.js`: `runCiIntake(request, overrides?)`, `runCiIntakeWorker(event, overrides?)`, injectable factories and `CI_INTAKE_OUTPUTS`. Handler returns only `{outputKey}`. Worker accepts `event.body.receiptId` and throws processing errors for queue recovery.

Runtime requires base `readRun`, `readProject`, `readIssueAsUser`, `testManagementRole`, `hasIssuePermission`, `isEligibleFor`, `newHexId`, `now`, `audit`, all methods returned by `createIntakeStore()`, plus:

- `installationId`: server installation ARI string; no caller-supplied installation identity.
- `readIntakeExecution(executionIssueId)`: app-read Jira issue with id and project/issuetype/status fields; no user session is required for worker/webtrigger paths.
- `enqueueIntake({receiptId})`: enqueue only the receipt identifier. Worker loads authoritative content from SQL. Parent uses receipt-level queue concurrency.

Authorization for token/grant management uses execution issue scope: visible mapped EXECUTION, EDIT_ISSUES, and configured first run-chain role through `isEligibleFor`, preserving existing wildcard role-grant semantics. Grant creation also requires mapped tests to be visible to its human actor. Reading original receipt content requires every mapped test to be visible. Tokens are project and installation scoped; grants bind that token, project, installation, exact execution, explicit run IDs and expiry. UI token creation returns its random bearer secret once; SQL stores only its SHA-256 hash. Audit precedes initial token/grant insertion, so audit failure cannot leave a newly usable grant. Revocation writes fail closed before recording its audit event.

## Submission contract

POST `application/json` (optional UTF-8 charset), Authorization `Bearer tmci_<32-hex-token-id>_<64-hex-secret>`:

```json
{
  "idempotencyKey": "pipeline-12345",
  "executionIssueId": "12345",
  "grantId": "0123456789abcdef0123456789abcdef",
  "reportedBuild": {"id": "candidate-sha", "commit": "candidate-sha", "pipelineUrl": "https://ci.example/run/12345"},
  "results": [{
    "runId": "1123456789abcdef0123456789abcdef",
    "expectedRevision": 1,
    "steps": [{"stepId": "resolved_step_id", "iterationId": "default", "status": "PASSED", "actual": "Observed result", "comment": "", "log": "bounded original CI log"}]
  }]
}
```

Optional build keys are `name`, `commit`, `repository`, `pipelineUrl`, `artifactDigest`. Identity remains sender-attested. Every resolved step must occur exactly once with its prepared iteration; no discovery or inferred step matching. Unknown keys are rejected. Original string/UTF-8 bytes and SHA-256 digest are retained; even formatting differences under an existing idempotency key conflict. Bounds: 256 KiB payload, 50 runs, 500 resolved results in total, 4000 characters for actual/comment, 16000 characters for each original log, 90-day maximum token lifetime, grant expiry no later than token expiry. Detailed receipts are read only through authenticated Jira UI.

Original CI logs remain in the receipt, protected by payloadDigest included in signed machine provenance. Nonempty submitted `evidence` arrays are rejected. The first release does not claim submitted URLs or externally named artifacts as independently retained evidence; Jira attachment evidence can be added through the existing retained-evidence ceremony after APPLIED. No submitted URL is fetched.

## Ordering, application and recovery

Every `insertRun` uses a SQL singleton CAS clock, an immutable run-to-sequence allocator row and a new run's `attempt_sequence`. This avoids client clocks, build identity, and per-node AUTO_INCREMENT cache ordering. Clock contention retries ten times then fails closed; failed insertions can leave harmless sequence gaps. No historical rows or signed digests are backfilled. New rows have `evidenceSchema:2`; old missing fields read as null. Store and report adapters expose classification, reportedBuild, provenance, intakeReceiptId, attemptSequence.

Workers recheck installation, token/grant expiry and revocation, project configuration, execution type/status, and prepared-run digest. They reserve all receipt members before writing results. Each physical write uses expected revision and receipt ownership; application is idempotent. Per-run progress is durably marked. SQL write predicates additionally recheck token/grant expiry and revocation, closing the gap after an authorization read. Human `updateRunSteps`/`setRunState` have SQL pending-receipt guards; parent integrates `assertIntakeReady` across all human mutation/signing/closure paths.

Machine provenance is `{kind:'MACHINE',tokenId,grantId,installationId,receiptId,payloadDigest,receivedAt}`; step executor is `ci:<tokenId>`. Granting or reviewing humans never become the machine's executor. Parent owns shared signed-content extension and explicit human review meaning.

Receipt APPLIED requires every reserved run to be physically applied, all progress recorded, exact durable `TM_INTAKE_APPLIED` audit payload confirmed, and active authorization at activation. Outages retain receipt/progress for retry. Ordinary expiry/revocation stops further processing and may leave the candidate blocked; historical APPLIED receipts remain valid without requiring the original token to remain active. Such blocked candidates require preparing a new authorized candidate; no silent rollback or unaudited release is provided.

## Static manifest outputs

`CI_INTAKE_OUTPUTS` exports the exact records for `response: {type: static, outputs: [...]}`:

- accepted / 202 / application/json / `{"accepted":true}`
- rejected / 400 / application/json / `{"accepted":false}`
- unauthorized / 401 / application/json / `{"accepted":false}`
- too-large / 413 / application/json / `{"accepted":false}`
- unavailable / 503 / application/json / `{"accepted":false}`

Parent owns function/consumer/static webtrigger manifest entries. Existing app webtriggers and outbound permissions remain separate eligibility considerations.

## Verification

Focused tests were written and observed failing before implementation. Latest focused command:

`node --test test/testmgmt-ci-intake-handler.test.js test/testmgmt-intake.test.js test/testmgmt-intake-store.test.js test/testmgmt-run-metadata-store.test.js test/testmgmt-step-store.test.js`

Coverage includes static acknowledgments; method/content-type rejection; secret-free response; exact worker receipt dispatch; token/grant authorization/expiry/revocation; original payload/digest; idempotency conflict; exact step/iteration/run scope; total limits; machine executor preservation; partial write recovery; audit outage/recovery; receipt-wide signability; corrupt stored provenance/build/mappings; corrupt expiry; hidden mapped test receipt denial; SQL authority write guards; no historical backfill; global server CAS ordering; and pending-execution admission serialization.

Full repository verification is owned by parent to avoid concurrent competing full test runs. Forge deployment, migrations on a tenant, eligibility, queue delivery, token/permission configuration and live success/failure journeys are not established by local tests.
