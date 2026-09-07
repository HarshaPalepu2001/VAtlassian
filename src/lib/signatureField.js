import { asApp, route } from '@forge/api';

const FIELD_MODULE_KEY = 'va-approval-field';
let cachedSignatureFieldId = null;

export async function getSignatureFieldId() {
  if (cachedSignatureFieldId) return cachedSignatureFieldId;
  const fieldsResponse = await asApp().requestJira(route`/rest/api/3/field`);
  if (!fieldsResponse.ok) return null;
  const allFields = await fieldsResponse.json();
  const field = allFields.find((f) => 
    typeof f?.schema?.custom === 'string' && f.schema.custom.endsWith(`/static/${FIELD_MODULE_KEY}`)
  );
  if (field) {
    cachedSignatureFieldId = field.id;
    return field.id;
  }
  return null;
}

export async function updateSignatureToken(issueId, tokenHex) {
  try {
    const fieldId = await getSignatureFieldId();
    if (!fieldId) return { success: false, error: 'Could not find custom field ID' };
    
    // overrideScreenSecurity=true is required because the Electronic Signature
    // field is deliberately excluded from the 'View/Edit Issue' screens!
    console.log(`Updating signature token on ${issueId} for field ${fieldId}...`);
    
    const response = await asApp().requestJira(route`/rest/api/3/issue/${issueId}?overrideScreenSecurity=true&overrideEditableFlag=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          [fieldId]: tokenHex
        }
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Jira rejected PUT to custom field: ${response.status}`, errorText);
      return { success: false, error: `Jira rejected field update: ${errorText}` };
    }
    
    console.log(`Successfully updated signature token on ${issueId}.`);
    return { success: true };
  } catch (e) {
    console.error('Error updating signature token:', e);
    return { success: false, error: e.message };
  }
}

/**
 * THE ONE PLACE A GOLDEN TICKET IS STAMPED ONTO A WORK ITEM.
 *
 * The invariant this exists to hold: the Electronic Signature field is either
 * EMPTY, or it carries the id of the most recent signature on that work item.
 * Never a stale one, never a half-written one. Every path that verifies a TOTP
 * and creates a signature ends here — the issue panel's sign-and-transition,
 * the content approval, and the gate after it consumes a transition-screen
 * signature — so there is exactly one definition of "latest".
 *
 * TWO RULES ABOUT WHEN IT IS CALLED, and both are load-bearing:
 *
 * 1. AFTER the signature is durable, never before. The signature row and the
 *    ledger entry are the record; the field is a receipt rendered on the issue.
 *    Stamping first would put a receipt on screen for a signature that might
 *    then fail to be stored, which is the one direction of inconsistency an
 *    auditor cannot forgive.
 *
 * 2. IT NEVER THROWS, and a failure never fails the signature. By the time
 *    this runs the signature is already recorded, already audited, and already
 *    valid. Reporting "signing failed" because a cosmetic field write got a
 *    403 would tell the signer a lie about the state of the record and invite
 *    them to sign a second time. The caller gets {ok:false, error} to surface
 *    as a warning, and the field is repaired on the next signature.
 *
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function stampSignatureField(issueId, approvalId) {
  try {
    const tokenHex = typeof approvalId === 'string' ? approvalId : approvalId?.toString('hex');
    if (approvalId !== null && !tokenHex) return { ok: false, error: 'no signature id to stamp' };
    const result = await updateSignatureToken(issueId, tokenHex);
    return result?.success ? { ok: true } : { ok: false, error: result?.error ?? 'unknown error' };
  } catch (e) {
    // Belt and braces: updateSignatureToken already catches, but this function
    // promises callers it cannot throw, and that promise is what lets them put
    // it after the durable write without a try/catch of their own.
    console.error('stampSignatureField: could not stamp the signature field (continuing)', e);
    return { ok: false, error: e.message };
  }
}
