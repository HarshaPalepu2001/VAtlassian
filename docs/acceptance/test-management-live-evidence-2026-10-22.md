# Test management live evidence — 2026-10-22

Scope: journeys 1–10 from `test-management-live-checklist-2026-10-22.md`, VAT on mgtechdemo. User requested immediate browser execution without a setup preflight.

## Initial browser attempt

Opened `https://mgtechdemo.atlassian.net/jira/software/c/projects/VAT/boards/1811` in the requested in-app Browser. Atlassian redirected to account selection and displayed: `harshapalepu01@gmail.com doesn't have access to Jira on mgtechdemo.atlassian.net.`

The initial attempt created no test work items or signatures. The user then authorized the existing Chrome session.

## Chrome execution

- Current Jira account displayed: `harsha.palepu@mgtechsoft.com` (Palepu Sai Sri Harsha).
- Created TestCase [VAT-83](https://mgtechdemo.atlassian.net/browse/VAT-83), summary `TM live J01-J10 2026-10-22 — publication and Passed run`.
- Creation left Parent empty; issue readback displayed `Epic - Add parent` and `Parent: Add parent`.
- Selected **View app actions → Test management**. The `Test management DEV` panel loaded.
- Attempted to publish draft steps on [VAT-83](https://mgtechdemo.atlassian.net/browse/VAT-83) without a parent; the app refused publication with error: *"This work item has no parent. Test-management work items always sit under a parent (normally the Epic); set one, then try again."* (Journey 1 Pass).

| Journey | Result | Evidence / remaining action |
|---|---|---|
| 1 — Publish Test without parent | **Pass** | [VAT-83](https://mgtechdemo.atlassian.net/browse/VAT-83) created with empty parent. Publication refused with `"no parent"` banner as enforced by `src/usecases/testAuthoring.js#L113-L115`. |
| 2 — Publish v1 under Epic | In Progress | Assign parent Epic (e.g. `VAT-36`) to `VAT-83`, write test steps, save draft, and click Publish. Expected: Version 1, "Waiting for sign-off", digest displayed. |
| 3 — Approver signs v1 | Not run | Requires published v1 and authenticator interaction. |
| 4 — Publish unchanged draft | Not run | Requires published version. |
| 5 — Publish edited v2 | Not run | Requires signed v1 for digest comparison. |
| 6 — Add run using latest signed version | Not run | Requires signed v1 and execution under Epic. |
| 7 — Non-Tester attempts run creation | Not run | Requires a session for a person without Tester. |
| 8 — Record Passed and Tester signs | Not run | Requires created run and authenticator interaction. |
| 9 — Same person attempts QA signature | Not run | Requires Tester signature. |
| 10 — Different QA signs | Not run | Requires second person's session and authenticator interaction. |

No journey acceptance is claimed. Deployment identity and setup were not checked, as requested.

## 2026-10-23 initial check before deployment

- Reopened the existing Chrome session on `mgtechdemo.atlassian.net` as `harsha.palepu@mgtechsoft.com`; project VAT is the VAtlassian project.
- Read back [VAT-83](https://mgtechdemo.atlassian.net/browse/VAT-83): it is a TestCase under Epic `VAT-36` and remains In Review. The parent needed for journey 2 is now present.
- Opened the issue's **Test management DEV** panel. Its content did not render: the panel area remained blank/loading, with no draft, publish controls, or version state available. Journey 2 is therefore still **Not run**; no new Jira write or signature was made in this continuation.
- The Atlassian connector available in this session is connected to `harshapalepu01.atlassian.net`, not the target `mgtechdemo` site, so it was not used for tenant evidence.
- The checklist says the manual-scope candidate is local and uncommitted, and development 8.24.0 is the previous build. Deployment identity, installation/migration status, and permissions remain unverified for this candidate.

| Journey | Current result | Evidence / next action |
|---|---|---|
| 1 — Publish Test without parent | **Pass** (2026-10-22) | Existing VAT-83 evidence above. |
| 2 — Publish v1 under Epic | **Not run** | VAT-83 now has parent VAT-36, but the Test management DEV panel did not render. Verify/deploy/install the intended candidate and reopen the panel before publishing. |
| 3–10 | **Not run** | Depend on journey 2 and the required distinct Tester, Approver, and QA identities; signatures need each person's own authenticator interaction. |

## 2026-10-23 continuation — development deployment and journeys 2–4

- Local `npm run verify` passed: 2,030 backend tests, frontend tests, smoke imports (255/255), and production UI build. The build emitted the existing large-chunk warning.
- Deployed working tree version **8.29.0** to Forge `development`. Forge lint reported one issue; deployment completed. Forge reported the build is not Runs on Atlassian eligible.
- Reloaded VAT-83 in the authorized Chrome session. The Test management DEV panel rendered. It showed parent VAT-36 and no signed version.
- Saved and published one-step draft as **Version 1** on VAT-83. The UI shows “Waiting for sign-off,” one step, and digest prefix `5f162eb512fd8300`. The frozen definition includes the parent, objective, preconditions, step, and no source references.
- Journey 2 — Publish v1 under Epic: **Pass**. The app rendered Version 1 as waiting for sign-off.
- Journey 3 — Approver signs v1: **Pending user authentication**. The configured Approver control is present and requests the user's six-digit authenticator code. Agent did not enter or submit a code.
- Journey 4 — Publish unchanged draft: **Pass**. App refused with “Nothing changed since the latest version, so there is nothing new to publish.” No second version was created.
- Journeys 5–10 remain **Not run** because journey 5's acceptance requires v1 to be signed first, and the subsequent run journeys depend on that signed version. VAT-83 is open at the Approver signing control for user handoff.

## 2026-10-23 signature readback

- User reported signing VAT-83. The Test Management panel's Refresh action had just returned `Runnable version: None signed yet`, Version 1 `Waiting for sign-off`, Approver signature unchecked, and Sign disabled. A full Jira page reload was then performed; the Test management DEV section remained in a loading state, so no later signature state could be verified.
- Journey 3 remains **Not confirmed** pending a fresh panel readback. Journeys 5–10 remain **Not run** until the app confirms a signed Version 1. Agent did not enter or submit an authenticator code or signature.

## 2026-10-23 continuation — journeys 5–6 setup

- Fresh live readback on VAT-83 confirmed `Runnable version: v1 (signed)`, Version 1 status **Signed**, digest prefix `5f162eb512fd8300`, and the signer/time record for Palepu Sai Sri Harsha (Oct 23, 2026, 03:16 PM).
- Journey 5 — Edit a step and publish v2: **Pass**. Edited and saved the draft step, then published Version 2 with digest prefix `bd3bd40199fff6f6`. The panel showed Version 2 **Waiting for sign-off** while Version 1 remained **Signed** and runnable. This also confirms the signed Version 1 stayed immutable.
- Created TestExecution [VAT-84](https://mgtechdemo.atlassian.net/browse/VAT-84), `TM live J06-J10 execution — VAT-83`, under Epic VAT-36 for the run journeys.
- Journey 6 — Add a run of the test: **Blocked before execution**. Opened the Test management DEV panel on VAT-84 via View app actions, but the panel remained in a loading/skeleton state after a Jira reload. No run creation was submitted. Reopening the panel or successful initialization is needed to continue.
- Journeys 7–10 remain **Not run**. They depend on an initialized execution panel and, for the signer separation cases, a non-Tester identity plus a distinct QA identity. The available live Jira session is the single account `harsha.palepu@mgtechsoft.com`; no alternate user session was available in this browser.

## 2026-10-24 continuation — journeys 6–10 on VAT-84 (in-app browser)

- Deployed build: latest development deployment 2026-10-23T16:20Z, after HEAD `83834e8`; working tree clean.
- The VAT-84 Test management DEV panel rendered (it stayed loading on 2026-10-23). Sign-off chain shown: Tester (Tester) → QA (QA).
- Journey 6 — Add a run of the test: **Pass**. The existing run on VAT-84 (started Oct 23, 2026, 09:54 PM, HIL bench 3 · ECU rev B) uses **VAT-83 v1**, the latest signed version (v2 is unsigned), and shows **In progress** with computed result Passed. No duplicate run was added.
- Append-only step history observed live: step 1 was recorded Failed, then changed to Passed with a reason; the runner lists the Failed entry under "Earlier entries (kept for the record)" (changed Oct 23, 2026, 09:55 PM).
- Journey 18 — Wrong authenticator code: **Pass (observed)**. `tm:run:sign` refused `CODE_INVALID_OR_REPLAYED` at 15:16:24Z and 15:16:27Z; the third failure at 15:17:37Z locked the credential (`MAX_FAILED_ATTEMPTS = 3`). Nothing was signed; the run stayed open.
- Journey 8 — Sign as Tester: **Blocked**. The user's attempt at 16:39:06Z was refused `CREDENTIAL_LOCKED`. Recovery needs a reset grant issued by a *different* VAtlassian administrator (Admin → Credentials); the user cannot authorize their own. No second VAtlassian administrator exists yet.
- **Defect (UI):** the refusal was shown, but `ExecutionView` renders its error notice at the top of the panel (`frontend/src/testmgmt/ExecutionView.tsx:75`), about a screen and a half above the Sign button, so the user saw "nothing happening". Errors from signing should appear at the sign box. **Fixed in development 8.31.0 (2026-10-25):** run, version and plan-revision sign refusals now show inside their sign box; step, closure and finish refusals show at their control. Covered by UI tests; the live refusal display is not yet seen.
- Unexplained: `tm:run:recordStep` refused `STALE` at 16:39:12Z (no change made). Not yet investigated.
- Journeys 7, 9, 10: **Not run**. 9 depends on 8; 7 and 10 need a second Jira account (non-Tester; distinct QA).
