# VAtlassian vs Codebeamer & Architectural Strategy Summary

## 1. Executive Summary & Market Positioning
- **The Core Debate:** PTC Codebeamer (monolithic, legacy ALM) vs. Jira Cloud augmented with VAtlassian (agile-native, cryptographically verified ALM).
- **Where VAtlassian Wins:**
  - **Developer Experience & Adoption:** Keeps engineers in native Jira workflows rather than forcing them into a siloed, disliked legacy tool.
  - **Zero External Egress ("Runs on Atlassian"):** Operates 100% inside the customer's Atlassian tenant on Forge. Inherits Atlassian's SOC 2, ISO 27001, and data residency with zero external infrastructure overhead.
  - **Mathematical Tamper-Evidence:** Uses SHA-256 hash chains (`va_audit`), per-field cryptographic snapshots (`va_baseline`), and fail-closed workflow gates (`va-gate`), unlike relational database logs that can be manipulated by DBAs.
  - **Active Drift Control & Self-Healing:** Detects unauthorized mutations in real time, displays ADF/rich-text diffs, and provides verified rollback.
- **Where Codebeamer Still Leads:**
  - Deep document-centric requirements management (ReqIF roundtrip with automotive OEMs, live Word/Excel synchronization).
  - Out-of-the-box V-Model Traceability matrix across N-tier hierarchies.
  - Built-in FMEA / Hazard risk analysis tables.

---

## 2. Regulatory Reality: What Can Be "Certified"?
- **FDA (21 CFR Part 11 / Part 820 / IEC 62304):**
  - The FDA **never certifies software tools**. The medical device manufacturer is legally responsible for validating software for its intended use (21 CFR § 820.70(i) / CSA guidance).
  - VAtlassian provides a **Tool Validation Package (IQ/OQ/PQ protocols)** and cryptographic compliance evidence to make customer validation frictionless.
- **Automotive ISO 26262 (Part 8, Clause 11):**
  - Software tools **CAN** be officially certified. Third-party accredited assessors (e.g., TÜV SÜD) issue **Tool Qualification Certificates** up to **ASIL D**.
  - VAtlassian can qualify for this with a formal Tool Safety Manual (TSM) and classification report.
- **Automotive SPICE (ASPICE v3.1/v4.0):**
  - Assesses organizational process capability (Levels 1–5). Tools are audited on whether they support Base Practices in Configuration Management (SUP.8) and Change Management (SUP.10).

---

## 3. The "Runs on Atlassian" vs. External PostgreSQL Debate
- **Management Concern:** *"Can we use Forge Remote to connect to an external PostgreSQL database to store attachments of any size and bypass Forge SQL limits?"*
- **The Reality:**
  - **Technical Capability:** Yes, Forge Remote can connect to external backends.
  - **Marketplace Eligibility:** **NO.** Declaring `remotes` or external egress for customer data **immediately disqualifies** the app from the "Runs on Atlassian" badge.
  - *(Official Source: [Runs on Atlassian Program](https://developer.atlassian.com/platform/marketplace/runs-on-atlassian/))*
- **The Financial Trap of External Hosting:**
  - Hosting external customer data in regulated industries incurs **$150,000–$300,000/year** in fixed overhead (annual SOC 2 Type II audit, ISO 27001 audit, external penetration tests, dedicated SRE/DBA, and multi-region data residency).
- **The Forge Cost Math:**
  - Atlassian provides a massive **monthly free tier** (200,000 GB-seconds compute, 730 GB-hours SQL storage).
  - At 256MB memory and ~350ms execution, that allows **~2.28 million free function executions per month**. Overages are ~22 cents per 100,000 runs.
  - VAtlassian's platform cost on Forge is essentially **~$20–$50/month**, yielding **>95% gross margins**.

---

## 4. The Attachment Immutability & Restoration Architecture
- **Do we store full attachment binaries in Forge SQL?**  
  **No.** Jira Cloud hosts the raw file for free. VAtlassian only stores a **32-byte SHA-256 content hash** (`contentHash`) and metadata.
- **Can users or admins delete attachments in Jira once baselined?**
  - In native Jira, workflow status properties are applied to the `Baselined` status:
    - `jira.permission.attachdeleteall.denied`
    - `jira.permission.attachdeleteown.denied`
    - `jira.issue.editable = false`
  - This removes the delete/trash icon from the Jira UI and returns `403 Forbidden` for API delete calls.
  - If a super-admin alters the workflow to force-delete the file, **VAtlassian’s hash check immediately detects drift** and locks the issue fail-closed.
- **Can deleted attachments be restored?**
  - Current code in `src/lib/diff/fields.js:48` marks attachments as `cannotRestore` because the raw bytes were not stored.
  - **The Approved Solution:** The **Tiered Compliance Vault** (Confluence + Forge Object Store).

---

## 5. The Tiered Compliance Vault (The Complete Closed-Loop Story)

### Tier 1: Customer has Confluence (Standard/Premium)
- When a baseline is created via TOTP e-signature, an asynchronous Forge queue (`va-restore-consumer`) creates a restricted page in a dedicated Confluence space (`ALMVAULT`).
- The page hosts:
  1. A styled, human-readable HTML audit dossier (21 CFR § 11.10(b)).
  2. The machine-readable JSON hash chain.
  3. A copy of all signed attachment binaries.
- Confluence space permissions revoke `Delete Attachment` and `Delete Page`.
- **Zero External Egress:** Transfers from Jira $\to$ Forge $\to$ Confluence stay inside `customer.atlassian.net`, preserving the **"Runs on Atlassian"** badge.

### Tier 2: Customer is Jira-Only (No Confluence)
- Confluence Free cannot be used as a vault because Atlassian disables space permissions on the Free plan.
- For Jira-only customers, attachment binaries are preserved in **Forge Object Store (Preview)** directly within Forge.
- 100% independent of Confluence, 100% "Runs on Atlassian".

### Closed-Loop Decision Flow:
1. **Issue Baselined:** Files vaulted, Jira workflow denial active.
2. **Drift Detected:** If an attachment or field is tampered with, `va-gate` locks the ticket (`UNDECIDED_DRIFT`).
3. **Outcome A (Approve):** Reviewer signs off on the change via TOTP $\to$ Baseline v2 is generated.
4. **Outcome B (Reject & Restore):** The app pulls the original binary from the Vault (Confluence or Forge Object Store), re-uploads it to Jira via `POST /rest/api/3/issue/{key}/attachments`, re-verifies the SHA-256 hash, and restores the ticket to `CLEAN`.
