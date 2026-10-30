# Architecture review fixes. 28 October 2026

Scope: five reproduced defects in the current VAtlassian application, starting at `2a6f33a`. Five dedicated implementation agents handled the defects, followed by an independent local review and a scoped re-review. This report records the review checkpoint before commit and deployment.

## Fixed behavior

1. **Transition identity:** a signature receipt no longer selects the executing workflow transition. The gate resolves the trusted Jira payload/configuration/live edge independently, then checks its receipt and assurance. Ambiguous controlled siblings without a saved transition ID refuse. A matching configured receipt and an ordinary dashboard approval still work.
2. **Transition-screen content:** the drift check compares proposed fields, including ADF and explicit null clears. Proposed parent changes receive ancestor checks. Persisted policy scope and Test Execution completion checks remain authoritative, preventing a submitted type from selecting weaker rules.
3. **Controlled-field precedence:** exact work-type declarations override wildcard declarations before effective state filtering. An exact exclusion suppresses wildcard tracking and retention for that custom field; unrelated types retain the wildcard. The four mandatory-controlled fields remain controlled. Existing retained evidence is not deleted.
4. **Viewer-safe evidence:** diagnostics, restore state, completed retry responses, evidence history and summary errors use viewer-safe projections. Child access is checked in batches, unknown/refused checks hide child detail, and plans/candidate digests stay server-side. Root-safe state/progress remains available. Established approved historical evidence for removed baseline nodes is preserved without current values/errors. Opaque nested errors and copied refusal reasons receive generic explanations; fixed verifier guidance remains available. Authoritative worker data is unchanged.
5. **Saved configuration:** corrupt JSON, invalid governed object shapes and invalid security-setting types cause an explicit configuration error. Defaults apply only to absent records. Valid generic scalar values, explicit false values, user restore identity, known retired keys and legacy STRICT reads remain compatible. Invalid saved data is not automatically overwritten.

## Local verification

Every defect has regression coverage observed failing before its fix. Tests exercise production behavior; Forge/Jira transports are replaced where a local runtime needs them.

| Check | Result |
| --- | --- |
| Clean baseline backend | 2,086 passed |
| Final backend | 2,174 passed, 0 failed |
| UI tests | 301 passed, 0 failed |
| Module smoke imports | 258/258 |
| TypeScript and production UI build | Passed |
| Forge lint | 0 errors; existing wildcard client-egress warning |
| Diff whitespace | Passed |
| Independent review and scoped re-review | All five fixes passed; 0 remaining blockers |

The first independent review found one residual disclosure through nested restore errors and reasons. The visibility agent fixed it, and a scoped independent re-review closed it. Both reviewers and the integration agent reproduced the real `linkStateUnknown('99')` / `explainRefusals()` path; the final projection hides its private text while preserving readable field context and leaving worker input unchanged. This regression also covers diagnostics, restore state, completed retry and panel evidence.

Commands: `npm run verify`, `forge lint`, `git diff --check`. The UI build retains its bundle-size advisory. Detailed implementation reports, review reports and command logs are retained locally in `/private/tmp/vatlassian-architecture-fixes-20261028/`; final logs are `final-verify.log` and `final-forge-lint.log`.

## Acceptance boundaries

This is local implementation and regression verification. At this review checkpoint, no commits, deployment, installation upgrade, permission changes, tenant settings changes, live user authentication, or live Jira transition acceptance had been performed. Subsequent deployment results are reported separately.

Biometric functionality and the manifest were preserved. The separate Runs on Atlassian blocker remains: the existing wildcard client-egress declaration and dynamic diagnostic webtrigger. The earlier eligibility check reported development version 8.41.0 ineligible; that is not a new eligibility result for these undeployed changes.

Before production acceptance, validate the five cases in an authorized test tenant, including a viewer who cannot browse a protected child, a refusal on changed transition-screen content, and correct validator transition configuration for sibling edges. Authentication/signature steps require the human signer.
