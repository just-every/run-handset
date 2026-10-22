import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { post } from './handset-auth.mjs'
import { sourceFixture } from './handset-sources.mjs'

export async function protectionFixture(runtime,{populated=false}={}){
 const source=await sourceFixture(runtime),{headers,numberId}=source
 const continuation='https://synthetic-handset-600.example.test/inbound',emergency='https://synthetic-handset-600.example.test/emergency'
 async function write(action,value,status=201){const response=await post(runtime,'/api/handset/protection/'+action,value,headers);assert.equal(response.status,status,await response.clone().text());return response.json()}
 const route={sourceId:source.source.id,continuationUrl:continuation,emergencyUrl:emergency,maxAttempts:3,windowSeconds:60,attemptCents:100,confirm:'approve existing inbound continuation'}
 await write('configure',route,200)
 const rule=(value={})=>write('rules',{scope:'owner',numberId,channel:'all',matchKind:'prefix',pattern:'+1512555',effect:'block',confirm:'apply nuisance policy',...value})
 const check=(value={})=>write('check',{numberId,deviceId:'synthetic-handset-601',eventKey:'synthetic-handset-602',channel:'voice',direction:'inbound',address:'+15125550127',...value},200)
 async function carrier(fields={},options={}){
  const data={AccountSid:source.account,CallSid:'synthetic-handset-603',Direction:'inbound',CallStatus:'ringing',From:'+15125550127',To:'+15125550125',...fields},parameters=new URLSearchParams(data)
  const target=new URL(options.path??'/providers/twilio/protection',runtime.origin)
  assert.equal(target.origin,runtime.origin,'signed carrier fixtures remain on the isolated Worker')
  let signed=target.href
  for(const key of Object.keys(data).sort())signed+=key+data[key]
  const proof=createHmac('sha1','synthetic-handset-500').update(signed).digest('base64')
  return runtime.request(target.pathname+target.search,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...(options.signature===false?{}:{'x-twilio-signature':proof})},body:parameters.toString()+(options.suffix??'')})
 }
 const overview=async()=>{const response=await runtime.request('/api/handset/protection',{headers});assert.equal(response.status,200);return response.json()}
 async function startScreening(fields={}){
  const initial=await readProtectionChallenge(await carrier(fields))
  return {...initial,async answer(round=initial,digits=round.digit,overrides={},options={}){
   return carrier({...fields,CallStatus:'in-progress',...(digits===null?{}:{Digits:digits}),...overrides},{...options,path:round.action})
  }}
 }
 const f={...source,route,continuation,emergency,write,rule,check,carrier,overview,startScreening}
 if(populated){
  await rule()
  await rule({matchKind:'number',pattern:'+15125550126',effect:'allow'})
  await rule({matchKind:'anonymous',pattern:'',channel:'voice'})
  await carrier({CallSid:'synthetic-handset-604',From:'sip:synthetic-handset-605@synthetic-handset-606.example.test',To:'sip:+442079460123@synthetic-handset-606.example.test',SipUsername:'synthetic-handset-605'})
  await write('callbacks',{numberId,caller:'+15125550128',expiresAt:Date.now()+3600000,confirm:'designate emergency callback'})
 }
 return f
}

/** Parse what the actual emitted TwiML tells the caller, without reading private
 * runtime state. f.startScreening().answer(round, null) submits no digit; pass
 * an override CallSid/From/To or signature:false to exercise scope/auth fences. */
export async function readProtectionChallenge(response){
 assert.equal(response.status,200,await response.clone().text())
 const twiml=await response.text(),action=twiml.match(/<Gather\b[^>]*\baction="([^"]+)"/),prompt=twiml.match(/press ([1-9])\./)
 assert.ok(action&&prompt,'the signed ingress emits an actionable keypad challenge')
 assert.doesNotMatch(twiml,/<Dial\b|<Record\b|input="speech/)
 return {action:action[1].replaceAll('&amp;','&'),digit:prompt[1],twiml}
}
