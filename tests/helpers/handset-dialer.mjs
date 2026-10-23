import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { post } from './handset-auth.mjs'
import { sourceFixture } from './handset-sources.mjs'
import { queueFixture, authorizeQueueMedia } from './handset-queues.mjs'

// Fakes are exclusively at Twilio's documented network boundary. Native lists,
// consent records, approvals, reservations, sessions and cursors use public HTTP.
// https://www.twilio.com/docs/voice/api/call-resource
// https://www.twilio.com/docs/voice/api/conference-participant-resource
// https://www.ftc.gov/business-guidance/resources/complying-telemarketing-sales-rule
export async function dialerFixture(runtime){
 const s=await sourceFixture(runtime),q=await queueFixture(runtime,s.cookie),media=await authorizeQueueMedia(q,s),base='/api/handset/dialer'
 let sequence=2000
 const next=()=>`synthetic-handset-${sequence++}`
 async function write(path,value,status=200){const r=await post(runtime,path,value,s.headers);assert.equal(r.status,status,await r.clone().text());return r.json()}
 async function read(){const r=await runtime.request(base,{headers:s.headers});assert.equal(r.status,200,await r.clone().text());return r.json()}
 async function record(kind,data,caseId,parentId){return (await write('/api/handset/records',{kind,data,caseId,parentId,occurredAt:Date.now(),sourceId:next()},201)).record.id}
 const current=(await q.read()).agents.find(a=>a.operator_id===q.spanish)
 await q.write(q.base+'/agents',{operatorId:q.spanish,languages:['en','es'],skills:['service'],capacity:1,revision:current.revision,confirm:'approve native agent capabilities'},201)
 const numberSid=next();s.resource('IncomingPhoneNumbers',numberSid,{phone_number:'+15125550125',capabilities:{voice:true}})
 const evidence=await record('comment',{text:'Synthetic independent qualification evidence. Network-edge testing only; no legal or live-traffic certification.'})
 const qualificationInput={sourceId:s.source.id,numberSid,legalReviewer:next(),legalEvidenceId:evidence,providerReviewer:next(),providerEvidenceId:evidence,trafficEvidenceId:evidence,jurisdictions:['US-TX','US-FL'],modes:['preview','progressive','power','parallel','predictive'],disclosure:'Synthetic service team calling about your requested appointment.',abandonMessage:'Synthetic service team. Please call +15125550125.',maxAbandonBps:300,maxConnectMs:2000,ringSeconds:15,reportWindowDays:30,minimumSamples:1,maxConcurrency:2,inboundReserve:1,breachSeconds:20,expiresAt:Date.now()+7*86400000,confirm:'record independently qualified policy and permitted traffic'}
 const qualified=await write(base+'/qualifications',qualificationInput,201)
 const purpose='Synthetic requested appointment callback'
 const complianceRecipients=[]
 async function importResults(kind,extra={}){
  const jurisdiction=extra.jurisdiction??(kind==='state'?'US-TX':'US')
  const candidates=complianceRecipients.filter(r=>kind!=='state'||r.jurisdiction===jurisdiction)
  const unique=[...new Map(candidates.map(r=>[r.recipient+(kind==='reassigned'?r.consentId:''),r])).values()]
  return write(base+'/extracts',{kind,jurisdiction,publishedAt:Date.now()-1000,expiresAt:Date.now()+30*86400000,sourceReference:'synthetic-handset-2900 licensed extract',evidenceId:evidence,rows:unique.map(r=>({recipient:r.recipient,status:'clear',...(kind==='reassigned'?{consentId:r.consentId}:{})})),confirm:'import licensed compliance results',...extra},201)
 }
 async function provision(recipients){
  complianceRecipients.push(...recipients)
  await importResults('national');await importResults('reassigned')
  for(const jurisdiction of new Set(recipients.map(r=>r.jurisdiction)))await importResults('state',{jurisdiction})
 }
 await write(base+'/state-rules',{jurisdiction:'US-TX',startMinute:480,endMinute:1260,maxAttempts:100,windowHours:24,writtenModes:[],evidenceId:evidence,reviewAt:Date.now()+30*86400000,confirm:'approve reviewed state calling rules'},201)

 // Select an open local clock for synthetic receivers at any CI execution time.
 // Explicit quiet-hour refusal assertions still use their fixed local timestamps.
 function openTimezone(endHour=21){
  for(const tz of ['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','Pacific/Honolulu','Europe/London','Asia/Tokyo']){const parts=new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',hourCycle:'h23'}).formatToParts(new Date()),h=Number(parts.find(p=>p.type==='hour').value);if(h>=8&&h<endHour)return tz}
  throw new Error('No permitted synthetic calling timezone at this UTC time')
 }
 async function makeList({count=3,mode,policyId,check=true,...extra}={}){
  const recipients=[]
  for(let n=0;n<count;n++){
   const displayName=['Alicia Torres','Daniel Kim','Rosa García'][n%3],c=await write('/api/handset/cases',{title:'Requested appointment callback · '+displayName+' · Austin office'},201),caseId=c.current.id,personId=await record('person',{name:displayName},caseId),consentId=await record('consent',{purpose,state:'pending'},caseId,personId),recipient='+1512555'+String(sequence++).padStart(4,'0')
   recipients.push({caseId,personId,consentId,recipient,timezone:openTimezone(),jurisdiction:'US-TX',startMinute:480,endMinute:1260})
  }
  const input={name:next(),purpose,sourceId:s.source.id,queueId:q.sales.id,qualificationId:qualified.id,repId:q.english,budgetCents:1000,attemptCents:100,maxConcurrency:2,modes:mode?[mode]:qualificationInput.modes,recipients,expiresAt:Date.now()+1800000,...(policyId?{policyId}:{}),confirm:policyId?'snapshot list under exact standing policy':'approve exact campaign list and budget',...extra}
  await provision(input.recipients)
  const list={...await write(base+'/lists',input,201),input,recipients:input.recipients}
  if(check)for(let n=0;n<input.recipients.length;n++)await verify(list,n,input.recipients[n].consentId)
  return {...list,input,recipients:input.recipients}
 }
 async function verify(l,ordinal,evidenceId,extra={}){return write(base+'/lists/'+l.id+'/recipients/'+ordinal+'/verify',{consentEvidenceId:evidenceId,company:'clear',national:'clear',state:'clear',campaign:'clear',purpose,methods:l.input.modes,expiresAt:Date.now()+1200000,confirm:'verify exact recipient consent and current suppression checks',...extra})}
 let currentReady
 async function ready(agentId=q.english,{persist=true}={}){
  await q.presence(q.english);await q.presence(q.spanish)
  const conferenceSid=next(),agentCallSid=next(),conferenceName=next(),now=new Date(Date.now()-10000).toUTCString()
  s.resource('Conferences',conferenceSid,{friendly_name:conferenceName,status:'in-progress'})
  s.resource('Calls',agentCallSid,{to:media.destinations[agentId],from:'+15125550125',direction:'outbound-api',status:'in-progress',date_created:now,start_time:now,end_time:null,duration:null})
  const participantsUrl=`https://api.twilio.com/2010-04-01/Accounts/${s.account}/Conferences/${conferenceSid}/Participants.json?PageSize=100`
  const agent={account_sid:s.account,conference_sid:conferenceSid,call_sid:agentCallSid,status:'connected',muted:false,hold:false,date_created:now}
  runtime.twilioResources.set(participantsUrl,{participants:[agent],next_page_uri:null})
  currentReady={conferenceSid,agentCallSid,conferenceName,participantsUrl,agent,agentId}
  if(persist)await write(base+'/ready',{agentId,sourceId:s.source.id,conferenceSid,conferenceName,agentCallSid,expiresAt:Date.now()+85000,confirm:'reserve this independently connected waiting agent'})
  return currentReady
 }
 async function session(l,mode='progressive'){return write(base+'/lists/'+l.id+'/sessions',{mode,confirm:'start exact approved list in this mode'},201)}
 function prepare(l,ordinal=0,{status='queued',createStatus=201}={}){
  const sid=next(),created=new Date().toUTCString(),data={account_sid:s.account,sid,from:'+15125550125',to:l.recipients[ordinal].recipient,direction:'outbound-api',status,date_created:created,start_time:null,end_time:null,duration:null}
  const creation=async request=>{
   const fields=await request.clone().formData()
   assert.equal(fields.get('To'),data.to);assert.equal(fields.get('From'),data.from)
   assert.ok(fields.get('Record')===null||fields.get('Record')==='false','no recording is authorized')
   assert.equal(new URL(fields.get('Url')).origin,runtime.origin)
   data.date_created=new Date().toUTCString()
   s.resource('Calls',sid,data)
   return {__httpStatus:createStatus,...data}
  }
  runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${s.account}/Calls.json`,creation)
  return {sid,data,waiting:currentReady,creation}
 }
 async function launch(run,recipient,extra={}){return write(base+'/sessions/'+run.id+'/launch',{eventKey:next(),...(run.mode==='preview'?{previewRecipient:recipient}:{}),confirm:'launch exact approved recipients now',...extra})}
 function callback(a,call,kind='status',{signature=true,...fields}={}){
  const path='/providers/twilio/dialer/'+a.id+'/'+kind,data={AccountSid:s.account,CallSid:call.sid,From:call.data.from,To:call.data.to,CallStatus:call.data.status,...fields},params=new URLSearchParams(data)
  let signed=runtime.origin+path;for(const key of Object.keys(data).sort())signed+=key+data[key]
  return runtime.request(path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...(signature?{'x-twilio-signature':createHmac('sha1','synthetic-handset-500').update(signed).digest('base64')}:{})},body:params.toString()})
 }
 function updateCall(call,changes){Object.assign(call.data,changes);s.resource('Calls',call.sid,call.data)}
 async function connect(a,call){
  const started=new Date().toUTCString();updateCall(call,{status:'in-progress',start_time:started})
  const answer=await callback(a,call,'answer');assert.equal(answer.status,200,await answer.clone().text());assert.match(await answer.text(),/<Conference /)
  runtime.twilioResources.set(call.waiting.participantsUrl,{participants:[call.waiting.agent,{account_sid:s.account,conference_sid:call.waiting.conferenceSid,call_sid:call.sid,status:'connected',muted:false,hold:false,date_created:started}],next_page_uri:null})
  const observed=await callback(a,call);assert.equal(observed.status,200,await observed.clone().text())
 }
 async function finish(a,call,outcome='human_connected'){
  // Provider fixture duration is independent receipt data. No local application
  // rates, completed calls or capacity are seeded directly into the database.
  await new Promise(resolve=>setTimeout(resolve,1100))
  const start=Date.parse(call.data.start_time??new Date().toUTCString()),end=new Date().toUTCString()
  updateCall(call,{status:outcome==='unanswered'?'no-answer':'completed',end_time:end,duration:outcome==='unanswered'?null:String(Math.floor((Date.parse(end)-start)/1000))})
  const observed=await callback(a,call);assert.equal(observed.status,200,await observed.clone().text())
  await write(base+'/attempts/'+a.id+'/disposition',{outcome,notes:'Synthetic controlled receiver observation',confirm:'record observed call disposition'})
  // Model native wrap expiry by time, never by fabricating a provider outcome.
  await runtime.sql('UPDATE hnd_queue_agents SET wrap_until=0 WHERE operator_id=?',a.agent_id)
 }
 async function addAgent(){
  const agentId=next(),destination='sip:'+next()+'@'+next()+'.example.test'
  await runtime.sql('INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES (?,?,?,?,?,?)',agentId,agentId+'@example.test',agentId,'member','active',Date.now())
  await q.write(q.base+'/agents',{operatorId:agentId,languages:['en'],skills:['service'],capacity:1,confirm:'approve native agent capabilities'},201)
  await q.write(q.base+'/'+q.sales.id+'/memberships',{operatorId:agentId,loggedIn:1,confirm:'approve queue membership'})
  await q.write(q.base+'/agents/'+agentId+'/route',{sourceId:s.source.id,kind:'sip',destination,confirm:'approve exact queue agent route'})
  media.destinations[agentId]=destination
  await q.presence(agentId)
  return agentId
 }
 return {...s,q,media,base,purpose,evidence,qualified,qualificationInput,importResults,provision,complianceRecipients,write,read,record,makeList,verify,ready,session,prepare,launch,callback,connect,finish,updateCall,next,addAgent,openTimezone}
}
