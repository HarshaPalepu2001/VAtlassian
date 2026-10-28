# Settings and access wiring verification — 26 October 2026

## Result and boundary

Initial verification covered local implementation and regression checks. The user subsequently authorized deployment; the deployment record is below. No Jira configuration change, administrator grant, authenticator reset, signature, or live workflow acceptance was performed. The current live lockout is not claimed resolved.

The change preserves existing approval, audit, credential lockout, and two-person recovery controls. A Jira administrator may repair the administrator roster and search for the person to appoint; that authority does not allow editing approval policies or issuing credential resets without an active VAtlassian administrator grant.

## Defects corrected

| Area | Cause | Result |
| --- | --- | --- |
| Add/remove role members | Base64 record IDs were bound directly to a BINARY(16) column instead of using FROM_BASE64 | Grants persist and read back with the same identity; revocation targets the stored record and checks that a row changed |
| Reviewer names | A new grant omitted the stored display name used by reviewer routing | New grants carry the resolved Jira display name |
| Administrator recovery | A Jira administrator could open the roster but could not use its user search | The roster picker permits either verified administrator authority; controls remain app-admin-only |
| All-project roles | The page forced all types when choosing all projects | Project and type scopes are independent; wildcard grants cover new project/type IDs without enumerating today's list |
| Membership visibility | Open pages did not learn about configuration changes | Successful mutations emit a shared configuration event; administrators, roles, rules, recovery and issue views refresh on relevant events/returning to the view |
| Stale responses | Overlapping refreshes could overwrite newer access, lists or recovery status | Read sequence guards reject old responses; enrollment invalidates earlier status reads |
| Authenticator status | Read failure appeared as missing setup or missing reset permission | Status failure shows an unavailable state with Retry; setup/replacement controls remain hidden |
| Confirmation lockout | The QR/setup form remained visible after the server locked the credential | Lockout or enrollment expiry reloads status and presents the appropriate recovery/setup path |
| Reset grant consumption | Server encryption configuration was validated after consuming the grant | Key validation and encrypted replacement preparation precede consumption |
| Remove transition rule | A stale list could remove a changed policy, or report success for zero changed rows | The page sends its revision; the server compares before removal and during the write, and checks the affected row count |
| Settings wording | Disabled processing was described as preserving usable signature transitions | The page states the existing fail-closed behavior: configured transitions remain blocked until processing is re-enabled |

## Configuration meanings

| Control | Persisted/runtime meaning |
| --- | --- |
| All projects in Approver roles | `project_id IS NULL`; any project can match, subject to role and work type |
| All work item types in Approver roles | `issue_type_id = '*'`; any current or future work type can match, subject to role and project |
| A particular project/type | Exact matching; never widened by an absent match |
| Site-wide settings | Defaults inherited where a project has no explicit override; the scope label now states this |
| Project settings | Only edited preferences become overrides; unchanged inherited settings remain inherited |
| Controlled transitions | Exact project, work type and Jira transition edge, revalidated against the live workflow when saved; this change does not introduce wildcard workflow policies |
| Content processing | Controls baseline capture, change processing and availability of approval decisions; disabling does not bypass controlled workflow validators |
| AI assistance and token limit | Consumed by controlled-field classification and change reports |
| Restoration preferences | Apply to single-item restores; the page explicitly describes tree restore behavior separately |
| Attachment deletion protection | Per-project permission-scheme operation, with the existing shared-scheme warning and applied-state reporting |

Existing revision checks, audit-before-write controls, server-side workflow validation and retained-content requirements remain covered by the administration suites. Unsupported settings are still refused.

## Local checks

- Regression cases were observed failing before their fixes, including binary grant writes/removals, roster user search, status failures, key validation before reset redemption, stale rule removal, membership refresh and stale access/status/list responses.
- `npm run verify` completed successfully on the final implementation: 2,065 backend tests and 312 frontend tests passed, followed by smoke scenarios and the production UI build.
- Additional focused administrator/authenticator verification passed 64 tests before the final full run.
- Frontend lint completed with no errors and three existing unused-variable warnings; `git diff --check` passed.
- Read-only independent review: the reported refresh races were fixed and reproduced successfully after the changes.

Build-size and existing unused-variable warnings are separate from functional pass/fail. Live acceptance remains outstanding.

## Authorized development deployment

- Deployed the local checkout with `forge deploy --environment development --non-interactive` successfully on 26 October 2026.
- App identity: `1d49ae3f-e976-438c-893c-806c8b249351`; deployed version **8.32.0**.
- Deployment read-back: Success at `2026-10-26T09:07:43.463Z` (14:37:43 India time), development/default environment, major version 8.
- Installation read-back: `mgtechdemo.atlassian.net: Jira`, development, major version 8, **Up-to-date**. No installation upgrade was needed or performed.
- The same development environment also has an up-to-date Jira installation on `one-atlas-mjkg.atlassian.net`; deployment updates the shared development build. Existing Confluence installations remain on major version 7 and were not upgraded.
- Forge reported the deployed version is not eligible for Runs on Atlassian. This is separate from the successful deployment; the existing manifest still declares wildcard client external-fetch permission.
- Live credential recovery and workflow acceptance still require the owner's/admin's actions below.

## Live recovery after deployment

1. If app-administrator membership is missing, a Jira administrator or an existing app administrator appoints the account under Administrators. The affected account can choose **Check access again**.
2. For an authenticator lockout, another active VAtlassian administrator opens **Credentials & recovery**, selects the affected person and chooses **Issue reset grant**. Administrator membership alone does not reset an authenticator; self-issued resets remain prohibited.
3. The credential owner opens **Jira personal settings → VAtlassian authenticator**, chooses **Check again**, then starts replacement setup, scans their private QR and confirms with their own authenticator code. The grant expires after 24 hours and works once.
4. Verify saved role membership and rule changes with read-back, then exercise the intended Jira workflows. Those live results must be recorded separately from local test results.
