# Synthetic fixture and environment manifest

All fixture labels are preparation templates, not invented Jira IDs. Allocate actual IDs on the demo tenant and record them before execution. No real payment/customer data. Never store token secrets, TOTP values or credentials here.

| Fixture | Required data / independent oracle |
| --- | --- |
| F-AUTH | Separate source author, eligible independent approver, recorder, Test-only approver, viewer; source project/type grants; authorized readable Test T1 and unreadable T2; record real account IDs privately in controlled execution metadata. |
| F-GREEN | Disposable source with approved baseline B1 and digest; signed Test T1 v1, two mandatory contexts (for example QA/Linux and QA/Windows where supported); required evidence retained/read back; approved assignment, target and review chains. |
| F-CAND | Candidate A id qa-gv-a and B id qa-gv-b; same and different commit fields; fresh execution per candidate; record actual deployed artifact identity independently from sender-reported CI identity. |
| F-CI | Two prepared runs with real 32-hex IDs, actual revisions, resolved step IDs and iteration IDs; project token and expiring exact-run grant created by authorized human/admin; capture secret once in approved secret store only. Use app-generated payload template. |
| F-LIMIT | Valid generated requests varying one bound at a time; compute UTF-8 bytes, not character count; at-limit/one-over: 262144 bytes, 50 runs, 500 steps total, 4000 actual/comment characters, 16000 log characters. Record schema and endpoint limits separately. |
| F-RECOVERY | Two mapped runs, documented isolated pause/fault after member one, queue redelivery controls and audit outage toggle. If no supported fault mechanism exists, relevant cases are BLOCKED; do not damage shared SQL/audit records. |
| F-DEFECT | Failed signed attempt, configured failure/defect policy, a controlled blocker and a genuine fix retest on a new candidate execution. Preserve initial failure and link retest to defect. |
| F-LATEST | Older signed pass and newer same Test-version/context attempt with server sequence; variants blank-build/open, failed, rejected and cancelled. Historical variants need genuine audit creation facts before cutoff. |
| F-LEGACY | Genuine pre-cutover schema-1 signed PASSED evidence and valid creation audit; saved original canonical bytes/hash; allowed absent historical metadata. Never manufacture a signed legacy row or backfill its metadata. |
| F-PERSIST | Supported isolated storage/audit/read-back failure injection. Save before/after digests. No direct tenant database corruption. |
| F-WORKFLOW | Disposable source; actual published workflow routes to Done and configured va-gate; independent authorized human and supported automation identity; audit-confirmed real transition event. |

Reset: create a new uniquely tagged execution/target for different candidates or blocked receipts; preserve signed/audit history. Delete no signed record. Remove/revoke disposable grants using approved tenant controls at completion; cleanup is a separate authorized operation. Record fixture manifest SHA-256, expected outcomes and reset receipt for each run.
