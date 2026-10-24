import { runtimeBindings, type Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { Fault, json, text, id, digest, integer } from '../core'

import { activeSources, sourceFence, type Source } from './sources'
export { sourceDoor } from './sources'
const endpoint='/providers/twilio/events'

async function verify(request:Request,env:Bindings,parameters:URLSearchParams){
 const signature=request.headers.get('x-twilio-signature')
 if(!env.HANDSET_TWILIO_AUTH_TOKEN||!signature||!/^[A-Za-z0-9+/]{27}=$/.test(signature))throw new Fault('invalid_source_proof',403)
 let bytes:Uint8Array
 try{bytes=Uint8Array.from(atob(signature),c=>c.charCodeAt(0))}catch{throw new Fault('invalid_source_proof',403)}
 let signed=request.url
 for(const key of [...new Set(parameters.keys())].sort())for(const value of [...new Set(parameters.getAll(key))].sort())signed+=key+value
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.HANDSET_TWILIO_AUTH_TOKEN),{name:'HMAC',hash:'SHA-1'},false,['verify'])
 if(!await crypto.subtle.verify('HMAC',key,new Uint8Array(bytes).buffer,new TextEncoder().encode(signed)))throw new Fault('invalid_source_proof',403)
 // Twilio's defined scalar callback fields may not be supplied twice with
 // conflicting values, even though signature validation includes all values.
 for(const name of parameters.keys())if(parameters.getAll(name).length!==1)throw new Fault('duplicate_source_field')
}
function sourceText(value:string){text(value,'Body',1600,true);return value}
function normalize(p:URLSearchParams){
 const get=(key:string,optional=false)=>text(p.get(key)??'',key,200,optional)
 const account=get('AccountSid'),call=p.get('CallSid'),message=p.get('MessageSid'),recording=p.get('RecordingSid')
 const timestamp=p.get('Timestamp'),occurredAt=timestamp?Date.parse(timestamp):null
 if(timestamp&&!Number.isFinite(occurredAt))throw new Fault('invalid_source_timestamp')
 const dependent=Boolean(recording||p.get('ParentCallSid'))
 const from=get('From',dependent),to=get('To',dependent)
 if((from&&!/^\+[1-9]\d{7,14}$/.test(from))||(to&&!/^\+[1-9]\d{7,14}$/.test(to)))throw new Fault('unsupported_source_address')
 const sequence=p.get('SequenceNumber')
 if(sequence!==null)integer(Number(sequence),'SequenceNumber',0,1000000000)
 if(message){
  const state=get('MessageStatus',true)||get('SmsStatus',true)||'received'
  if(!['queued','sending','sent','delivered','undelivered','failed','receiving','received','read','accepted','scheduled','canceled'].includes(state))throw new Fault('invalid_message_status')
  const count=integer(Number(p.get('NumMedia')??0),'NumMedia',0,10)
  const media=[]
  for(let index=0;index<count;index++){
   const address=new URL(get('MediaUrl'+index));if(address.protocol!=='https:'||address.hostname!=='api.twilio.com'||address.username||address.password||address.search||address.hash)throw new Fault('invalid_media_reference')
   media.push({providerUrl:address.href,mime:get('MediaContentType'+index)})
  }
  return {account,externalId:get('MessageSid'),parent:'',eventId:`message:${get('MessageSid')}:${state}`,occurredAt,from,to,kind:'message',state,data:{channel:count?'mms':'sms',providerStatus:state,from,to,text:sourceText(p.get('Body')??''),media,capture:'metadata only; media not fetched'}}
 }
 if(!call)throw new Fault('unsupported_source_event')
 if(recording){
  const status=get('RecordingStatus');if(!['completed','absent','failed','in-progress'].includes(status))throw new Fault('invalid_recording_status')
  return {account,externalId:get('RecordingSid'),parent:get('CallSid'),eventId:`recording:${get('RecordingSid')}:${status}`,occurredAt,from,to,kind:'recording',state:status,data:{name:'Provider voicemail / recording reference',providerStatus:status,recordingSid:get('RecordingSid'),capture:'metadata only; playback and transcript remain unavailable'}}
 }
 const state=get('CallStatus');if(!['queued','initiated','ringing','in-progress','completed','busy','failed','no-answer','canceled'].includes(state))throw new Fault('invalid_call_status')
 return {account,externalId:get('CallSid'),parent:get('ParentCallSid',true),eventId:`call:${get('CallSid')}:${sequence??state}`,occurredAt,from,to,kind:'call',state,data:{providerStatus:state,from,to,...(p.get('CallDuration')?{durationSeconds:integer(Number(p.get('CallDuration')),'CallDuration',0,86400)}:{})}}
}
type Event=Omit<ReturnType<typeof normalize>,'data'> & {data:Record<string,unknown> & {media?:{providerUrl:string;mime:string}[]}}

// Provider account IDs are shared by many selected numbers. Existing object and
// parent identities route addressless dependent events to their original source.
async function eventSource(env:Bindings,event:Event){
 const [sources,objects]=await Promise.all([
  activeSources(env,event.account),
  env.DB.prepare('SELECT DISTINCT s.number_id FROM hnd_source_objects o JOIN hnd_sources s ON s.id=o.source_id WHERE o.external_id IN (?,?) AND s.account_id=?').bind(event.externalId,event.parent,event.account).all<{number_id:string}>(),
 ])
 const linked=sources.filter(s=>objects.results.some(o=>o.number_id===s.number_id))
 if(linked.length)return linked.length===1?linked[0]:null
 const matching=sources.filter(s=>s.e164===event.to)
 return matching.length===1?matching[0]:null
}

async function sourceTimestamp(env:Bindings,event:Event):Promise<Event>{
 if(event.occurredAt!==null&&event.kind!=='recording')return event
 const resource=event.kind==='message'?'Messages':event.kind==='recording'?'Recordings':null
 if(!resource)throw new Fault('provider_event_timestamp_required')
 let response:Response
 try{response=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(event.account)}/${resource}/${encodeURIComponent(event.externalId)}.json`,{headers:{authorization:'Basic '+btoa(event.account+':'+env.HANDSET_TWILIO_AUTH_TOKEN)},redirect:'manual',signal:AbortSignal.timeout(5000)})}catch{throw new Fault('provider_readback_unavailable',503)}
 if(response.status!==200)throw new Fault('provider_readback_unavailable',503)
 let receipt:Record<string,unknown>
 try{receipt=await response.json()}catch{throw new Fault('invalid_provider_readback',502)}
 if(receipt.sid!==event.externalId||receipt.account_sid!==event.account||event.kind==='message'&&(receipt.from!==event.from||receipt.to!==event.to)||event.kind==='recording'&&receipt.call_sid!==event.parent)throw new Fault('provider_readback_identity_mismatch',502)
 if(event.kind==='recording'){
  if(receipt.status!==event.state)throw new Fault('provider_recording_status_mismatch',502)
  const completed=event.state==='completed'
  if(completed&&(!/^\d{1,6}$/.test(String(receipt.duration))||![1,2].includes(Number(receipt.channels))))throw new Fault('provider_recording_metadata_unavailable',503)
  const occurredAt=Date.parse(String(receipt.start_time??receipt.date_created))
  if(!Number.isFinite(occurredAt))throw new Fault('provider_time_unavailable',503)
  return {...event,occurredAt,data:{...event.data,...(completed?{durationSeconds:Number(receipt.duration),channels:Number(receipt.channels)}:{}),capture:'provider metadata only; capture consent is unverified',captureConsent:'unverified'}}
 }
 const occurredAt=Date.parse(String(event.kind==='message'?(receipt.date_sent??receipt.date_created):(receipt.start_time??receipt.date_created)))
 if(!Number.isFinite(occurredAt))throw new Fault('provider_time_unavailable',503)
 return {...event,occurredAt}
}

// Reconsent changes authority, not the canonical identity of earlier facts.
// Only the same provider account and exact native number share this lineage.
async function historicalReceipt(env:Bindings,source:Source,eventId:string){
 const rows=(await env.DB.prepare('SELECT body_hash,record_id FROM hnd_source_receipts WHERE source_id IN (SELECT id FROM hnd_sources WHERE account_id=? AND number_id=?) AND event_id=?').bind(source.account_id,source.number_id,eventId).all<{body_hash:string;record_id:string}>()).results
 if(new Set(rows.map(row=>row.record_id+':'+row.body_hash)).size>1)throw new Fault('source_history_ambiguous',409)
 return rows[0]
}
async function historicalObject(env:Bindings,source:Source,externalId:string){
 const rows=(await env.DB.prepare('SELECT record_id,case_id FROM hnd_source_objects WHERE source_id IN (SELECT id FROM hnd_sources WHERE account_id=? AND number_id=?) AND external_id=?').bind(source.account_id,source.number_id,externalId).all<{record_id:string;case_id:string}>()).results
 if(new Set(rows.map(row=>row.record_id+':'+row.case_id)).size>1)throw new Fault('source_history_ambiguous',409)
 return rows[0]
}
async function ingest(env:Bindings,source:Source,event:Event,bodyHash:string,parameters:string,receivedAt:number):Promise<{held?:boolean;recordId?:string;caseId?:string;replay?:boolean}>{
 const db=env.DB
 const receipt=await historicalReceipt(env,source,event.eventId)
 if(receipt){if(receipt.body_hash!==bodyHash)throw new Fault('source_event_conflict',409);await append(env,source.id,'source.replay',receipt.record_id,'completed',[sourceFence(env,source)],null,sourcePolicy(source));return {recordId:receipt.record_id,replay:true}}
 const parent=event.parent?await historicalObject(env,source,event.parent):null
 if(event.parent&&!parent){
  const pending=await db.prepare('SELECT body_hash FROM hnd_source_pending WHERE source_id=? AND event_id=?').bind(source.id,event.eventId).first<{body_hash:string}>()
  if(pending){if(pending.body_hash!==bodyHash)throw new Fault('source_event_conflict',409);return {held:true,replay:true}}
  await append(env,source.id,'source.held',source.id,'completed',[sourceFence(env,source),db.prepare('INSERT INTO hnd_source_pending VALUES (?,?,?,?,?,?)').bind(source.id,event.eventId,bodyHash,event.parent,parameters,receivedAt)],null,sourcePolicy(source))
  return {held:true}
 }
 const ownNumber=await db.prepare("SELECT data FROM hnd_records WHERE id=? AND kind='number'").bind(source.number_id).first<{data:string}>()
 const own=ownNumber&&JSON.parse(ownNumber.data).e164
 if(!own)throw new Fault('source_number_unavailable',409)
 if(!parent&&event.from!==own&&event.to!==own)throw new Fault('source_number_out_of_scope',403)
 const peer=event.from===own?event.to:event.from,correlation=await digest([source.account_id,source.number_id,own,peer])
 const lineage=(await db.prepare('SELECT id FROM hnd_sources WHERE account_id=? AND number_id=?').bind(source.account_id,source.number_id).all<{id:string}>()).results
 const correlations=[correlation,...await Promise.all(lineage.map(previous=>digest([previous.id,own,peer])))]
 const existingCase=parent?{case_id:parent.case_id}:await db.prepare('SELECT c.case_id FROM hnd_source_cases c JOIN hnd_sources s ON s.id=c.source_id WHERE s.account_id=? AND s.number_id=? AND c.correlation IN (SELECT value FROM json_each(?)) ORDER BY s.created_at,s.id LIMIT 1').bind(source.account_id,source.number_id,JSON.stringify(correlations)).first<{case_id:string}>()
 const caseId=existingCase?.case_id??id(),recordId=id(),now=receivedAt,occurredAt=event.occurredAt??receivedAt
 const existingObject=await historicalObject(env,source,event.externalId)
 const objectKind=event.kind==='call'?(event.parent?'call_leg':'call_session'):event.kind
 const kind=existingObject?'provider_attempt':objectKind
 if(existingObject&&existingObject.case_id!==caseId)throw new Fault('source_correlation_conflict',409)
 const statements=[sourceFence(env,source)]
 if(!existingCase){
  statements.push(db.prepare('INSERT INTO hnd_cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(caseId,'Communication with '+peer,source.owner_id,null,'','open',0,1,1,source.owner_id,now,''))
  statements.push(db.prepare('INSERT INTO hnd_source_cases VALUES (?,?,?)').bind(source.id,correlation,caseId))
 }
 const data={...event.data,...(existingObject?{operation:'provider_status',objectKind}:{}),direction:event.from===own?'outbound':'inbound',sourceOccurredAt: event.occurredAt===null?'not supplied by provider':'provider timestamp',customerOutcome:'unconfirmed'}
 statements.push(db.prepare('INSERT INTO hnd_records VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(recordId,kind,'native',source.id+':'+event.eventId,occurredAt,now,caseId,existingObject?.record_id??parent?.record_id??null,null,JSON.stringify(data),source.id))
 statements.push(db.prepare('INSERT INTO hnd_record_sources VALUES (?,?,?,?)').bind(recordId,source.id,'twilio',event.eventId))
 if(!existingObject)statements.push(db.prepare('INSERT INTO hnd_source_objects VALUES (?,?,?,?)').bind(source.id,event.externalId,recordId,caseId))
 if(!existingObject && event.kind==='message' && 'media' in event.data){
  for(const [index,media] of (event.data.media??[]).entries()){
   const mediaId=id()
   statements.push(db.prepare('INSERT INTO hnd_records VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(mediaId,'media','native',source.id+':'+event.eventId+':media:'+index,occurredAt,now,caseId,recordId,null,JSON.stringify({...media,capture:'metadata only; content unavailable'}),source.id))
   statements.push(db.prepare('INSERT INTO hnd_record_sources VALUES (?,?,?,?)').bind(mediaId,source.id,'twilio',event.eventId+':media:'+index))
  }
 }

 if(event.kind==='recording'&&event.state==='completed'){
  const mediaId=id(),parentId=existingObject?.record_id??recordId
  const metadata=event.data as Record<string,unknown>
  statements.push(db.prepare('INSERT INTO hnd_records VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(mediaId,'media','native',source.id+':'+event.eventId+':audio',occurredAt,now,caseId,parentId,null,JSON.stringify({mime:'audio/wav',durationSeconds:metadata.durationSeconds,channels:metadata.channels,recordingSid:event.externalId,captureConsent:'unverified',content:'not copied; separate exact-person playback approval required'}),source.id))
  statements.push(db.prepare('INSERT INTO hnd_record_sources VALUES (?,?,?,?)').bind(mediaId,source.id,'twilio',event.eventId+':audio'))
 }

 // A verified inbound opt-out cancels pending promises for this correlated need.
 // Started remote work stays visibly started: this is not a claim of remote deletion.
 if (event.kind === 'message' && ['received','receiving'].includes(event.state) && 'text' in event.data && /^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(String(event.data.text).trim())) {
  statements.push(db.prepare("INSERT INTO hnd_protection_stops VALUES (?,?,?,'all','consent_revoked',?,?) ON CONFLICT(number_id,recipient,channel,reason) DO NOTHING").bind(id(),source.number_id,peer,source.id,now))
  statements.push(db.prepare(`UPDATE hnd_followups SET status='canceled',delivery=CASE WHEN delivery IN ('draft','approved','held') THEN 'canceled' ELSE delivery END,reason='Signed inbound STOP; obsolete follow-up canceled',revision=revision+1,updated_at=? WHERE case_id=? AND status='open'`).bind(now,caseId))
  statements.push(db.prepare(`INSERT INTO hnd_followup_history SELECT id,revision,json_object('status',status,'delivery',delivery,'reason',reason),?,? FROM hnd_followups WHERE case_id=? AND updated_at=? AND reason='Signed inbound STOP; obsolete follow-up canceled' ON CONFLICT(id,revision) DO NOTHING`).bind(source.id,now,caseId,now))
 }
 if (event.kind === 'call' && ['no-answer','busy','failed','canceled'].includes(event.state)) statements.push(db.prepare("INSERT INTO hnd_rule_events VALUES (?,'missed_call',?) ON CONFLICT(record_id) DO NOTHING").bind(recordId, now))
 statements.push(db.prepare('INSERT INTO hnd_source_receipts VALUES (?,?,?,?,?,?)').bind(source.id,event.eventId,bodyHash,occurredAt,now,recordId))
 statements.push(db.prepare('DELETE FROM hnd_source_pending WHERE source_id=? AND event_id=?').bind(source.id,event.eventId))
 try{await append(env,source.id,'source.receive',recordId,'completed',statements,null,sourcePolicy(source))}
 catch(error){if(/UNIQUE constraint failed: hnd_(source_cases|source_objects|source_receipts|records)/.test(String(error)))return ingest(env,source,event,bodyHash,parameters,receivedAt);throw error}
 return {recordId,caseId,replay:false}
}
export async function twilioResponse(request:Request,original:Bindings):Promise<Response|null>{
 const url=new URL(request.url)
 if(url.pathname!==endpoint)return null
 const env=runtimeBindings(original)
 let knownSource:Source|null=null
 try{
  if(url.origin!==env.AUTH_ORIGIN||url.search||request.headers.has('host')&&request.headers.get('host')?.toLowerCase()!==url.host.toLowerCase())throw new Fault('invalid_source_proof',403)
  if(request.method!=='POST')throw new Fault('method_not_allowed',405)
  if(!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw new Fault('invalid_source_content_type',415)
  const body=await request.text();if(new TextEncoder().encode(body).length>65536)throw new Fault('body_too_large',413)
  const p=new URLSearchParams(body)
  await verify(request,env,p)
  let event:Event=normalize(p)
  const source=await eventSource(env,event)
  knownSource=source??await env.DB.prepare(`SELECT s.* FROM hnd_sources s JOIN hnd_records n ON n.id=s.number_id WHERE s.account_id=? AND (json_extract(n.data,'$.e164')=? OR EXISTS(SELECT 1 FROM hnd_source_objects so WHERE so.source_id=s.id AND so.external_id IN (?,?))) ORDER BY s.revision DESC LIMIT 1`).bind(event.account,event.to,event.externalId,event.parent).first<Source>()
  if(!source)throw new Fault('invalid_source_proof',403)
  const alreadyRecorded=await historicalReceipt(env,source,event.eventId)
  if(!alreadyRecorded)event=await sourceTimestamp(env,event)
  // Persist only the documented fields needed to replay a verified dependent event.
  const allowed=['AccountSid','CallSid','ParentCallSid','CallStatus','CallDuration','SequenceNumber','Timestamp','From','To','MessageSid','MessageStatus','SmsStatus','Body','NumMedia','RecordingSid','RecordingStatus',...Array.from({length:10},(_,i)=>['MediaUrl'+i,'MediaContentType'+i]).flat()]
  const retained=new URLSearchParams([...p].filter(([key])=>allowed.includes(key))).toString(),bodyHash=await digest([...p].sort(([a],[b])=>a.localeCompare(b))),receivedAt=Date.now()
  const result=await ingest(env,source,event,bodyHash,retained,receivedAt)
  if(!result.held){
   const pending=(await env.DB.prepare('SELECT * FROM hnd_source_pending WHERE source_id=? AND parent_external_id=? ORDER BY received_at LIMIT 100').bind(source.id,event.externalId).all<{parameters:string;body_hash:string;received_at:number}>()).results
   for(const item of pending)await ingest(env,source,await sourceTimestamp(env,normalize(new URLSearchParams(item.parameters))),item.body_hash,item.parameters,item.received_at)
  }
  return json({...result,customerOutcome:'unconfirmed',externalEffectOccurred:false},result.held?202:200)
 }catch(error){
  if(error instanceof Fault){if(knownSource)await append(env,knownSource.id,'source.refuse','installation','refused',[],null,sourcePolicy(knownSource));return json({error:error.code},error.status)}
  if(String(error).includes('CHECK constraint failed'))return json({error:'source_authority_changed'},409)
  console.error('Handset source event failed',error instanceof Error?error.name:'unknown')
  return json({error:'source_unavailable'},503)
 }
}
