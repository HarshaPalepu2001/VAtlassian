# Governed verification UI implementation

Task 3 is implemented locally. No commit, deployment, Jira mutation or live TOTP ceremony was performed.

## Files

- `frontend/src/testmgmt/GovernanceView.tsx`: source-baseline readiness and staleness, mandatory assignment combinations, separate candidate-target and historical-metadata exception forms, frozen content and configured TOTP approvals, audited activation recovery, closure evaluations and frozen JSON dossiers.
- `frontend/src/testmgmt/IntakeControls.tsx`: authenticated project token lifecycle, one-time token display, execution/run grants, capped grant expiry, explicit mapping template, authenticated receipt detail/progress and retry.
- `frontend/src/testmgmt/ExecutionView.tsx`: lazy CI-intake tab, server attempt sequence and classification/build/provenance display, exact evidence digest, optional add-run classification/build fields, explicit machine review affirmation, unresolved-receipt/result-audit signing block.
- `frontend/src/testmgmt/TestPanel.tsx`: source governance integration alongside source coverage.
- `frontend/src/testmgmt/TestView.tsx`: readable exact signed test-version identifiers for assignment preparation.
- `frontend/src/testmgmt/types.ts`: schema-2 run metadata and receipt-readiness fields.
- `frontend/src/admin/pages/TestManagementPage.tsx`: independent assignment/target/exception chains, governance author separation and source-work-type role grant preview. Configured governance roles are preserved when another source-type preview lacks a grant.
- `frontend/test/testmgmt-governance.test.mjs`: 14 UI behavior tests.

## Evidence boundaries

Historical metadata displays `Not recorded`. Machine provenance remains distinct from human reviewers; the machine signing affirmation is exactly `I reviewed these machine-recorded results and their evidence.` Manual run signers retain the server's configured recorder meaning.

Receipt status and audit confirmation are displayed separately. Every affected run is visibly blocked until the entire receipt is APPLIED and audit-confirmed. Intake controls are loaded on the first visit to their tab, then remain mounted to preserve edits.

The source forms use the governance source context; project intake tokens and execution grants use the execution context. Server authorization is authoritative. Preparing a governing record does not invoke signing or activate it. Configured approvals use the existing TOTP SignBox.

Evaluations display frozen selected attempts, server sequence, qualification and named accepted historical gaps. `VERIFIED_WITH_EXCEPTION` does not claim a missing build identity is proved. Denied recorded evaluations remain exportable. Unconfirmed evaluations are denied and have no export control. Export addresses an exact saved evaluation ID and validates the returned evaluation ID/digest before downloading its JSON record. Gate permission and observed Jira transition facts have separate labels; uncorrelated observations do not claim linkage.

## Verification

- Red tests observed for historical metadata, machine review meaning and unresolved receipt blocking before implementation.
- Red tests observed for independent governance chain controls, add-run metadata controls, APPLIED-without-audit UI, grant/token expiry ordering and visible exception gaps before their fixes.
- First full frontend run found four regressions caused by eager hidden-tab intake requests; lazy initial loading fixed all four, confirmed by the existing hardening suite.
- Final `npm --prefix frontend test`: **315 passed, 0 failed**, including 14 new governed UI cases (31.96 seconds).
- Final `npm --prefix frontend run build`: passed TypeScript and Vite build. Vite reports its shared UI chunk exceeds 500 kB after minification.
- Targeted `oxlint` for GovernanceView, IntakeControls, ExecutionView and TestManagementPage: passed.
- `git diff --check -- frontend`: passed.

## Limitations

Tests use the existing happy-dom React harness and mocked Forge transport. They establish local UI behavior and payload contracts, not deployed Forge eligibility, tenant permissions, actual CI delivery, browser visual acceptance or live signatures.

The target form intentionally prepares sender-attested identity as `{ "id": "candidate-id" }`; CI must send the exact same identity object. Other supported CI identity fields remain usable through backend APIs, but do not have dedicated target-form controls in this first UI.

The CI mapping template intentionally contains invalid placeholder outcomes and a placeholder idempotency key/build ID until CI supplies actual values. The deployment operator supplies the deployed static intake endpoint. The UI does not submit CI outcomes or fetch URLs/artifacts.

The transition observation display renders facts frozen in the evaluation. Any separate transition-observation integration and verified correlation are owned by the parent integration task.
