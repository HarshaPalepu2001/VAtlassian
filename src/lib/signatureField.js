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
 * Set the Electronic Signature field to the latest durable signature ID.
 *
 * The field is either empty or identifies the most recent signature on the
 * work item. The panel's sign-and-transition, content approvals and the gate's
 * consumption of transition-screen signatures all use this function.
 *
 * Call only after the signature row and ledger entry are durable. The field
 * is a receipt; writing it first could display a signature that failed to save.
 *
 * Never throw or fail an already recorded signature when this field write
 * fails. Return {ok:false, error} for a warning and repair the field on the next
 * signature. Reporting signing failure after a receipt-write error could
 * prompt an unnecessary second signature.
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
