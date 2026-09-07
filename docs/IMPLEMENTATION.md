# VAtlassian implementation ledger

Goal: implement the supplied MERGE-PLAN.md in this workspace, using both source working trees as read-only references.

Architecture: one Forge app, one va_* SQL schema and ledger, one approval capability with provider assurance; baseline capture, drift and restoration consume that capability. TypeScript custom UI plus native approval field.

Decisions: user requested this workspace, so /Users/sriharsha/VAtlassian replaces the document's proposed destination. Source Baseline contains uncommitted work: read current working files, preserve originals. Registration, deployment and Jira acceptance are explicitly separate from local verification because user plans to run the app after implementation.

## Shared merge contract
- SQL: bl_config/audit/event_receipt -> va_config/audit/event_receipt; bl_gated_transition -> va_controlled_transition (gt_id -> ct_id); bl_reviewer -> va_eligibility (rv_id -> el_id; preserve Signature el_id); bl_review -> va_item_state; bl_report -> va_ai_report; bl_decision and va_signature -> va_approval; other bl_* -> va_*.
- Linkage uses approval_id / approvalId everywhere. No separate signature or decision tables. Approval record retains decision APPROVE/REJECT and actor_account_id/actor_name/decided_at as well as account_id/printed_name/signed_at where needed by Signature consumers.
- db/reviewStore.js becomes db/itemStateStore.js; db/decisionStore.js becomes db/approvalStore.js. Existing baseline store function names may remain for compatibility; new approval API uses recordApproval, approvalById, casConsume, pendingApprovalFor, voidOthers.
- One INSERT owner src/db/approvalStore.js; only approval:submit creates records. approval:retryTransition only retries a Jira transition.
- Assurance levels: NATIVE_TRANSITION, JSM_APPROVAL, ESIGNATURE, BIOMETRIC. Providers native, jsm, esignature, biometric; last two reserved integrations refuse NOT_CONFIGURED where appropriate (ESIGNATURE works via TOTP). Export functions getLevel(), verify(), describe() from each provider, registry only imports providers.
- Resolver use cases take {payload, context}; exported endpoint name matches key suffix. panel:getState -> usecases/panel.js getState; panel:getGlanceState -> same. Approval submit payload {issueId?, issueKey?, transitionId?, toStatusId?, decision:'APPROVE'|'REJECT', code?, note?, expectedEvidenceHash?}. Identity ALWAYS context.accountId, verified Jira access.
- Panel response {eligibility, approval, record, drift}, may add issue, transitions, credentialEnrolled, error. Frontend/backend owners coordinate extra details.
- No WebAuthn implementation/dependencies, no egress permissions, no source app id. User will register a fresh app.

## Work packages
- [ ] Shared foundation, consolidated migrations, merged manifest, dependencies, documentation (coordinator)
- [ ] Approval providers, TOTP identity, single submit, gate, UI Kit, assurance tests (approval agent)
- [ ] Baseline/capture/drift/diff/restore/report stores and use cases, triggers (baseline agent)
- [ ] Admin use cases/resolver and identity/evidence configuration (admin agent)
- [ ] TypeScript UI and all module surfaces (frontend agent)
- [ ] Scheduled jobs, unified retention, ledger event union, export and ported pure tests (jobs agent)
- [ ] Integration, architecture tests, smoke import, build/lint, source integrity check
- [ ] Live Jira acceptance (requires fresh registration and development installation; not implied by passing local tests)
