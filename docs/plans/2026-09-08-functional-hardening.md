# Signature and baseline functional hardening

**Goal:** Make configured transitions, signed snapshots, drift review and verified restoration behave consistently across Jira, the issue panel and My approvals.

**Architecture:** Keep the existing approval writer, validator, baseline store and shared drift collector. A signature binds the reviewed content and selected policy. Publish a baseline only after all retained values are durable; preserve unresolved review state on failures. Jira workflow validation remains the enforcement boundary.

**Scope:** Changes stay in VAtlassian. The original Signature and Baseline repositories are read-only references. Preserve existing working changes. No automatic production deployment or workflow changes.

- [x] Repair activation-before-transition and challenge policy binding, with regression tests for denial, failure, replay and changed meaning.
- [x] Bind capture to the signed content hash; prevent duplicate delivery from republishing an older baseline or clearing drift; test incomplete and stale capture.
- [x] Reduce baseline read/write round trips with bounded byte-aware batches; test 100 fields, chunked values and partial data.
- [x] Preserve complete tracked-field semantics, including cascading choices; keep cosmetic integrity changes reviewable and restorable.
- [x] Record each observation hash against the standing baseline, retain changed snapshots, and propagate transient trigger failures for retry.
- [x] Repair exact restore shapes, parent/link restoration and post-write verification; test missing data, permission failure and partial restoration. Also restored the app-attributed screen-security override so declared fields that are off the edit screen revert.
- [x] Bind diff/report evidence to live values; show deterministic summary if AI fails, and expose drift/control incidents in issue context and panel.
- [x] Run the entire test suite, backend import smoke test, frontend build and Forge lint. Review the combined diff.
- [x] Record a requirement-by-requirement acceptance matrix, including live Jira scenarios and platform limits that local mocks cannot establish.

Validation begins from 493 passing tests. A test reproducing each confirmed defect must fail before its fix and pass afterward. Verification must not claim Part 11 compliance or live Jira acceptance from local tests alone.

Outcome: 545 tests passing, 129/129 modules import, frontend build and `forge lint` clean. Acceptance matrix in `2026-09-08-acceptance-matrix.md`, including the placement limit on the drift flag and the unimplemented reviewer notification.
