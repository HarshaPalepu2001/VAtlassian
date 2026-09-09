# Drift approval and restoration verification — 9 September 2026

These changes are in `/Users/sriharsha/VAtlassian` and were deployed to the Forge development environment after local verification. No interactive Jira/Chrome acceptance session was completed. The working tree already contained substantial changes; those were preserved.

## Defects reproduced and repaired

- Both signature submission paths rejected outstanding drift before executing the signed baseline capture. Capturing approval edges now reach the existing audited application step, publish the next baseline, and resolve its preceding drift before making the transition capability available. Non-capturing transitions still cannot bypass drift, and the validator remains closed until it sees a valid pending approval with matching content.
- Standalone drift ratification wrote an unconfigured same-status policy edge into its new baseline. It now preserves the baseline's configured policy edge, so the next approval/rejection retains its authority lookup. The signature itself continues to record the actual unchanged workflow status.
- Restoration could discard a field solely because its capture-time editability was false, before considering current app restore metadata. The planner now rechecks that advisory restriction without overriding missing values, irreversible fields, current edit permissions, or adapter refusals.
- The existing concurrent-decision test failed at the start of this work. The decision guard again refuses busy records, including locked records.
- The signing screen could display a different workflow declaration from the server challenge. It now renders the challenge's exact meaning and effective assurance. Approval eligibility follows the selected workflow edge; rejection eligibility follows the baseline policy.
- Preauthorization could stand in for explicit affirmation. Affirmation is now required before spending a code on every submission route.
- Abandoned `DECIDING`/`RESTORING` operation locks could leave the panel permanently unable to approve or reject. Operation locks now have a 60-second lease, challenge and submit use the same stale-lock semantics, collector/reconcile can recover stale locks, and durable `LOCKED` records remain blocked.
- Refresh disappeared on load failure and rendering crashes. It now lives in an outer shell above a resettable error boundary and remounts the panel body when clicked.
- The panel, issue context, and restoration results now subscribe to Jira and app decision events, focus/visibility changes, and a visible-view 15-second polling fallback. Old responses cannot replace newer data. Restoration results refresh even when the content hash is unchanged.

## Connected functional coverage

`test/drift-functional.test.js` runs production preparation, diff, challenge, TOTP verification, approval application, baseline capture, restoration planning/execution/verification, and validator code. Jira requests and persistence are controlled test boundaries. The source wiring connects the issue panel and My approvals to the same component and signature resolvers; the native signing field uses the resolver aliases with preauthorization.

| Scenario | Local result |
|---|---|
| Panel/My approvals request mode: drift + verified signature → v2 → validator consumption | Pass |
| Native Jira preauthorization mode: drift + verified signature → v2 → later validator consumption | Pass |
| Reuse of a consumed signature | Refused |
| Standalone approval followed by rejection of later drift | Restores v2 and retains policy authority |
| Retry a pending transition | No extra signature or baseline |
| Reject 105 changed fields | Every tested field restored and read back |
| Rich text with formatting, empty labels, null assignee, cascading select, 100 numeric fields | Exact expected restored values |
| Jira silently drops one write | Partial restoration, ERROR state, unresolved drift, validator denied |
| Concurrent edit after lock acquisition | No new baseline, approval remains unusable |
| Baseline storage failure | No pending transition capability |
| Delayed duplicate capture after a newer edit | Does not republish old values or clear new drift |
| Reject after v2 approval | Restores v2 values; v1 history stays intact |

Additional regression tests cover changed evidence, policy/baseline changes after challenge, challenge consumption races, missing approved raw values, current edit restrictions, partial restoration, and signature affirmation. `frontend/test/panel.test.mjs` mounts the real React components in a DOM test environment, replacing Forge transport and Atlaskit presentation controls. It exercises load failure recovery, a real React child-render exception, manual refresh, event updates, subscription cleanup, stale-response ordering, challenge meaning, eligibility, and restoration/status updates.

## Verification results

- `npm run verify`: 570 backend tests and 10 frontend tests passed; 130/130 backend modules imported; TypeScript and production UI build passed.
- `forge lint`: no issues found.
- `forge deploy --environment development`: deployed VAtlassian ALM version 2.24.0; Forge reported it eligible for Runs on Atlassian.
- `forge install list`: development install on `dev-site.atlassian.net` for Jira is up to date.
- `git diff --check`: passed.
- The UI build retains its existing large-bundle warning.
- The standard verification command now includes the frontend tests. Happy DOM was added only as a development dependency.

## Evidence limits

The native Jira transition screen itself was not opened. Local tests and deployment do not establish tenant validator publication, Forge invocation timing, actual Jira field-write permissions, or host event delivery. The manifest and published workflow still need to point at this app in the target Jira project. No existing tenant data was rewritten during acceptance.

The live browser attempt was blocked because the Chrome DevTools connector could not attach to its existing profile. The Atlassian connector available in this session did not resolve `VJIRA-1` on `dev-site.atlassian.net`, so it could not substitute for the Jira UI run.

Restoration is over retained, tracked baseline values. Missing historical values, irreversible Jira data (such as a deleted attachment), or fields Jira refuses to write cannot be truthfully reported as an exact restoration; the app retains the incomplete outcome. The 105-field test does not establish support for every possible third-party Jira field type or administrator changes to the tracked-field schema between baselines.

Jira owns the native panel title and exposes no title-action slot in the [issue panel module](https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-issue-panel/). Refresh is immediately below that heading, outside the panel body's crash boundary. It cannot recover a failed Jira host page or a JavaScript bundle that never loads. [Forge events](https://developer.atlassian.com/platform/forge/apis-reference/ui-api-bridge/events/) connect open app views; polling covers missed events and other browser tabs.
