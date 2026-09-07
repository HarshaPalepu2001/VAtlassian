/**
 * ALERTS — turning a detected security event into something a person is told.
 *
 * 21 CFR 11.300(d) asks for two things and this app only did the first: safeguards
 * to prevent unauthorized use, AND to "detect and report in an immediate and
 * urgent manner any attempts at their unauthorized use". A lockout written to
 * va_audit is detection. Nobody is reading va_audit at 2am, so on its own it is
 * not reporting, and certainly not urgent reporting.
 *
 * WHY JIRA IS THE CHANNEL, AND NOT A WEBHOOK. The obvious answer is an outbound
 * call to Slack, PagerDuty or an email relay. Forge makes that a bad trade:
 * egress domains must be declared statically in the manifest, so a
 * customer-supplied webhook URL needs either a wildcard or customer-managed
 * egress — and per the permissions reference, declaring external egress at all
 * "may make your app ineligible for Runs on Atlassian", while
 * `external.configurable.enabled` is immutable once deployed to production.
 * Trading that away for a notification we can get for free is a poor bargain
 * for an app whose entire pitch is trustworthiness.
 *
 * Raising a Jira work item instead costs no new scope (write:jira-work is
 * already granted), and hands the actual notifying to the customer's own
 * notification scheme — the email, mobile push and escalation paths they have
 * already validated and already read. It also gives the alert somewhere to
 * live: an assignee, a status, a comment thread, a resolution. A Slack message
 * is a notification; a work item is a record that someone responded.
 *
 * REDACTION. Nothing here may carry a code, a secret, or any part of one. An
 * alert is delivered into an ordinary Jira project with ordinary permissions,
 * so it must be readable by whoever runs security without disclosing anything
 * that would help them impersonate the signer. Account IDs, timestamps and
 * counts only. This is the same rule as gate.js's rawCodeSubmitted(): a
 * credential that lands in another system's record is a Part 11 problem, and
 * an alert is another system's record.
 *
 * PURE. Rendering and dedupe live here so they can be tested without Jira or a
 * database; db/alertStore.js persists, jobs/alerts.js delivers.
 */

export const ALERT_KIND = {
  /** MAX_FAILED_ATTEMPTS wrong codes against one credential — 11.300(d)'s
   *  "attempts at unauthorized use", which is the clause's own language. */
  CREDENTIAL_LOCKED: 'CREDENTIAL_LOCKED',
  /** The audit chain failed verification — 11.10(e). */
  CHAIN_BROKEN: 'CHAIN_BROKEN',
  /** A controlled transition is running without our validator — 11.10(f).
   *  Items are crossing unsigned right now. */
  GATE_UNENFORCED: 'GATE_UNENFORCED'
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
  [ALERT_KIND.GATE_UNENFORCED]: '21 CFR 11.10(f)'
};

const SEVERITY_OF = {
  [ALERT_KIND.CREDENTIAL_LOCKED]: ALERT_SEVERITY.HIGH,
  [ALERT_KIND.CHAIN_BROKEN]: ALERT_SEVERITY.CRITICAL,
  [ALERT_KIND.GATE_UNENFORCED]: ALERT_SEVERITY.CRITICAL
};

/** Anything matching this must never reach an alert body. Six or more digits in
 *  a row is a TOTP code or a fragment of one; there is no legitimate reason for
 *  one to appear in a notification. Applied as a last line of defence over the
 *  rendered text, not as the only one — callers still pass structured values. */
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
      'Do not modify the audit trail. Preserve it as it stands and follow your data integrity procedure — the state of the record is itself evidence.'
    ]
  });
}

/**
 * Build the alert for a controlled transition running without its gate.
 *
 * Deduped on the finding key from lib/gateDrift.js, which is stable across runs
 * — so an unenforced edge raises exactly one work item however many hourly
 * passes observe it, and that work item's age is how long the lapse has run.
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
      'Reattach the "Electronic signature required" validator to the transition, or retire the controlled transition if the requirement no longer applies.'
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

/** Minimal ADF document — one paragraph per line. Deliberately not built from
 *  lib/adf.js, which converts ADF to text for display and must not grow a
 *  second, opposite responsibility. */
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
