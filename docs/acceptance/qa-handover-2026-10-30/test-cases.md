# Prepared manual test cases

All cases are drafts and NOT EXECUTED.

## VAT-89 — TC-01

QA handover 2026-10-30 | TC-01
Source: VAT-12 / Exact rule
Risk: P1: false financial match
Level: System; Manual

Preparation only: NOT EXECUTED. Handover simulation authorized 30 Oct 2026. No source repository, verified build, deployed matcher URL, September dataset or real payment access supplied. Use synthetic data only. Source behavior is based on the Jira text read today; assumptions need review. Evidence required at execution: identifiable environment/build receipt, input manifest, raw outputs, timestamps and reviewed results. No product pass/fail or compliance sign-off is asserted.

Step 1
Action: Load four isolated synthetic settlement/ledger pairs.
Data: X01 same ref/10000 INR; X02 different ref/10000 INR; X03 same ref/10001 vs 10000 INR; X04 same ref/10000 INR vs USD.
Expected: Only X01 is eligible for the exact rule; each fixture has a unique identifier.

Step 2
Action: Run matching once and inspect allocation records and exceptions.
Data: Use the documented matcher UI/API once supplied; capture request/job id and raw output.
Expected: X01 has exactly one correct ledger allocation. X02-X04 are not matched by the exact rule; an approved alternative rule must not be inferred.

Step 3
Action: Compare before/after ledger and exception counts.
Data: Save exported records and the tested build/environment receipt.
Expected: No unrelated ledger entry changes and no missing/duplicate settlement result.

## VAT-90 — TC-02

QA handover 2026-10-30 | TC-02
Source: VAT-12 / Split-settlement rule
Risk: P1: incorrect allocation or double counting
Level: Integration; Manual

Preparation only: NOT EXECUTED. Handover simulation authorized 30 Oct 2026. No source repository, verified build, deployed matcher URL, September dataset or real payment access supplied. Use synthetic data only. Source behavior is based on the Jira text read today; assumptions need review. Evidence required at execution: identifiable environment/build receipt, input manifest, raw outputs, timestamps and reviewed results. No product pass/fail or compliance sign-off is asserted.

Step 1
Action: Prepare isolated split groups with a shared merchant reference.
Data: S01 INR 6000+4000 -> ledger INR10000; S02 6000+3999; S03 6000+4001; S04 INR6000+USD4000.
Expected: Group identifiers are unique; exact FX and grouping policy is recorded before execution.

Step 2
Action: Execute matching and inspect the component-to-ledger relationships.
Data: S01-S04; test-group/window and cardinality are assumptions requiring confirmation.
Expected: S01 may aggregate to 10000 with no loss/double count. S02/S03 do not pass zero-tolerance split matching. S04 must not mix currencies under this rule.

Step 3
Action: Replay S01 and compare allocation totals.
Data: Same input and batch identity.
Expected: The sum and allocation identities remain unchanged; no second allocation is created.

## VAT-91 — TC-03

QA handover 2026-10-30 | TC-03
Source: VAT-12 / FX rule; VAT-15 known defect
Risk: P1: false mismatch or excessive tolerance
Level: System; Manual

Preparation only: NOT EXECUTED. Handover simulation authorized 30 Oct 2026. No source repository, verified build, deployed matcher URL, September dataset or real payment access supplied. Use synthetic data only. Source behavior is based on the Jira text read today; assumptions need review. Evidence required at execution: identifiable environment/build receipt, input manifest, raw outputs, timestamps and reviewed results. No product pass/fail or compliance sign-off is asserted.

Step 1
Action: Prepare five converted amounts around a fixed ledger amount.
Data: Ledger INR9381121 minor units; converted INR9381119,9381120,9381121,9381122,9381123. Rate source/time and rounding mode must be supplied.
Expected: Differences are -2,-1,0,+1,+2 minor units using independently checked decimal arithmetic.

Step 2
Action: Execute FX matching with one documented conversion/rounding stage.
Data: For each row use a unique merchant reference; include VAT-15 reference M-88213 as a separate known-defect reproduction.
Expected: Differences -1,0,+1 are within the stated tolerance; -2,+2 are not. No double rounding; do not invent an FX rate to reproduce the historical file.

Step 3
Action: Inspect both match results and exception reasons.
Data: Capture rate, raw/rounded conversion, ledger amount, job/build identity and outputs.
Expected: The +1-minor-unit case is not falsely AMOUNT_MISMATCH. VAT-15 remains an existing defect until actually reproduced/retested.

## VAT-92 — TC-04

QA handover 2026-10-30 | TC-04
Source: VAT-12 / exactly-one-ledger-entry user story
Risk: P1: duplicate or arbitrary financial allocation
Level: System; Manual

Preparation only: NOT EXECUTED. Handover simulation authorized 30 Oct 2026. No source repository, verified build, deployed matcher URL, September dataset or real payment access supplied. Use synthetic data only. Source behavior is based on the Jira text read today; assumptions need review. Evidence required at execution: identifiable environment/build receipt, input manifest, raw outputs, timestamps and reviewed results. No product pass/fail or compliance sign-off is asserted.

Step 1
Action: Prepare one settlement with two equally eligible ledger candidates and a second settlement competing for one candidate.
Data: D01: same ref/amount/currency for L1,L2; D02: two distinct settlements competing for L3.
Expected: Ambiguous-cardinality scenarios are isolated and initial allocations are empty.

Step 2
Action: Run the matcher and inspect persisted relationships.
Data: The split-settlement cardinality exception and duplicate selection policy are unresolved requirement questions.
Expected: Confirmed invariant: no settlement has multiple unexplained matches. Proposed safety expectation: ambiguous candidates are surfaced, not selected arbitrarily; business owner must approve this oracle.

Step 3
Action: Inspect exceptions, allocation totals and audit records.
Data: Record exact ambiguity/duplicate reason returned.
Expected: No silent dropped or double-consumed amount. Exact reason code and ledger-reuse policy remain review items, not asserted approved behavior.

## VAT-93 — TC-05

QA handover 2026-10-30 | TC-05
Source: VAT-12 AC2; VAT-13 reason codes
Risk: P1: missing financial exceptions
Level: Integration; Manual

Preparation only: NOT EXECUTED. Handover simulation authorized 30 Oct 2026. No source repository, verified build, deployed matcher URL, September dataset or real payment access supplied. Use synthetic data only. Source behavior is based on the Jira text read today; assumptions need review. Evidence required at execution: identifiable environment/build receipt, input manifest, raw outputs, timestamps and reviewed results. No product pass/fail or compliance sign-off is asserted.

Step 1
Action: Prepare four isolated unmatched conditions.
Data: E01 no ledger ref; E02 same ref/currency but amount differs beyond applicable tolerance; E03 same ref/amount with wrong currency and no approved FX path; E04 duplicate business settlement identity.
Expected: Synthetic rows are uniquely tagged; no real payments or financial side effects.

Step 2
Action: Run reconciliation and inspect the exception queue and raw result export.
Data: Expected vocabulary from VAT-13: NO_LEDGER_ENTRY, AMOUNT_MISMATCH, CURRENCY_MISMATCH, DUPLICATE_SETTLEMENT.
Expected: Every unmatched row is represented with a nonblank, defensible reason. E01-E03 use their isolated reason; duplicate identity/precedence for E04 requires owner confirmation.

Step 3
Action: Reconcile input count against matched and exception output.
Data: Store input, match and exception exports and row identifiers.
Expected: No missing unmatched rows and no unexplained duplicates; multi-reason precedence is recorded as an open question.

## VAT-94 — TC-06

QA handover 2026-10-30 | TC-06
Source: VAT-12 AC3
Risk: P1: duplicate matches or exceptions on retry
Level: Integration; Manual

Preparation only: NOT EXECUTED. Handover simulation authorized 30 Oct 2026. No source repository, verified build, deployed matcher URL, September dataset or real payment access supplied. Use synthetic data only. Source behavior is based on the Jira text read today; assumptions need review. Evidence required at execution: identifiable environment/build receipt, input manifest, raw outputs, timestamps and reviewed results. No product pass/fail or compliance sign-off is asserted.

Step 1
Action: Run an isolated mixed batch to completion and capture durable output.
Data: BATCH-QA-20261030-01 includes one exact match, one split group and unmatched cases.
Expected: Baseline match ids, allocations, ledger totals and exception ids/counts are saved.

Step 2
Action: Submit the identical batch identity and payload again, then repeat once more.
Data: Same batch/idempotency identity; identity contract must be confirmed before execution.
Expected: Repeated completion does not create a second business allocation, duplicate exception or extra financial effect. Transport/job-attempt logs may legitimately grow.

Step 3
Action: Compare normalized business records before and after both replays.
Data: Ignore documented attempt timestamps; retain raw evidence.
Expected: Stable business identities/counts/totals; new payload under a reused key is handled according to an explicitly approved conflict policy.

## VAT-95 — TC-07

QA handover 2026-10-30 | TC-07
Source: VAT-12 AC3; proposed recovery extension
Risk: P1: partial commit or duplicate consumption
Level: Integration; Manual

Preparation only: NOT EXECUTED. Handover simulation authorized 30 Oct 2026. No source repository, verified build, deployed matcher URL, September dataset or real payment access supplied. Use synthetic data only. Source behavior is based on the Jira text read today; assumptions need review. Evidence required at execution: identifiable environment/build receipt, input manifest, raw outputs, timestamps and reviewed results. No product pass/fail or compliance sign-off is asserted.

Step 1
Action: Prepare an isolated batch and a controlled recovery window.
Data: No production; obtain a supported timeout/fault method. Include a mixed match/exception batch.
Expected: Test owner authorizes safe interruption; before-state and recovery/reset procedure are recorded.

Step 2
Action: Interrupt after processing may have started; retry the same batch and submit two concurrent retries.
Data: Use documented matcher/job controls; do not kill arbitrary shared services.
Expected: Proposed expectation: one final business outcome per settlement, no partial duplicate allocation and an observable recoverable job state. Exact concurrency contract needs approval.

Step 3
Action: Wait for the documented completion limit and reconcile all outputs.
Data: Capture attempt ids, errors, row counts and final allocations.
Expected: No lost rows, double consumption or duplicated exception. Without supported fault controls this case remains blocked, not passed.

## VAT-96 — TC-08

QA handover 2026-10-30 | TC-08
Source: VAT-12 AC1
Risk: P1: accepting the feature on an incorrect rate
Level: Acceptance; Manual

Preparation only: NOT EXECUTED. Handover simulation authorized 30 Oct 2026. No source repository, verified build, deployed matcher URL, September dataset or real payment access supplied. Use synthetic data only. Source behavior is based on the Jira text read today; assumptions need review. Evidence required at execution: identifiable environment/build receipt, input manifest, raw outputs, timestamps and reviewed results. No product pass/fail or compliance sign-off is asserted.

Step 1
Action: Obtain the authoritative September replay dataset and its expected eligible population.
Data: Dataset manifest/checksum, exclusions, FX rates and independent expected outcomes are required; none has been supplied.
Expected: Dataset version and denominator are approved; planted incorrect/ambiguous matches cannot inflate successful matches.

Step 2
Action: Run the full replay on the identified build and compute the rate independently.
Data: Provisional formula: correct auto-matched eligible settlement rows / all eligible settlement rows * 100; owner must confirm split/duplicate/exclusion counting.
Expected: Observed correct rate >=99.5%, with exact numerator/denominator and no unsupported rounding up.

Step 3
Action: Check threshold arithmetic and retain the complete evidence set.
Data: Synthetic threshold examples: 199/200=99.5% and 198/200=99.0%; these do not replace the September replay.
Expected: Threshold arithmetic is transparent; raw replay results, exceptions, manifest and build receipt are retained. Actual acceptance stays unexecuted until the real dataset and service exist.

## VAT-97 — TC-09

QA handover 2026-10-30 | TC-09
Source: VAT-12 AC2; VAT-13 AC1 and AC4
Risk: P1: delayed or incomplete operational visibility
Level: Integration; Manual

Preparation only: NOT EXECUTED. Handover simulation authorized 30 Oct 2026. No source repository, verified build, deployed matcher URL, September dataset or real payment access supplied. Use synthetic data only. Source behavior is based on the Jira text read today; assumptions need review. Evidence required at execution: identifiable environment/build receipt, input manifest, raw outputs, timestamps and reviewed results. No product pass/fail or compliance sign-off is asserted.

Step 1
Action: Submit a known unmatched settlement in a controlled test environment.
Data: Synthetic merchant/ref/amount/currency and settlement timestamp; synchronized UTC clocks; queue access.
Expected: Settlement identity and authoritative time origin are captured. Timing-start interpretation must be confirmed.

Step 2
Action: Observe queue ingestion and capture the first visible timestamp.
Data: Poll at a documented interval; inspect just-before/at/after 15-minute boundary using a controllable clock or supported timestamp fixture.
Expected: Within 15 minutes the item is visible with merchant, amount, currency, settlement time and reason code. No invented performance measurement.

Step 3
Action: Replay the settlement and verify queue consistency.
Data: Save queue export/screenshots and event/job times.
Expected: No duplicate active exception from a transport replay; missing fields or excessive measured delay are recorded as actual failures only when observed.

## VAT-98 — TC-10

QA handover 2026-10-30 | TC-10
Source: VAT-13 AC2 and AC3; adjacent workflow coverage
Risk: P2: unauditable resolution or missed overdue items
Level: System; Manual

Preparation only: NOT EXECUTED. Handover simulation authorized 30 Oct 2026. No source repository, verified build, deployed matcher URL, September dataset or real payment access supplied. Use synthetic data only. Source behavior is based on the Jira text read today; assumptions need review. Evidence required at execution: identifiable environment/build receipt, input manifest, raw outputs, timestamps and reviewed results. No product pass/fail or compliance sign-off is asserted.

Step 1
Action: Prepare unmatched items at 23:59:59,24:00:00 and24:00:01 of age.
Data: Synthetic timestamps; supported clock/fixture control; UTC comparison; displayed timezone recorded.
Expected: Items and unambiguous age calculations are captured; requirement says older than 24h, so exactly24h is not older.

Step 2
Action: Attempt resolution with empty and whitespace-only comments, then with a meaningful comment.
Data: Perform only on isolated synthetic queue items with an authorized finance-analyst account.
Expected: Mandatory-comment rule prevents blank resolution; meaningful comment is retained with the result. Whitespace handling is a proposed interpretation to confirm.

Step 3
Action: Inspect highlighting and resolution visibility after refresh.
Data: Capture before/after queue records and actor/time evidence if the product exposes it.
Expected: The >24h item is highlighted; <24h is not. Exact boundary/timezone and resolution audit expectations are reviewed before formal acceptance.
