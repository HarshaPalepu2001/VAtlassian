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
