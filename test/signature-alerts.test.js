/**
 * Alert rendering and dedupe — 21 CFR 11.300(d)'s reporting half.
 *
 * The rule these tests exist to hold: an alert is delivered into an ordinary
 * Jira project with ordinary permissions, so it must tell a security unit what
 * happened without disclosing anything that would help them impersonate the
 * signer. Everything else here is about not crying wolf, because an alert
 * channel that fires more than it should stops being read, and then the two
 * findings that actually matter arrive somewhere nobody is looking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  credentialLockedAlert, chainBrokenAlert, gateUnenforcedAlert,
  redact, toAdf, ALERT_KIND, ALERT_SEVERITY
} from '../src/lib/alerts.js';

const textOf = (alert) =>
  alert.body.content.map((p) => p.content.map((t) => t.text).join('')).join('\n');

// --- redaction -----------------------------------------------------------

test('a six-digit code can never reach an alert body', () => {
  assert.equal(redact('the code was 123456'), 'the code was [redacted]');
  assert.equal(redact('and 9876543210 too'), 'and [redacted] too');
});

test('short numbers survive, because attempt counts are the point', () => {
  assert.equal(redact('3 failed attempts'), '3 failed attempts');
  assert.equal(redact('entry 4821 of 5000'), 'entry 4821 of 5000');
});

test('a lockout alert carries no code even if one is smuggled through a field', () => {
  const alert = credentialLockedAlert({
    accountId: 'acct-1 typed 654321',
    failedAttempts: 3,
    occurredAt: Date.parse('2026-08-31T06:00:00Z')
  });
  assert.ok(!/654321/.test(textOf(alert)));
  assert.ok(!/654321/.test(alert.title));
});

// --- lockout -------------------------------------------------------------

test('a lockout names the account, the count and the time', () => {
  const at = Date.parse('2026-08-31T06:00:00Z');
  const alert = credentialLockedAlert({ accountId: 'acct-42', failedAttempts: 3, occurredAt: at });
  const text = textOf(alert);

  assert.equal(alert.kind, ALERT_KIND.CREDENTIAL_LOCKED);
  assert.equal(alert.severity, ALERT_SEVERITY.HIGH);
  assert.match(text, /acct-42/);
  assert.match(text, /3 consecutive incorrect/);
  assert.match(text, /2026-08-31T06:00:00/);
});

test('a lockout tells the reader what to do if the owner did not do it', () => {
  const alert = credentialLockedAlert({ accountId: 'a', failedAttempts: 3, occurredAt: 1 });
  assert.match(textOf(alert), /attempted unauthorized use/i);
});

test('every alert names the clause it is evidence for', () => {
  const at = 1;
  assert.match(textOf(credentialLockedAlert({ accountId: 'a', failedAttempts: 3, occurredAt: at })), /11\.300\(d\)/);
  assert.match(textOf(chainBrokenAlert({ brokenAt: 5, reason: 'ENTRY_ALTERED', checked: 4, occurredAt: at })), /11\.10\(e\)/);
  assert.match(textOf(gateUnenforcedAlert({ findingKey: 'k', findingType: 'GATE_ABSENT', detail: 'd', occurredAt: at })), /11\.10\(f\)/);
});

// --- dedupe: the anti-spam contract --------------------------------------

test('two separate lockouts are two alerts', () => {
  const a = credentialLockedAlert({ accountId: 'acct-1', failedAttempts: 3, occurredAt: 1000 });
  const b = credentialLockedAlert({ accountId: 'acct-1', failedAttempts: 3, occurredAt: 2000 });
  assert.notEqual(a.dedupeKey, b.dedupeKey, 'Tuesday and Wednesday are two incidents');
});

test('the same unrepaired chain break collapses onto one alert', () => {
  const monday = chainBrokenAlert({ brokenAt: 812, reason: 'ENTRY_ALTERED', checked: 811, occurredAt: 1000 });
  const tuesday = chainBrokenAlert({ brokenAt: 812, reason: 'ENTRY_ALTERED', checked: 811, occurredAt: 90000000 });
  assert.equal(monday.dedupeKey, tuesday.dedupeKey, 'a standing break must not page daily');
});

test('a break that moves is a new alert', () => {
  const first = chainBrokenAlert({ brokenAt: 812, reason: 'ENTRY_ALTERED', checked: 811, occurredAt: 1 });
  const later = chainBrokenAlert({ brokenAt: 900, reason: 'SEQUENCE_GAP', checked: 899, occurredAt: 2 });
  assert.notEqual(first.dedupeKey, later.dedupeKey);
});

test('an unenforced gate observed hourly raises exactly one alert', () => {
  const key = 'GATE_ABSENT:10001:10007:wf-1:2:10004>10006';
  const runs = [1, 2, 3, 4].map((i) =>
    gateUnenforcedAlert({ findingKey: key, findingType: 'GATE_ABSENT', detail: 'd', occurredAt: i * 3600000 })
  );
  assert.equal(new Set(runs.map((a) => a.dedupeKey)).size, 1);
});

// --- gate drift ----------------------------------------------------------

test('an unenforced gate is CRITICAL and says items are crossing unsigned', () => {
  const alert = gateUnenforcedAlert({
    findingKey: 'k', findingType: 'GATE_ABSENT',
    detail: 'Transition "Done" carries no signature gate.',
    projectKey: 'AP', occurredAt: 1
  });

  assert.equal(alert.severity, ALERT_SEVERITY.CRITICAL);
  assert.match(alert.title, /AP/);
  assert.match(textOf(alert), /crossing this transition unsigned/);
  assert.match(textOf(alert), /Reattach/);
});

test('a missing project key still produces a usable title', () => {
  const alert = gateUnenforcedAlert({ findingKey: 'k', findingType: 'GATE_ABSENT', detail: 'd', occurredAt: 1 });
  assert.ok(!/undefined|null/.test(alert.title));
});

// --- shape ---------------------------------------------------------------

test('bodies are valid single-level ADF documents', () => {
  const alert = credentialLockedAlert({ accountId: 'a', failedAttempts: 3, occurredAt: 1 });
  assert.equal(alert.body.type, 'doc');
  assert.equal(alert.body.version, 1);
  assert.ok(alert.body.content.every((n) => n.type === 'paragraph'));
  assert.ok(alert.body.content.every((n) => n.content.every((t) => t.type === 'text' && typeof t.text === 'string')));
});

test('titles and dedupe keys stay inside their column widths', () => {
  const alert = gateUnenforcedAlert({
    findingKey: 'k'.repeat(400),
    findingType: 'GATE_ABSENT',
    detail: 'd'.repeat(2000),
    projectKey: 'P'.repeat(300),
    occurredAt: 1
  });
  assert.ok(alert.title.length <= 240, 'title fits VARCHAR(255) with the severity prefix');
  assert.ok(alert.dedupeKey.length <= 191, 'dedupe key fits its unique index');
});

test('toAdf renders empty input as an empty document rather than throwing', () => {
  assert.deepEqual(toAdf([]), { version: 1, type: 'doc', content: [] });
});
