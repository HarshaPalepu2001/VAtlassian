import { canonical, sha256Hex } from '../lib/hash.js';
import { ROLE } from '../lib/roles.js';
import { ASSURANCE_LEVEL } from '../lib/approval/levels.js';

/**
 * Enforce the configured sign-off order for test versions and runs.
 *
 * The client configures an ordered list of roles and signature meanings under
 * owner decision 4. No administrator override, skipped step or fallback signer
 * is allowed. If nobody holds the next role, sign-off cannot advance.
 *
 * Each run pins the chain's digest when it starts. Later chain changes affect
 * new runs only. Test-management signatures use ESIGNATURE, an authenticator
 * code, pending a biometric decision under owner decision 7.
 */

export const TM_ASSURANCE = ASSURANCE_LEVEL.ESIGNATURE;
export const MAX_CHAIN_STEPS = 6;

export const DEFAULT_RUN_CHAIN = Object.freeze({
  steps: [
    { label: 'Executed by', role: ROLE.TESTER, meaning: 'I executed this test run and the recorded results are true and complete.' },
    { label: 'Reviewed by', role: ROLE.QA, meaning: 'I reviewed this test run and its evidence and accept the recorded result.' }
  ],
  distinctSigners: true
});

export const DEFAULT_VERSION_CHAIN = Object.freeze({
  steps: [
    { label: 'Approved by', role: ROLE.APPROVER, meaning: 'I approve this test version for official execution.' }
  ],
  distinctSigners: true
});

/**
 * A chain as stored, or the reason it is refused. Nothing is coerced: a
 * missing role or an empty meaning is an error, never a default.
 *
 * A role is a name granted in Approver roles, matched exactly, as on a
 * controlled transition (transitionsValidation.js#transitionInput). Whether
 * anyone holds it is checked when the project's configuration is enabled.
 */
export function validateChain(input) {
  const steps = Array.isArray(input?.steps) ? input.steps : null;
  if (!steps || steps.length === 0) return { error: 'CHAIN_EMPTY' };
  if (steps.length > MAX_CHAIN_STEPS) return { error: 'CHAIN_TOO_LONG' };
  const clean = [];
  for (const step of steps) {
    const label = String(step?.label ?? '').trim();
    const meaning = String(step?.meaning ?? '').trim();
    const role = step?.role;
    if (typeof role !== 'string' || !role || role.trim() !== role || role.length > 32) return { error: 'CHAIN_ROLE_INVALID' };
    if (!label || label.length > 64) return { error: 'CHAIN_LABEL_INVALID' };
    if (!meaning || meaning.length > 255) return { error: 'CHAIN_MEANING_INVALID' };
    clean.push({ label, role: String(step.role), meaning });
  }
  return { chain: { steps: clean, distinctSigners: input?.distinctSigners !== false } };
}

export function chainDigest(chain) {
  return sha256Hex(canonical({ steps: chain.steps, distinctSigners: !!chain.distinctSigners }));
}

/**
 * Can this chain be completed at all, with the people who hold its roles now?
 *
 * `holders` maps role → array of account ids holding it. Each step needs one
 * holder; with distinct signers, the steps together need that many different
 * people (a matching over role holders, small enough to search outright).
 * `mustInclude`, when given, is a person who has to be able to sign step 0
 * (the person starting the run).
 */
export function chainPreflight(chain, holders, { mustInclude = null } = {}) {
  const steps = chain?.steps ?? [];
  for (let i = 0; i < steps.length; i++) {
    if ((holders[steps[i].role] ?? []).length === 0) return { ok: false, reason: 'NO_ELIGIBLE_SIGNER', step: i, role: steps[i].role };
  }
  if (mustInclude && !(holders[steps[0]?.role] ?? []).includes(mustInclude)) {
    return { ok: false, reason: 'STARTER_NOT_ELIGIBLE', step: 0, role: steps[0]?.role };
  }
  if (!chain.distinctSigners) return { ok: true };
  const owner = new Map(mustInclude ? [[mustInclude, 0]] : []);
  const assign = (index, seen) => {
    for (const person of holders[steps[index].role] ?? []) {
      if (seen.has(person)) continue;
      seen.add(person);
      const previous = owner.get(person);
      if (previous === undefined || (!(mustInclude && previous === 0) && assign(previous, seen))) {
        owner.set(person, index);
        return true;
      }
    }
    return false;
  };
  for (let i = mustInclude ? 1 : 0; i < steps.length; i++) {
    if (!assign(i, new Set())) return { ok: false, reason: 'NOT_ENOUGH_DISTINCT_SIGNERS' };
  }
  return { ok: true };
}

/**
 * Where a subject stands in its chain, from the signatures recorded so far.
 *
 * Returns the next step index to sign, or `complete`/`rejected`. Signatures are
 * read in step order; a gap is impossible by construction (each insert names
 * the next index and the primary key refuses a second row for it), and is
 * reported as corrupt rather than skipped over.
 */
export function chainPosition(chain, signatures) {
  const ordered = [...(signatures ?? [])].sort((a, b) => Number(a.step_index) - Number(b.step_index));
  if (!chain?.steps?.length || ordered.length > chain.steps.length) return { corrupt: true };
  for (let i = 0; i < ordered.length; i++) {
    if (Number(ordered[i].step_index) !== i) return { corrupt: true };
    if (!['SIGN', 'REJECT'].includes(ordered[i].decision)) return { corrupt: true };
    if (ordered[i].decision === 'REJECT') return i === ordered.length - 1 ? { rejected: true, at: i } : { corrupt: true };
  }
  if (ordered.length >= chain.steps.length) return { complete: true };
  return { next: ordered.length, step: chain.steps[ordered.length] };
}

/** May this person sign the next step, judged on the chain alone? */
export function separationProblem(chain, signatures, accountId) {
  if (!chain.distinctSigners) return null;
  return (signatures ?? []).some(s => s.account_id === accountId) ? 'SAME_SIGNER' : null;
}
