# Acceptance checklist: Forge Object Store vault verification

**Date:** 2026-10-12  
**Context:** VAtlassian removed all Confluence integrations. Attachment bytes are vaulted exclusively in the Forge Object Store (`vault/sha256/<hash>`).

---

## 1. Deployment and migration order

- [ ] **Deploy code changes to Forge**
  - Run `forge deploy` (use `--non-interactive` if prompted).
  - Note: Confluence modules and scopes have been removed from `manifest.yml`. When prompted for scope/permission adjustments, approve the removal.
- [ ] **Run Migrations**
  - Trigger `admin:runMigrations` via the VAtlassian admin screen.
  - Verifies migration `v108_remove_confluence` drops old Confluence tables (`va_governed_subject`, `va_governance_*`, `va_events`, `va_vault_site`, `va_vault_page`), removes Confluence columns (`space_id`, `space_key`, `project_page_id`) from `va_vault_space`, and removes `vault:tier` config.

---

## 2. Vaulting and restore verification

- [ ] **Baseline Capture with Attachment**
  - Select or create an issue in a controlled project with `capture_baseline = true`.
  - Add an attachment to the issue.
  - Perform the controlled transition to capture the baseline.
  - Confirm the vault worker uploads the attachment bytes directly to Forge Object Store under `vault/sha256/<hash>`.
  - Confirm in the Diagnostics HUD or DB that `storage = 'OBJECT_STORE'`, `object_key = 'vault/sha256/<hash>'`, and no Confluence space or page is provisioned or referenced.

- [ ] **Drift & Reject / Restore**
  - Delete or tamper with the attachment on the Jira issue.
  - Observe drift detection flagging the attachment change.
  - Click **Reject** and initiate a **Restore**.
  - Verify the attachment is successfully downloaded from Forge Object Store and restored to the Jira issue with its original content hash.

- [ ] **Refusal of Legacy Confluence Copies**
  - If any pre-existing attachment row has `storage = 'CONFLUENCE'`, attempt a restore.
  - Confirm that restore refuses the copy with the reason: `"stored in Confluence, which is no longer supported"`.
