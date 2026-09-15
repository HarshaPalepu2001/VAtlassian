/**
 * THE SIGNING SCREEN INSIDE JIRA'S TRANSITION DIALOG.
 *
 * This renders what a signer must be able to see at the moment they sign:
 * what the work item says (summary + description), who is accountable for it
 * (assignee, reporter), what the signature MEANS, where it moves the item to,
 * and one box for the authenticator code. 21 CFR 11.50(a) requires the
 * meaning of a signature to be shown with it — a bare code box shows a signer
 * nothing about what they are attesting to.
 *
 * -----------------------------------------------------------------------
 * HOW TO TELL, IN ONE GLANCE, WHETHER THIS FILE IS RUNNING. It renders a bold
 * "Review and sign this transition" heading and a footer line reading
 * "Forge Signature · rendered on: … · item: …". (Deliberately NOT "Electronic
 * signature required" — the field itself is already named "Electronic
 * Signature (TOTP)" in the transition screen above this component, so a
 * heading repeating those same two words said nothing new and just looked
 * like the label had printed twice.) If the transition dialog shows a bare
 * 6-digit box with neither of those, Jira is using its BUILT-IN string editor
 * and none of this code executed — the fault is then field registration
 * (most often: the field is not on the transition SCREEN, or the wrong
 * "Electronic Signature" field is), never the signing logic below. That
 * distinction is the single most expensive thing to get wrong here; it has
 * cost several deploys.
 *
 * When Jira falls back that way it also STORES what was typed as the field's
 * value, putting the authenticator code into the work item's change history.
 * src/gate.js's rawCodeSubmitted() exists to catch exactly that and refuse the
 * transition rather than let it pass unnoticed.
 * -----------------------------------------------------------------------
 *
 * WHAT THIS FILE GOT WRONG BEFORE 2026-08-20, since all three failures
 * presented identically as "I typed the right code and it said the
 * transition still needs a signature":
 *
 * 1. manifest.yml had no `edit.experience`, which the jira:customField
 *    reference lists as Required: yes. Without `issue-transition` in it,
 *    Jira renders its OWN default string editor in the transition dialog
 *    and this component is never mounted at all. Fixed in the manifest.
 *
 * 2. `import { TextField } from '@forge/react'` — the exported component is
 *    `Textfield` (lower-case f); `TextField` is only a TypeScript type name
 *    in out/types/. Verified in node_modules/@forge/react/out/index.d.ts,
 *    per docs-VERIFICATION-PROTOCOL.md, rather than assumed from how the
 *    name is spelled elsewhere in the React ecosystem. The old import
 *    resolved to `undefined` and would have thrown on render.
 *
 * 3. The field value was set by RETURNING a string from `onSubmit`.
 *    CustomFieldEdit's `onSubmit` is typed `() => void` and its return value
 *    is discarded; the documented way to set the value is `view.submit(v)`.
 *    And the resolver call passed `{ pin, skipTransition: true }` to
 *    panel:sign, which requires `issueKey`, `ctId` and `code` — so it
 *    short-circuited on the argument check and never verified anything.
 *
 * 4. It failed SILENTLY. Every "nothing to sign" cause — no controlled
 *    transition configured, no eligibility, no authenticator enrolled, the
 *    edge not currently reachable — collapsed into the same disabled box with
 *    no text, which is pixel-for-pixel what Jira's built-in string editor
 *    looks like. The resolver now returns a blocker code and a sentence for
 *    each (panel.js's SIGNING_BLOCKER) and this file always renders it.
 *
 * THE AFFIRMATION GATE. The code box is disabled, and the verification effect
 * refuses to run, until the signer has ticked the statement of meaning. This
 * is the same rule the two Custom UI signing surfaces apply (see the long
 * note in frontend/src/panel/SignaturePanel.tsx); all three create rows in the
 * same va_signature table and an auditor comparing them should not be able to
 * tell that one route asked less of the signer than the others.
 *
 * The tick is cleared whenever the selected meaning changes. An affirmation
 * is a declaration of ONE statement, and letting it survive a change of
 * selection would attribute to the signer words they never read.
 *
 * WHY THE CODE IS VERIFIED ON THE 6TH DIGIT AND NOT ON SUBMIT. Atlassian
 * documents the value as being submitted "when the user clicks outside the
 * field or elsewhere on the dialog" — which, in practice, is the same click
 * that presses the dialog's own submit button. Doing an async round trip to
 * verify the code inside that blur handler races Jira's transition request.
 * Verifying as soon as six digits are present means the signature already
 * exists by the time the user reaches the button, and `onSubmit` only has to
 * hand over a token it is already holding. The race is designed out rather
 * than tuned around.
 *
 * The failure mode is safe either way: if no signature was created, the row
 * simply isn't there, and src/gate.js denies the transition. Nothing here
 * can produce a *false allow* — the worst it can do is make the user retry.
 *
 * Components used here are only ones verified present in
 * node_modules/@forge/react/out/components/ui-kit-components.d.ts. UI Kit is
 * not React-DOM: an unexported name resolves to undefined and throws at
 * render, which on this surface is indistinguishable from the module not
 * being wired up at all. Check the export list before adding one.
 */
import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box, Checkbox, Heading, Inline, Lozenge, SectionMessage, Spinner, Stack, Text, Textfield,
  useProductContext
} from '@forge/react';
import { CustomFieldEdit } from '@forge/react/jira';
import { events, invoke, view } from '@forge/bridge';

const CODE_LENGTH = 6;
const DIGITS_ONLY = /^\d*$/;

/** Legible copy for the reasons this screen fails closed outright. */
const FAIL_CLOSED_MESSAGES = {
  TRANSITION_ID_REQUIRED: 'This screen could not determine which transition is being performed, so nothing can be signed here. Reopen the transition dialog and try again.',
  ISSUE_REQUIRED: 'This screen could not determine which work item is being transitioned.',
  ISSUE_ACCESS_DENIED: 'This work item could not be read, so nothing can be signed here.'
};
const AMBIGUOUS_MESSAGE = 'More than one signing rule matched this exact transition. Ask a Jira administrator to remove the conflicting configuration.';
const MISMATCH_MESSAGE = 'The approval rule returned for this screen does not match the transition being performed, so nothing can be signed here. Reopen the transition dialog and try again.';
// Mirrors frontend/src/lib/assurance.ts. Deliberately no cross-directory
// import — see the bundle caution further down.
const ASSURANCE_LABELS = { ESIGNATURE: 'Electronic signature', BIOMETRIC: 'Biometric approval' };

/**
 * THIS RUNTIME'S BRIDGE LAYER FOR MUTATIONS. The UI Kit bundle cannot import
 * frontend/src/lib/bridge.ts, so it applies the same rule here: emit
 * VA_ISSUE_CHANGED exactly once, and only when the resolver reports a durable
 * success — never on a denied, refused, or failed attempt.
 */
async function invokeMutation(key, payload) {
  const result = await invoke(key, payload);
  const durable = !!result && typeof result === 'object'
    && result.success !== false && result.ok !== false && !result.error && !result.transitionError;
  if (durable) events.emit('VA_ISSUE_CHANGED', { issueKey: payload?.issueKey }).catch(() => {});
  return result;
}

/** One labelled line of work-item context. */
const Detail = ({ label, value }) => (
  <Inline space="space.075" alignBlock="start">
    <Text weight="medium" color="color.text.subtle">{label}</Text>
    <Text>{value}</Text>
  </Inline>
);

const Edit = () => {
  const context = useProductContext();
  // jira:customField extensions get a JiraContext under platformContext —
  // `issueKey` / `issueId` (node_modules/@forge/react/out/types/forge.d.ts,
  // interface JiraContext). It is present here because this component only
  // declares the `issue-transition` experience, where an issue already
  // exists; on `issue-create` it would legitimately be undefined.
  const issueKey = context?.extension?.issue?.key;
  const issueId = context?.extension?.issue?.id;

  // Which surface Jira actually mounted this on. Documented for custom fields
  // on the jira:customField reference ("Issue creation and issue transition
  // dialog"): `const { extensionContext: { renderContext } } =
  // useProductContext()`. Rendered below, because the single most useful fact
  // when a signature never gets created is whether THIS component ran at all.
  const renderContext = context?.extension?.renderContext;

  // Jira's issue-transition field context carries the exact transition the
  // signer is acting on (Jira's `issueTransition.id`). This is the
  // disambiguator: an administrator places whichever field matches the rule's
  // required assurance on that transition screen, so the field already knows
  // which transition it is for. Field-level re-selection would allow signing
  // the wrong sibling transition — exactly the failure this resolver exists
  // to prevent. See the header in src/usecases/signing.js.
  const transitionId = context?.extension?.issueTransition?.id;

  const [issue, setIssue] = useState(null);
  const [signerName, setSignerName] = useState(null);
  const [options, setOptions] = useState(null);
  const [blocker, setBlocker] = useState(null);
  const [ctId, setCtId] = useState(null);
  const [affirmed, setAffirmed] = useState(false);
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [evidenceHash, setEvidenceHash] = useState(null);
  const [status, setStatus] = useState({ kind: 'idle' });

  // Which controlled transition is being signed? Exactly the one Jira named
  // in `issueTransition.id`. The server resolves the rule for that id; this
  // screen accepts it only when there is one rule and it is for that id.
  // Anything else fails closed, because WHICH statement of meaning is being
  // attested to is the signature — guessing it would be exactly wrong.
  useEffect(() => {
    // Previously `if (!issueKey) return;` — which left options null, ctId
    // null, status 'idle' and every message below suppressed, so the
    // component rendered a single disabled textbox and NOTHING else. Never
    // fail silently here.
    if (!issueKey) {
      setOptions([]);
      setStatus({
        kind: 'error',
        message: 'This signing field could not determine which work item it is on, so it cannot create a signature. Sign from the Electronic Signature panel on the work item instead.'
      });
      return;
    }
    if (transitionId == null || transitionId === '') {
      setOptions([]);
      setStatus({ kind: 'error', message: FAIL_CLOSED_MESSAGES.TRANSITION_ID_REQUIRED });
      return;
    }
    let cancelled = false;
    invoke('signing:context', { issueKey, issueId, transitionId, surface: 'esignature-field' })
      .then((res) => {
        if (cancelled) return;
        if (!res?.issue) {
          setOptions([]);
          setStatus({ kind: 'error', message: FAIL_CLOSED_MESSAGES[res?.error] ?? res?.error ?? 'Could not load the signature requirement for this transition.' });
          return;
        }
        setIssue(res.issue ?? null);
        setSignerName(res.actorName ?? null);
        const hash = res.drift?.evidenceHash ?? null;
        setEvidenceHash(hash);

        const list = res.actions || (res.transitions || []).filter(t => t.eligible !== false);
        const opts = list.map(t => ({
          ctId: t.transitionId,
          meaning: t.meaning,
          requiredRole: t.requiredRole,
          toStatusName: t.toStatusName || t.toStatusId,
          toStatusId: t.toStatusId,
          eligible: t.eligible !== false,
          requiredAssurance: t.requiredAssurance,
          anyStatus: t.anyStatus === true,
          capturesBaseline: t.capturesBaseline === true,
          blocksOnDrift: t.blocksOnDrift === true
        }));

        let blockerMsg = null;
        if (opts.length > 1) {
          // signing:context exact-matches this screen's transitionId, so this
          // should be structurally impossible. Fail closed rather than ever
          // offering a picker on this surface — see the header note above.
          setBlocker(AMBIGUOUS_MESSAGE);
          setOptions([]);
          setStatus({ kind: 'idle' });
          return;
        }
        if (opts.length === 1 && String(opts[0].ctId) !== String(transitionId)) {
          // Never sign a sibling in place of the exact transition, even one
          // that reaches the same status.
          setBlocker(MISMATCH_MESSAGE);
          setOptions([]);
          setStatus({ kind: 'idle' });
          return;
        }
        if (opts.length === 0) {
          const reqRole = res.requiredRole || (res.transitions || []).find(t => t.requiredRole)?.requiredRole;
          const isNotEligible = res.blocker === 'NOT_ELIGIBLE_FOR_RULE' || (!res.blocker && (res.transitions || []).some(t => t.eligible === false));
          if (res.blocker === 'GATE_NOT_ENFORCED') {
            blockerMsg = "The approval rule exists, but the VAtlassian validator is not attached to this transition in Jira. Ask a Jira administrator to re-attach it.";
          } else if (res.blocker === 'WRONG_FIELD_FOR_RULE') {
            blockerMsg = "This transition needs a biometric device check. Ask an administrator to put the 'Biometric Authentication' field on this transition screen.";
          } else if (isNotEligible) {
            blockerMsg = reqRole
              ? `This transition is signed by ${reqRole}. You do not hold the approver role on this work item.`
              : "You do not hold the approver role this transition requires.";
          } else {
            blockerMsg = "No configured signing transition is available. Ask a Jira administrator to check the published validator and the matching VAtlassian controlled transition.";
          }
        }

        setBlocker(blockerMsg);
        setOptions(opts);
        if (opts.length === 1) setCtId(opts[0].ctId);
        if (opts.length === 1 && !blockerMsg && !hash) {
          setStatus({
            kind: 'error',
            message: 'Evidence hash could not be loaded for this work item. Signing cannot proceed without verified content.'
          });
          return;
        }
        setStatus({ kind: 'idle' });
      })
      .catch((e) => { if (!cancelled) setStatus({ kind: 'error', message: e.message }); });
    return () => { cancelled = true; };
  }, [issueKey, transitionId]);

  // Verify + create the PENDING signature the moment a full code is present.
  // Keyed on [code, ctId] so one code is spent at most once: re-rendering
  // does not re-fire it, and a wrong code is not retried automatically
  // against the 3-attempt lockout in lib/totp.js.
  //
  // `affirmed` is part of the guard, not just of the box's disabled state.
  // The affirmation is what makes this a signature rather than an
  // authentication (21 CFR 11.50(a)(4), and see the long note in
  // frontend/src/panel/SignaturePanel.tsx): a code verified without one
  // records an identity check and calls it an attestation.
  useEffect(() => {
    if (!issueKey || !ctId || !affirmed || code.length !== CODE_LENGTH) return;
    if (!evidenceHash) {
      setStatus({
        kind: 'error',
        message: 'Evidence hash is unavailable. Cannot create a signature without verified content.'
      });
      return;
    }
    let cancelled = false;
    const capturing = options?.find((o) => o.ctId === ctId)?.capturesBaseline === true;
    setToken('');
    setStatus({ kind: 'verifying', message: 'Preparing signature' });
    invoke('approval:challenge', { issueKey, transitionId: ctId, intent: 'WORKFLOW', decision: 'APPROVE', expectedEvidenceHash: evidenceHash })
      .then(challenge => {
        if (!challenge?.success) throw new Error(challenge?.error ?? 'The reviewed content changed. Reopen the transition and review it again.');
        if (!cancelled) setStatus({ kind: 'verifying', message: capturing ? 'Publishing baseline' : 'Recording signature' });
        return invokeMutation('approval:submit', { issueKey, challengeId: challenge.challengeId, code, confirmed: true, preauthorize: true });
      })
      .then((res) => {
        if (cancelled) return;
        if (res?.success) {
          setToken(res.approvalId);
          setStatus({ kind: 'ok', message: `Signed as ${res.printedName} — ${res.meaning}` });
          // Submit as soon as it exists as well as on blur: Atlassian
          // documents using the submit API outside onSubmit for exactly
          // this, and it means the field already carries the token if the
          // blur event is swallowed by the dialog's own submit handling.
          view.submit(res.approvalId);
        } else {
          setToken('');
          setStatus({ kind: 'error', message: res?.error ?? 'That code could not be verified.' });
        }
      })
      .catch((e) => { if (!cancelled) setStatus({ kind: 'error', message: e.message }); });
    return () => { cancelled = true; };
  }, [issueKey, ctId, affirmed, code, evidenceHash, options]);

  // Changing WHICH statement is being signed withdraws the affirmation, and
  // clears any code and token already gathered under the old one. An
  // affirmation is a declaration of one specific meaning; carrying a tick
  // across from "Approved for release" to "Reviewed for accuracy" would
  // attribute to the signer a statement they never read.
  // An error already on screen is kept: this also runs on mount, after the
  // load effect above may have failed closed, and must not erase the reason.
  useEffect(() => {
    setAffirmed(false);
    setCode('');
    setToken('');
    view.submit('');
    setStatus((current) => (current.kind === 'error' ? current : { kind: 'idle' }));
  }, [ctId]);

  // Never submit the raw code as the field value — see the panel:preauthorize
  // header. An empty string is submitted when there is no valid token, which
  // gate.js reads as "nothing was signed on this screen" and denies.
  const onSubmit = useCallback(() => { view.submit(token); }, [token]);

  const onChange = useCallback((e) => {
    const next = (e?.target?.value ?? '').trim();
    if (DIGITS_ONLY.test(next) && next.length <= CODE_LENGTH) setCode(next);
  }, []);

  const selected = options?.find((o) => o.ctId === ctId) ?? null;
  const signable = options !== null && options.length > 0;

  // THE ONE EDGE THIS SURFACE CANNOT SERVE. UI Kit renders declaratively on
  // Atlassian's side: there is no DOM, no `window` and no `navigator` here, so
  // navigator.credentials.get() cannot be called and a biometric edge can
  // never be satisfied from this field. Offering the code box anyway produced
  // the worst possible outcome — the signer types a valid code, and the server
  // refuses it as INSUFFICIENT_ASSURANCE because an ESIGNATURE does not meet a
  // BIOMETRIC policy. Say so instead, and name the field that does serve it.
  //
  // A literal comparison is correct rather than an effectiveAssurance() call:
  // BIOMETRIC is the only level above the floor in lib/approval/levels.js, so
  // every other policy is enforced AS an electronic signature and is signable
  // right here. Deliberately no cross-directory import — a broken bundle on
  // this surface makes Jira fall back to its built-in text editor, which is
  // the failure this file's header exists to prevent.
  const needsDeviceCheck = selected?.requiredAssurance === 'BIOMETRIC';

  return (
    <CustomFieldEdit onSubmit={onSubmit} disableSubmitOnEnter>
      <Stack space="space.150">
        {/* An unmistakable signature that THIS component rendered. If the
            transition dialog shows a bare 6-digit box with no heading, Jira is
            using its built-in string editor, this file never ran, and no
            amount of typing here will ever create a signature — the problem is
            field registration, not signing logic. Worded to not repeat the
            field's own name ("Electronic Signature (TOTP)") printed by Jira
            immediately above this component. */}
        <Heading as="h4">Review and sign this transition</Heading>

        {options === null && (
          <Inline space="space.075" alignBlock="center">
            <Spinner size="small" />
            <Text>Loading this work item…</Text>
          </Inline>
        )}

        {/* WHAT IS BEING SIGNED. Shown before the code box, and shown even
            when nothing is signable — someone who has landed here without
            eligibility should still be able to see the item they were asked
            to look at, and read the reason underneath it. */}
        {issue && (
          <Stack space="space.075">
            <Inline space="space.100" alignBlock="center">
              <Lozenge appearance="default">{issue.key}</Lozenge>
              {issue.statusName && <Lozenge appearance="inprogress">{issue.statusName}</Lozenge>}
              {issue.issueTypeName && <Text color="color.text.subtlest">{issue.issueTypeName}</Text>}
            </Inline>

            <Text weight="bold">{issue.summary || '(no summary)'}</Text>

            <Detail label="Assignee:" value={issue.assignee?.displayName ?? 'Unassigned'} />
            <Detail label="Reporter:" value={issue.reporter?.displayName ?? 'Unknown'} />

            <Box>
              <Text weight="medium" color="color.text.subtle">Description</Text>
              {issue.descriptionEmpty
                ? <Text color="color.text.subtlest">This work item has no description.</Text>
                : <Text>{issue.description}</Text>}
              {issue.descriptionTruncated && (
                // Say so explicitly. A signer who does not know the text was
                // cut may believe they read the whole record before signing
                // it, which is the one misunderstanding this screen must not
                // create.
                <Text size="small" color="color.text.subtlest">
                  Shortened to fit this dialog — open the work item to read it in full before signing.
                </Text>
              )}
            </Box>
          </Stack>
        )}

        {/* Why there is nothing to sign, in words, naming who fixes it. */}
        {blocker && (
          <SectionMessage appearance={signable ? 'warning' : 'information'}>
            <Text>{blocker}</Text>
          </SectionMessage>
        )}

        {/* This exact-transition surface never offers a selector, even when
            Jira has other eligible transitions on this issue — signing:context
            already narrows to the single transition Jira put this field on,
            and anything else fails closed above rather than reaching here. */}

        {/* THE EXACT ACTION, AS READ-ONLY FACTS. */}
        {selected && (
          <Stack space="space.050">
            <Detail label="Transition:" value={`${selected.anyStatus ? 'Any status' : (issue?.statusName || 'the current status')} -> ${selected.toStatusName}`} />
            <Detail label="Role:" value={selected.requiredRole ?? 'Any approver role'} />
            <Detail label="Authentication:" value={ASSURANCE_LABELS[selected.requiredAssurance] ?? ASSURANCE_LABELS.ESIGNATURE} />
            <Detail label="Baseline:" value={selected.capturesBaseline ? 'Captures a new baseline' : 'Does not capture a baseline'} />
            <Detail label="Unapproved changes:" value={selected.blocksOnDrift ? 'Blocked while changes are unapproved' : 'Not blocked by unapproved changes'} />
          </Stack>
        )}

        {/* THE STATEMENT OF MEANING. This is the sentence the signature
            attests to, and it is required to be shown — not implied by the
            transition's name. */}
        {/* Composed as sibling Text nodes, never Text nested inside Text.
            UI Kit is not React-DOM and an unsupported composition throws at
            render on a surface where a throw looks exactly like the module
            never having been wired up. Plain is cheap; ambiguous is not. */}
        {selected && (
          <SectionMessage appearance="information">
            <Text weight="bold">{selected.meaning}</Text>
            <Text>
              {`Signing this moves ${issue?.key ?? 'this work item'} to ${selected.toStatusName}.`}
            </Text>
          </SectionMessage>
        )}

        {/* THE AFFIRMATION. The code box stays disabled until this is ticked,
            here and on both Custom UI signing surfaces, so that the three
            routes to the same ledger entry demand the same act. `label` is a
            plain string on purpose — see the Text-nesting caution above. */}
        {needsDeviceCheck && (
          <SectionMessage appearance="warning">
            <Text weight="bold">This transition is confirmed with a device check.</Text>
            <Text>
              An authenticator code cannot satisfy it. Ask a Jira administrator to put the
              "Biometric Authentication" field on this transition screen, or approve from
              the VAtlassian panel on the work item and then run the transition.
            </Text>
          </SectionMessage>
        )}

        {selected && !needsDeviceCheck && (
          <Checkbox
            isChecked={affirmed}
            onChange={(e) => setAffirmed(e?.target?.checked ?? !affirmed)}
            label={`I, ${signerName ?? 'the signer'}, have reviewed ${issue?.key ?? 'this work item'} and I declare: ${selected.meaning}. I am signing as ${selected.requiredRole} and I understand this electronic signature is the legally binding equivalent of my handwritten signature.`}
          />
        )}

        {signable && !needsDeviceCheck && (
          <Stack space="space.075">
            <Text weight="medium">Authenticator code</Text>
            <Textfield
              name="code"
              placeholder="6-digit code"
              value={code}
              onChange={onChange}
              isDisabled={!ctId || !affirmed || !evidenceHash || status.kind === 'verifying'}
            />
            {status.kind === 'idle' && ctId && affirmed && (
              <Text size="small" color="color.text.subtlest">
                Enter the current code from your authenticator app. It is checked here and never stored on this work item.
              </Text>
            )}
            {status.kind === 'idle' && ctId && !affirmed && (
              <Text size="small" color="color.text.subtlest">
                Read and accept the statement above to enable the code box.
              </Text>
            )}
          </Stack>
        )}

        {status.kind === 'verifying' && (
          <Inline space="space.075" alignBlock="center">
            <Spinner size="small" />
            <Text>{status.message ?? 'Preparing signature'}</Text>
          </Inline>
        )}
        {status.kind === 'ok' && (
          <SectionMessage appearance="success">
            <Text>{status.message}</Text>
            <Text size="small">Select the transition button below to complete it.</Text>
          </SectionMessage>
        )}
        {status.kind === 'error' && (
          <SectionMessage appearance="error">
            <Text>{status.message}</Text>
          </SectionMessage>
        )}

        {/* Where Jira mounted this, per the documented renderContext. Only
            shown when the code has not been accepted yet, so a successful
            signature stays clean. This is the one line that answers "is the
            field even wired to the transition dialog?" without needing logs
            or admin access. */}
        {status.kind !== 'ok' && (
          <Text size="small" color="color.text.subtlest">
            Forge Signature · rendered on: {renderContext ?? 'unknown'} · item: {issueKey ?? 'unresolved'}
          </Text>
        )}
      </Stack>
    </CustomFieldEdit>
  );
};

ForgeReconciler.render(<Edit />);
