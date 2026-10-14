import { enrol as makeEnrollment, provisioningUri } from '../lib/totp.js';
import { enrolmentDecision, grantUsable } from '../lib/credentialRecovery.js';
import { deviceStatus as statusOf, daysBetween } from '../lib/deviceCheck.js';
import { verifyTotp } from '../lib/approval/totpVerification.js';

export function createTotpUsecases(deps) {
  function actor(context) {
    if (typeof context?.accountId !== 'string' || !context.accountId) throw new Error('Sign in to manage your authenticator.');
    return context.accountId;
  }
  const safe = fn => async (args = {}) => {
    try { return await fn(args, actor(args.context)); }
    catch (e) {
      console.error('TOTP error:', e);
      return { success: false, error: 'Authenticator operation could not complete. Refresh and try again; contact your administrator if it persists.' };
    }
  };
  return {
    checkStatus: safe(async (_, accountId) => {
      const row = await deps.read(accountId);
      const state = row?.state ?? 'NONE';
      // A working credential can only be replaced on an administrator's grant,
      // so the page has to say whether one is waiting and who could issue it —
      // otherwise its only button is one the server will refuse.
      const needsGrant = state === 'ACTIVE' || state === 'LOCKED';
      const [grant, roster] = needsGrant
        ? await Promise.all([deps.grant(accountId).catch(() => null), deps.administrators?.().catch(() => null) ?? null])
        : [null, null];
      const usable = grantUsable(grant, deps.now());
      const others = Array.isArray(roster) ? roster.filter(a => a.accountId !== accountId) : null;
      return {success:true, state, isEnrolled:state === 'ACTIVE',
        resetGrant: usable ? {expiresAt:Number(grant.expires_at)} : null,
        administrators: others ? others.map(a => a.displayName ?? 'A VAtlassian administrator') : null,
        // Nobody may authorize their own reset, so the sole administrator has
        // to appoint a second one before their authenticator can be replaced.
        onlyAdministrator: Array.isArray(roster) && others.length === 0 && roster.length > 0};
    }),
    deviceStatus: safe(async (_, accountId) => {
      const status = statusOf(await deps.read(accountId));
      return {success:true,...status,daysSinceProven:daysBetween(status.lastProvenAt,deps.now())};
    }),
    enrol: safe(async (_, accountId) => {
      const [credential, grant] = await Promise.all([deps.read(accountId),deps.grant(accountId)]);
      const now = deps.now();
      const verdict = enrolmentDecision({credential,grant,now});
      if (!verdict.allow) return {success:false,error:verdict.error};
      if (verdict.consumesGrant) {
        if (!await deps.redeem(grant,now)) return {success:false,error:'That reset grant expired or was already used. Ask for a new reset.'};
        await deps.audit({eventType:'CREDENTIAL_RESET_GRANT_REDEEMED',actorAccountId:accountId,payload:{previousState:credential.state}});
      }
      const enrollment = makeEnrollment({key:deps.key(1),keyVersion:1});
      try {
        if (!await deps.write(accountId,credential,enrollment.stored,now)) return {success:false,error:'Your credential changed during setup. Refresh and try again.'};
        await deps.audit({eventType:'TOTP_ENROLLED',actorAccountId:accountId,payload:{keyVersion:1}});
        return {success:true,uri:provisioningUri(enrollment.secretForQrCodeOnly,{accountLabel:accountId,issuer:'VAtlassian'})};
      } finally { enrollment.secretForQrCodeOnly.fill(0); }
    }),
    confirm: safe(async ({payload = {}}, accountId) => {
      const result = await verifyTotp(accountId,payload.code,{confirm:true,purpose:'ENROLLMENT'},deps);
      return result.ok ? {success:true} : {success:false,error:result.error,reason:result.reason};
    }),
    attest: safe(async ({payload = {}}, accountId) => {
      const result = await verifyTotp(accountId,payload.code,{purpose:'DEVICE_CHECK'},deps);
      if (!result.ok) return {success:false,error:result.error};
      await deps.audit({eventType:'DEVICE_CHECK_PASSED',actorAccountId:accountId,payload:{context:'OWNER_ATTESTATION'}});
      return {success:true};
    })
  };
}
async function api() { return createTotpUsecases(await (await import('./totpEnrollmentRuntime.js')).enrollmentRuntime()); }
export async function checkStatus(args) { return (await api()).checkStatus(args); }
export async function deviceStatus(args) { return (await api()).deviceStatus(args); }
export async function enrol(args) { return (await api()).enrol(args); }
export async function confirm(args) { return (await api()).confirm(args); }
export async function attest(args) { return (await api()).attest(args); }
