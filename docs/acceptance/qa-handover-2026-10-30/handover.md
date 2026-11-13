# Payment reconciliation QA handover — 30 October 2026

Live Jira plan: https://mgtechdemo.atlassian.net/browse/VAT-99
Prerequisites: https://mgtechdemo.atlassian.net/browse/VAT-100
Unstarted execution: https://mgtechdemo.atlassian.net/browse/VAT-101

QA HANDOVER: PAYMENT RECONCILIATION | 30 OCT 2026
Status: DRAFT FOR REVIEW; test execution NOT STARTED.

REQUIREMENT BASIS
VAT-12: exactly one ledger match; Exact ref+amount+currency with zero tolerance; Split ref+currency with exact summed amount; FX converted amount within +/-1 minor unit; >=99.5% on September replay; every unmatched row has an exception reason; batch reruns idempotent.
VAT-13: exception fields, mandatory resolution comment, >24h highlighting, <=15-minute visibility. VAT-15: known double-rounding defect; historical build 2026.09.19-3 is not the handed-over build.
Main source VAT-12 currently belongs to VAT-87; preserve existing requirement text, parent, baseline and statuses.

ASSUMED HANDOVER
Development is handed to QA for this exercise. No SCM/repository or verified build was supplied. Existing Jira status is not proof of implementation. Target service URL, credentials, deployment receipt, supported matcher entry point, schema, data/reset controls, FX rate contract and September replay data remain unavailable. Use only synthetic data; no money movement.

TEST SCOPE / TRACEABILITY
VAT-89 | TC-01 | Exact matching requires merchant reference, amount and currency | VAT-12 / Exact rule
VAT-90 | TC-02 | Split settlements match the exact sum without currency mixing | VAT-12 / Split-settlement rule
VAT-91 | TC-03 | FX tolerance boundaries and the VAT-15 double-rounding regression | VAT-12 / FX rule; VAT-15 known defect
VAT-92 | TC-04 | Ambiguous matches never silently consume multiple ledger entries | VAT-12 / exactly-one-ledger-entry user story
VAT-93 | TC-05 | Every unmatched settlement appears with a defensible reason code | VAT-12 AC2; VAT-13 reason codes
VAT-94 | TC-06 | Re-running a completed batch is idempotent | VAT-12 AC3
VAT-95 | TC-07 | Interrupted and concurrent retries preserve reconciliation integrity | VAT-12 AC3; proposed recovery extension
VAT-96 | TC-08 | September replay meets the 99.5 percent auto-match acceptance target | VAT-12 AC1
VAT-97 | TC-09 | Exception queue displays complete unmatched rows within 15 minutes | VAT-12 AC2; VAT-13 AC1 and AC4
VAT-98 | TC-10 | Exception resolution needs a comment and aging highlights only after 24 hours | VAT-13 AC2 and AC3; adjacent workflow coverage

RUN ORDER
1. Confirm requirements, build/environment receipt, dataset and isolated reset procedure.
2. Smoke: TC01, TC05, TC06.
3. Matching/regression: TC02, TC03, TC04.
4. Exception workflow: TC09, TC10.
5. Supported recovery/concurrency: TC07.
6. Full authoritative September replay and acceptance calculation: TC08.

PROPOSED CONFIGURATION MATRIX
Matcher/service: QA environment URL and deploy/build receipt TO BE SUPPLIED.
Ledger currency: INR; FX source EUR with approved exact decimal rate/time/rounding policy TO BE SUPPLIED.
Queue: finance-analyst session; Chrome current; synchronized UTC capture, local display timezone noted.
Rule contexts: exact / split / FX; fresh / replay / supported interruption+concurrency.
No Jira release was invented or selected; release identity must come from the handover owner.

REQUIREMENT QUESTIONS FOR REVIEW
Q1 Exactly-one ledger entry versus split cardinality/grouping window: what consumes what?
Q2 Two eligible ledger candidates or competing settlements: fail/queue/tie-break and ledger-reuse rule?
Q3 FX rate source/effective time, rounding mode, conversion point and currencies without two decimals?
Q4 99.5% numerator/denominator: splits, duplicate files, malformed/excluded rows, legitimate exceptions and exact threshold arithmetic?
Q5 Duplicate business identity versus transport replay; multiple error reason precedence?
Q6 15 minutes measured from settlement, ingestion or match completion; business clock/timezone; exactly24h aging?
Q7 Required artifact/build evidence when no SCM exists; authorised acceptance and independent QA owners?

ENTRY CRITERIA
Reviewed cases/assumptions; signed test versions where required by VAtlassian; source/Verifies policy available; known QA service and explicit deployment/build receipt; versioned synthetic/replay data; isolated reset/recovery; required tester/QA/analyst access; reproducible invocation and evidence exports. SCM is optional for designing/exercising tests, but record exactly what deployed artifact was tested.

PROPOSED EXIT CRITERIA (OWNER REVIEW REQUIRED)
All required cases executed on the agreed build/configuration; no unreviewed P1 failures; VAT-15 retested with original reproduction data; TC08 >=99.5% under approved counting; no dropped rows or duplicate financial effects; every failed/blocked/not-run item disclosed; evidence retrievable; independent review and explicit release decision. Execution Done alone is not product acceptance.

DEFECT / RETEST PROCESS
Record observed failures with case/version, input, actual versus expected, environment/build receipt, time and evidence. Do not file assumed behavior as an observed defect. Reference existing VAT-15 rather than duplicate it. Preserve failed attempts and create new retests for supplied fixes. Automatic VAtlassian bug creation occurs after the configured failed-run sign-off chain; use normal Jira defect reporting for a real urgent observed issue if needed.

PREPARATION BLOCKER OBSERVED
On new TestCase VAT-89, Test management DEV stayed in loading/skeleton state after opening and one reload. Structured app draft, signed version, native Verifies source association and runnable plan membership are not established by the Jira descriptions. Continue the app-native preparation when controls load.

CURRENT RESULT
Ten Jira TestCase drafts prepared with 30 explicit steps. No product test executed, no pass asserted, no existing issue transitioned, no source requirement or baseline modified, and no personal signature submitted.

## Verified record boundary

The cases are Jira TestCase descriptions with explicit actions/data/expected results and Jira Test Level / Manual fields. Plan-to-case relations use ordinary Jira relates-to links, not signed VAtlassian plan membership. App-native authoring, source Verifies projection, signed revisions and run creation remain unverified because the Test management panel stayed in loading/skeleton state on VAT-89 after reload. No product execution or personal signature was performed.

## Final live read-back

All ten TestCase descriptions were explicitly saved and read back with exactly three steps each (30 total), correct source text, draft state and preparation-only notice. VAT-99 was read back with entry/exit criteria and all ten case references. VAT-100 prerequisites and VAT-101 unstarted execution with ten checklist entries were also read back. The plan has twelve ordinary Jira relates-to links. A final opening of Test management on VAT-98 showed Loading; no app-native test definition, signed version, source projection or run is claimed. Five artifact uploads were attempted but Chrome file-URL access blocked the transfer; files remain local. No browser permission was changed.
