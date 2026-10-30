# VAtlassian and Codebeamer strategy and architecture summary

## 1. Market position

This strategy compares PTC Codebeamer, a monolithic ALM product, with Jira Cloud and VAtlassian, which adds cryptographically verified ALM controls.

VAtlassian's advantages are:

- Engineers use native Jira workflows rather than a separate ALM tool.
- The app runs entirely within the customer's Atlassian tenant on Forge. It inherits Atlassian's SOC 2, ISO 27001, and data residency without external infrastructure.
- SHA-256 hash chains (`va_audit`), per-field cryptographic snapshots (`va_baseline`), and fail-closed workflow gates (`va-gate`) provide tamper evidence. Relational database logs can be manipulated by DBAs.
- The app detects unauthorized changes in real time, displays ADF/rich-text diffs, and verifies rollback.

Codebeamer has capabilities VAtlassian still lacks:

- Document-centric requirements management, including ReqIF round trips with automotive OEMs and live Word/Excel synchronization.
- A built-in V-model traceability matrix across N-tier hierarchies.
- Built-in FMEA and hazard risk analysis tables.

## 2. Regulatory certification and validation

The FDA never certifies software tools. The medical device manufacturer must validate software for its intended use under 21 CFR § 820.70(i) and CSA guidance. This applies to the discussion of 21 CFR Part 11, Part 820, and IEC 62304. VAtlassian provides a Tool Validation Package with IQ/OQ/PQ protocols and cryptographic compliance evidence to support customer validation.

Under automotive ISO 26262, Part 8, Clause 11, accredited third-party assessors such as TÜV SÜD can issue Tool Qualification Certificates up to ASIL D. VAtlassian can qualify with a formal Tool Safety Manual (TSM) and classification report.

Automotive SPICE, ASPICE v3.1/v4.0, assesses organizational process capability at Levels 1–5. Auditors check whether tools support Base Practices in Configuration Management (SUP.8) and Change Management (SUP.10).

## 3. Forge hosting and external PostgreSQL

Management proposed external PostgreSQL to store attachments of any size and bypass Forge SQL limits. Forge Remote can connect to external backends. Declaring `remotes` or external egress for customer data immediately disqualifies the app from the "Runs on Atlassian" badge. See the [Runs on Atlassian program](https://developer.atlassian.com/platform/marketplace/runs-on-atlassian/).

External hosting of regulated customer data incurs $150,000–$300,000/year in fixed overhead for annual SOC 2 Type II and ISO 27001 audits, external penetration tests, dedicated SRE/DBA staff, and multi-region data residency.

The Forge cost estimate uses a monthly free tier of 200,000 GB-seconds of compute and 730 GB-hours of SQL storage. At 256 MB memory and about 350 ms per execution, that permits about 2.28 million free function executions per month. Overages cost about 22 cents per 100,000 runs. The estimated VAtlassian platform cost is $20–$50/month, with gross margins above 95%.

## 4. Attachment immutability and restoration

Jira Cloud hosts the raw attachment file for free. VAtlassian stores a 32-byte SHA-256 content hash (`contentHash`) and metadata in Forge SQL, rather than the full binary.

Native Jira applies these workflow status properties to the `Baselined` status:

- `jira.permission.attachdeleteall.denied`
- `jira.permission.attachdeleteown.denied`
- `jira.issue.editable = false`

These properties remove the delete/trash icon from the Jira UI and return `403 Forbidden` for API delete calls. If a super-admin changes the workflow to force-delete the file, VAtlassian's hash check immediately detects drift and locks the issue fail-closed.

The code in `src/lib/diff/fields.js:48` marks attachments as `cannotRestore` because the app did not store the raw bytes. The approved solution is the Tiered Compliance Vault, using Confluence and Forge Object Store.

## 5. Tiered Compliance Vault

### Tier 1: Customer has Confluence Standard or Premium

When a TOTP e-signature creates a baseline, an asynchronous Forge queue (`va-restore-consumer`) creates a restricted page in a dedicated Confluence space (`ALMVAULT`). The page holds:

1. A styled, human-readable HTML audit dossier under 21 CFR § 11.10(b).
2. The machine-readable JSON hash chain.
3. A copy of all signed attachment binaries.

Confluence space permissions revoke `Delete Attachment` and `Delete Page`. Transfers between Jira, Forge, and Confluence stay inside `customer.atlassian.net`, preserving the "Runs on Atlassian" badge.

### Tier 2: Customer has Jira only

Confluence Free cannot act as a vault because Atlassian disables space permissions on the Free plan. For Jira-only customers, Forge Object Store (Preview) preserves attachment binaries directly within Forge. This requires no Confluence installation and retains "Runs on Atlassian" eligibility.

### Decision flow

1. Baseline the issue, copy its files to the vault, and activate Jira workflow denial.
2. If an attachment or field changes without authorization, `va-gate` locks the ticket with `UNDECIDED_DRIFT`.
3. To approve the change, a reviewer signs with TOTP and the app creates baseline v2.
4. To reject and restore, the app retrieves the original binary from Confluence or Forge Object Store, re-uploads it to Jira through `POST /rest/api/3/issue/{key}/attachments`, verifies its SHA-256 hash, and restores the ticket to `CLEAN`.
