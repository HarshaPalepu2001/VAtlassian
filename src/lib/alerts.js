/**
 * Security-alert rendering and deduplication.
 *
 * 21 CFR 11.300(d) calls for detecting and reporting attempts at unauthorized
 * use. A lockout in va_audit records detection; delivery also needs to notify
 * someone. db/alertStore.js persists the outbox and jobs/alerts.js delivers it.
 *
 * Alerts become Jira work items using the existing write:jira-work scope.
 * The customer's Jira notification scheme handles email, push and escalation.
 * The work item records its assignee, status, discussion and resolution.
 * An external webhook would require declared egress and could affect Runs on
 * Atlassian eligibility. external.configurable.enabled cannot change after
 * production deployment.
 *
 * Alert projects have ordinary Jira permissions. Include only account IDs,
 * timestamps and counts, never codes, secrets or fragments of either. Apply
 * the same redaction rule as gate.js's rawCodeSubmitted().
 *
 * These functions do no I/O and can be tested without Jira or a database.
 */

export const ALERT_KIND = {
  /**
 * MAX_FAILED_ATTEMPTS incorrect codes against one credential, reported under
 * 11.300(d)'s "attempts at unauthorized use".
 */
  CREDENTIAL_LOCKED: 'CREDENTIAL_LOCKED',
  /**
 * Audit-chain verification failed under 11.10(e).
 */
  CHAIN_BROKEN: 'CHAIN_BROKEN',
  /**
 * A controlled transition lacks its validator and can complete without a
 * signature. This finding concerns the control described by 11.10(f).
 */
  GATE_UNENFORCED: 'GATE_UNENFORCED',
  /**
 * A transition lacks the validator that holds work items with unreviewed
 * changes, so those items can currently change status through it.
 */
  DRIFT_HOLD_ABSENT: 'DRIFT_HOLD_ABSENT'
};

export const ALERT_SEVERITY = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH'
};

/** Which Part 11 clause each alert is evidence for. Carried into the work item
 *  because the person triaging it at 2am is not the person who read the
 *  regulation, and "why am I being paged" should not need a second document. */
const CLAUSE = {
  [ALERT_KIND.CREDENTIAL_LOCKED]: '21 CFR 11.300(d)',
  [ALERT_KIND.CHAIN_BROKEN]: '21 CFR 11.10(e)',
  [ALERT_KIND.GATE_UNENFORCED]: '21 CFR 11.10(f)',
  [ALERT_KIND.DRIFT_HOLD_ABSENT]: '21 CFR 11.10(f)'
};

const SEVERITY_OF = {
  [ALERT_KIND.CREDENTIAL_LOCKED]: ALERT_SEVERITY.HIGH,
  [ALERT_KIND.CHAIN_BROKEN]: ALERT_SEVERITY.CRITICAL,
  [ALERT_KIND.GATE_UNENFORCED]: ALERT_SEVERITY.CRITICAL,
  [ALERT_KIND.DRIFT_HOLD_ABSENT]: ALERT_SEVERITY.CRITICAL
};

/**
 * Reject code-like text from alert bodies. Six or more consecutive digits
 * could expose a TOTP code or fragment. Check rendered text as well as requiring
 * callers to supply structured, redacted values.
 */
const CODE_LIKE = /\b\d{6,}\b/g;

export function redact(text) {
  return String(text ?? '').replace(CODE_LIKE, '[redacted]');
}

/**
 * Build the alert for a credential lockout.
 *
 * Each lockout is its own event and gets its own dedupe key: three wrong codes
 * on Tuesday and three more on Wednesday are two things a security unit needs
 * to see, not one thing seen twice.
 */
export function credentialLockedAlert({ accountId, failedAttempts, occurredAt }) {
  return build({
    kind: ALERT_KIND.CREDENTIAL_LOCKED,
    dedupeKey: `${ALERT_KIND.CREDENTIAL_LOCKED}:${accountId}:${occurredAt}`,
    occurredAt,
    title: `Electronic signature credential locked after ${failedAttempts} failed attempts`,
    lines: [
      `An electronic signature credential was locked after ${failedAttempts} consecutive incorrect authenticator codes.`,
      `Account: ${accountId}`,
      `Locked at: ${new Date(occurredAt).toISOString()}`,
      'The credential cannot be used to sign until an administrator issues a reset grant. The account owner redeems the grant themselves; no administrator sees or sets the secret.',
      'If the account owner did not make these attempts, treat this as an attempted unauthorized use of an electronic signature and follow your security incident procedure.'
    ]
  });
}

/**
 * Build the alert for a broken audit chain.
 *
 * Deduped on the position of the break rather than on the run, so a break that
 * stays unrepaired raises one work item and keeps it, instead of a new one every
 * day until somebody fixes it.
 */
export function chainBrokenAlert({ brokenAt, reason, checked, occurredAt }) {
  return build({
    kind: ALERT_KIND.CHAIN_BROKEN,
    dedupeKey: `${ALERT_KIND.CHAIN_BROKEN}:${brokenAt}:${reason}`,
    occurredAt,
    title: `Audit trail verification failed at entry ${brokenAt} (${reason})`,
    lines: [
      'The scheduled verification of the electronic signature audit trail could not confirm its integrity.',
      `First failure: entry ${brokenAt}`,
      `Reason: ${reason}`,
      `Entries verified before the failure: ${checked}`,
      'The audit trail is hash-chained, so this means an entry does not match the hash recorded for it, an entry is missing, or the sequence is not contiguous.',
      'Do not modify the audit trail. Preserve it as it stands and follow your data integrity procedure. The current record is evidence.'
    ]
  });
}

/**
 * Build an alert for a controlled transition running without its gate.
 *
 * The stable finding key from lib/gateDrift.js deduplicates repeated checks
 * into one work item. Its age records how long the lapse has been observed.
 */
export function gateUnenforcedAlert({ findingKey, findingType, detail, projectKey, occurredAt }) {
  const where = projectKey ? ` in ${projectKey}` : '';
  return build({
    kind: ALERT_KIND.GATE_UNENFORCED,
    dedupeKey: `${ALERT_KIND.GATE_UNENFORCED}:${findingKey}`,
    occurredAt,
    title: `Controlled transition is not enforcing electronic signature${where}`,
    lines: [
      'A transition configured to require an electronic signature is not enforcing one. Work items are crossing this transition unsigned.',
      `Finding: ${findingType}`,
      detail,
      'This happens when the signature validator is detached from the transition or disabled in the Jira workflow editor. The app cannot block the transition in this state, because Jira no longer calls it.',
      'Reattach the "VAtlassian Approval" validator to the transition, or retire the controlled transition if the requirement no longer applies.'
    ]
  });
}

/**
 * Build the alert for a transition that does not hold drifted work items.
 *
 * Same dedupe rule as gateUnenforcedAlert: keyed on the stable finding key, so
 * one open lapse is one work item however many hourly passes observe it.
 */
export function driftHoldAbsentAlert({ findingKey, detail, projectKey, occurredAt }) {
  const where = projectKey ? ` in ${projectKey}` : '';
  return build({
    kind: ALERT_KIND.DRIFT_HOLD_ABSENT,
    dedupeKey: `${ALERT_KIND.DRIFT_HOLD_ABSENT}:${findingKey}`,
    occurredAt,
    title: `Drifted work items are not held on a workflow transition${where}`,
    lines: [
      'A baselined work item that has changed since approval is meant to stay in its current status until the change is approved or reverted. This transition does not enforce that, so the status can still be changed.',
      detail,
      'This happens when the "VAtlassian Approval" validator has not been added to the transition in the Jira workflow editor, or has been removed or disabled. The app cannot stop the move in this state, because Jira does not call it on this transition.',
      'Add the "VAtlassian Approval" validator to the transition in the Jira workflow editor. It belongs on every transition; which ones need a signature is set in VAtlassian administration.'
    ]
  });
}

function build({ kind, dedupeKey, title, lines, occurredAt }) {
  const safeTitle = redact(title).slice(0, 240);
  return {
    kind,
    severity: SEVERITY_OF[kind],
    dedupeKey: dedupeKey.slice(0, 191),
    title: safeTitle,
    occurredAt,
    body: toAdf([...lines.filter(Boolean).map(redact), `Raised automatically by Forge Signature. Evidence for ${CLAUSE[kind]}.`])
  };
}

/**
 * Build a minimal ADF document with one paragraph per line. Keep it separate
 * from lib/adf.js, which converts ADF to display text.
 */
export function toAdf(lines) {
  return {
    version: 1,
    type: 'doc',
    content: lines.map((text) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: String(text) }]
    }))
  };
}
