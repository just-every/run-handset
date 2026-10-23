import assert from 'node:assert/strict'
import { delegationFixture } from './handset-delegation.mjs'
import { queueProviderFixture } from './handset-queues.mjs'
import { post } from './handset-auth.mjs'

export async function inboundFixture(runtime){
 const f=await delegationFixture(runtime),base='/api/handset/front-desk',voicemail='https://synthetic-handset-762.example.test/voicemail',principal='https://synthetic-handset-762.example.test/principal'
 const assistantId='synthetic-handset-2',endpoint='sip:synthetic-handset-760@synthetic-handset-761.example.test'
 await f.create('queues/agents',{operatorId:assistantId,languages:['en','es'],skills:[],capacity:1,confirm:'approve native agent capabilities'})
 await f.create('queues/agents/'+assistantId+'/route',{sourceId:f.source.id,kind:'sip',destination:endpoint,confirm:'approve exact queue agent route'})
 await f.create('protection/configure',{sourceId:f.source.id,continuationUrl:principal,emergencyUrl:'',maxAttempts:3,windowSeconds:60,attemptCents:100,confirm:'approve existing inbound continuation'})
 const edge=queueProviderFixture(runtime,f,{callbackPath:'/providers/twilio/protection'})
 let serial=770,line=f.line,grant=f.grant,route
 const carrier=(fields={},options={})=>edge.callback({CallSid:'synthetic-handset-'+serial++,From:'+15125550126',To:'+15125550125',CallStatus:'ringing',Direction:'inbound',...fields},options)
 const routeInput=()=>({lineId:line.id,lineRevision:line.revision,...(route?{revision:route.revision}:{}),delegationId:grant.id,voicemailUrl:voicemail,maxSeconds:300,expiresAt:Date.now()+3600000,confirm:'approve exact inbound coverage voicemail and forwarding'})
 async function approve(){route=await f.create('front-desk/routing',routeInput());return route}
 async function policy(changes){
  line=await f.create('front-desk/lines',{...f.lineInput,...changes,id:line.id,revision:line.revision})
  grant=await f.create('front-desk/delegations',f.grantInput)
  return approve()
 }
 async function expectRoute(branch,fields={}){
  const response=await carrier(fields);assert.equal(response.status,200,await response.clone().text())
  const xml=await response.text()
  const row=(await runtime.sql('SELECT * FROM hnd_frontdesk_inbound ORDER BY rowid DESC LIMIT 1')).results[0]
  assert.equal(row.branch,branch);assert.equal(row.line_id,line.id);assert.equal(row.line_revision,line.revision)
  return xml
 }
 return {...f,base,voicemail,principal,endpoint,carrier,approve,policy,expectRoute,routeInput,get currentLine(){return line},get currentGrant(){return grant},get inboundRoute(){return route},post:(path,value,headers=f.headers)=>post(runtime,path,value,headers)}
}
