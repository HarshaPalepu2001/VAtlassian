import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTotpUsecases} from '../src/usecases/totp.js';
const now = 2000000;
function fake(overrides={}) {
 const events=[];
 const deps={now:()=>now,read:async()=>null,grant:async()=>null,key:()=>Buffer.alloc(32,7),
  write:async()=>true,redeem:async()=>true,audit:async e=>events.push(e),...overrides};
 return {api:createTotpUsecases(deps),events};
}
test('enrollment requires authenticated context',async()=>{
 const {api}=fake(); assert.equal((await api.enrol({context:{}})).success,false);
});
test('first enrollment returns URI only after credential and evidence are durable',async()=>{
 const {api,events}=fake(); const r=await api.enrol({context:{accountId:'alice'}});
 assert.equal(r.success,true); assert.match(r.uri,/issuer=VAtlassian/);assert.equal(events[0].eventType,'TOTP_ENROLLED');
 assert.equal(JSON.stringify(events).includes('secret='),false);
});
test('active credential cannot be replaced by session alone',async()=>{
 let writes=0;const {api}=fake({read:async()=>({state:'ACTIVE',version:0}),write:async()=>{writes++;return true;}});
 assert.equal((await api.enrol({context:{accountId:'alice'}})).success,false);assert.equal(writes,0);
});
test('lost credential CAS never displays a new secret',async()=>{
 const {api}=fake({read:async()=>({state:'PENDING_CONFIRM',version:0}),write:async()=>false});
 const r=await api.enrol({context:{accountId:'alice'}});assert.equal(r.success,false);assert.equal(r.uri,undefined);
});
test('reset grant must be atomically redeemed before replacement',async()=>{
 let writes=0;const {api}=fake({read:async()=>({state:'ACTIVE',version:0}),grant:async()=>({grant_id:'x',expires_at:now+1}),redeem:async()=>false,write:async()=>{writes++;return true;}});
 assert.equal((await api.enrol({context:{accountId:'alice'}})).success,false);assert.equal(writes,0);
});
test('status says whether an administrator has authorized a replacement',async()=>{
 const {api}=fake({read:async()=>({state:'ACTIVE',version:0}),grant:async()=>({grant_id:'x',expires_at:now+60000,redeemed_at:null}),
  administrators:async()=>[{accountId:'bob',displayName:'Bob'}]});
 const r=await api.checkStatus({context:{accountId:'alice'}});
 assert.equal(r.success,true);assert.equal(r.state,'ACTIVE');assert.deepEqual(r.resetGrant,{expiresAt:now+60000});
 assert.deepEqual(r.administrators,['Bob']);assert.equal(r.onlyAdministrator,false);
});
test('status ignores an expired grant and names who can issue a reset',async()=>{
 const {api}=fake({read:async()=>({state:'LOCKED',version:0}),grant:async()=>({grant_id:'x',expires_at:now-1,redeemed_at:null}),
  administrators:async()=>[{accountId:'alice',displayName:'Alice'},{accountId:'bob',displayName:'Bob'}]});
 const r=await api.checkStatus({context:{accountId:'alice'}});
 assert.equal(r.resetGrant,null);assert.deepEqual(r.administrators,['Bob']);assert.equal(r.onlyAdministrator,false);
});
test('status flags the sole administrator, who nobody can reset yet',async()=>{
 const {api}=fake({read:async()=>({state:'ACTIVE',version:0}),administrators:async()=>[{accountId:'alice',displayName:'Alice'}]});
 const r=await api.checkStatus({context:{accountId:'alice'}});
 assert.deepEqual(r.administrators,[]);assert.equal(r.onlyAdministrator,true);
});
test('status still answers when the administrator roster cannot be read',async()=>{
 const {api}=fake({read:async()=>({state:'ACTIVE',version:0}),administrators:async()=>{throw new Error('down');}});
 const r=await api.checkStatus({context:{accountId:'alice'}});
 assert.equal(r.success,true);assert.equal(r.isEnrolled,true);assert.equal(r.administrators,null);assert.equal(r.onlyAdministrator,false);
});

test('recovery status failure is surfaced rather than pretending no reset grant exists',async()=>{
 const {api}=fake({read:async()=>({state:'LOCKED',version:0}),grant:async()=>{throw new Error('storage unavailable');}});
 assert.equal((await api.checkStatus({context:{accountId:'alice'}})).success,false);
});
test('encryption configuration failure never burns the reset grant',async()=>{
 let redeemed=0;
 const {api}=fake({read:async()=>({state:'LOCKED',version:0}),grant:async()=>({grant_id:'x',expires_at:now+60000}),
  key:()=>{throw new Error('key unavailable');},redeem:async()=>{redeemed++;return true;}});
 assert.equal((await api.enrol({context:{accountId:'alice'}})).success,false);
 assert.equal(redeemed,0);
});
