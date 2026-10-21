import { runtimeBindings, type Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { append, commit } from '../audit/store'
import { Fault, json, text, keys, id, digest, integer, page, escape as e, field, type ObjectValue } from '../core'

interface Source {id:string;account_id:string;number_id:string;owner_id:string;owner_version:number;revision:number;revoked_at:number|null;created_at:number}
const endpoint='/providers/twilio/events'
const sourceFence=(env:Bindings,s:Source)=>env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id WHERE s.id=? AND s.revision=? AND s.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=s.owner_version`).bind(s.id,s.revision)
const activeSource=async(env:Bindings,account:string)=>(await env.DB.prepare(`SELECT s.* FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id WHERE s.account_id=? AND s.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=s.owner_version`).bind(account).first<Source>())
export async function sourceDoor(request:Request,env:Bindings,actor:Session,value?:ObjectValue):Promise<Response|null>{
 const path=new URL(request.url).pathname,html=path.startsWith('/app/'),base=html?'/app/sources':'/api/handset/sources'
 if(path!==base && path!==base+'/revoke')return null
 if(request.method==='GET'&&path===base){
  const rows=(await env.DB.prepare('SELECT id,account_id,number_id,revision,revoked_at FROM hnd_sources').all()).results
  const pending=(await env.DB.prepare('SELECT source_id,event_id,parent_external_id,received_at FROM hnd_source_pending ORDER BY received_at').all()).results
  await commit(env,actor,'source.read','installation','completed')
  return html?page('Verified communication sources',`<p>Receive signed Twilio events for one selected business number. This grants no outbound or recording-capture authority. The installation owner supplies the Twilio authentication token through its private secret binding.</p><ul>${rows.map(r=>`<li>${e(r.account_id)} · ${r.revoked_at?'Revoked':'Active'}<p>Source ${e(r.id)} · Number ${e(r.number_id)} · Revision ${e(r.revision)}</p><form method="post" action="/app/sources/revoke"><input type="hidden" name="sourceId" value="${e(r.id)}"><button>Revoke source ${e(r.id)}</button></form></li>`).join('')||'<li>No authorized sources.</li>'}</ul><form method="post">${field('Twilio account SID','accountId')}${field('Selected native business-number record ID','numberId')}<label><input type="checkbox" name="confirm" value="authorize signed inbound records" required>I authorize signed inbound communication records for this account and number</label><button>Authorize inbound records</button></form><h2>Unresolved source events</h2><ul>${pending.map(p=>`<li>${e(p.event_id)} · Waiting for parent ${e(p.parent_external_id)}</li>`).join('')||'<li>No unresolved events.</li>'}</ul>`):json({sources:rows,pending})
 }
 if(request.method!=='POST'||!value)throw new Fault('method_not_allowed',405)
 if(path===base+'/revoke'){
  keys(value,['sourceId']);const sourceId=text(value.sourceId,'sourceId')
  if(!await env.DB.prepare('SELECT id FROM hnd_sources WHERE id=?').bind(sourceId).first())throw new Fault('source_not_found',404)
  await commit(env,actor,'source.revoke',sourceId,'completed',[env.DB.prepare('UPDATE hnd_sources SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE id=?').bind(Date.now(),sourceId)])
  return html?page('Source revoked','<p>Further source events are refused. Completed communication evidence is retained.</p>'):json({revoked:true})
 }
 keys(value,['accountId','numberId','confirm'])
 if(value.confirm!=='authorize signed inbound records')throw new Fault('explicit_source_consent_required')
 if(!env.HANDSET_TWILIO_AUTH_TOKEN)throw new Fault('twilio_secret_binding_required',409)
 const numberId=text(value.numberId,'numberId'),accountId=text(value.accountId,'accountId'),sourceId=id()
 if(!await env.DB.prepare("SELECT id FROM hnd_records WHERE id=? AND kind='number'").bind(numberId).first())throw new Fault('native_number_required')
 try{await commit(env,actor,'source.create',sourceId,'completed',[env.DB.prepare('INSERT INTO hnd_sources VALUES (?,?,?,?,?,?,?,?)').bind(sourceId,accountId,numberId,actor.operator.id,actor.operator.version,1,null,Date.now())])}
 catch(error){if(String(error).includes('UNIQUE constraint'))throw new Fault('source_already_registered',409);throw error}
 return html?page('Source authorized',`<p>Signed callbacks may use ${endpoint}. No call or message has been sent.</p><a href="/app/sources">Review sources</a>`):json({id:sourceId,callbackPath:endpoint},201)
}
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
function normalize(p:URLSearchParams){
 const get=(key:string,optional=false)=>text(p.get(key)??'',key,200,optional)
 const account=get('AccountSid'),call=p.get('CallSid'),message=p.get('MessageSid'),recording=p.get('RecordingSid')
 const timestamp=p.get('Timestamp'),occurredAt=timestamp?Date.parse(timestamp):null
 if(timestamp&&!Number.isFinite(occurredAt))throw new Fault('invalid_source_timestamp')
 const from=get('From',Boolean(recording)),to=get('To',Boolean(recording))
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
  return {account,externalId:get('MessageSid'),parent:'',eventId:`message:${get('MessageSid')}:${state}`,occurredAt,from,to,kind:'message',state,data:{channel:count?'mms':'sms',providerStatus:state,from,to,text:text(p.get('Body')??'','Body',1600,true),media,capture:'metadata only; media not fetched'}}
 }
 if(!call)throw new Fault('unsupported_source_event')
 if(recording){
  const status=get('RecordingStatus');if(!['completed','absent','failed','in-progress'].includes(status))throw new Fault('invalid_recording_status')
  return {account,externalId:get('RecordingSid'),parent:get('CallSid'),eventId:`recording:${get('RecordingSid')}:${status}`,occurredAt,from,to,kind:'recording',state:status,data:{name:'Provider voicemail / recording reference',providerStatus:status,recordingSid:get('RecordingSid'),capture:'metadata only; playback and transcript remain unavailable'}}
 }
 const state=get('CallStatus');if(!['queued','initiated','ringing','in-progress','completed','busy','failed','no-answer','canceled'].includes(state))throw new Fault('invalid_call_status')
 return {account,externalId:get('CallSid'),parent:get('ParentCallSid',true),eventId:`call:${get('CallSid')}:${sequence??state}`,occurredAt,from,to,kind:'call',state,data:{providerStatus:state,from,to,...(p.get('CallDuration')?{durationSeconds:integer(Number(p.get('CallDuration')),'CallDuration',0,86400)}:{})}}
}
type Event=ReturnType<typeof normalize>

async function sourceTimestamp(env:Bindings,event:Event){
 if(event.occurredAt!==null)return event
 const resource=event.kind==='message'?'Messages':event.kind==='recording'?'Recordings':null
 if(!resource)throw new Fault('provider_event_timestamp_required')
 let response:Response
 try{response=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(event.account)}/${resource}/${encodeURIComponent(event.externalId)}.json`,{headers:{authorization:'Basic '+btoa(event.account+':'+env.HANDSET_TWILIO_AUTH_TOKEN)},redirect:'manual',signal:AbortSignal.timeout(5000)})}catch{throw new Fault('provider_readback_unavailable',503)}
 if(response.status!==200)throw new Fault('provider_readback_unavailable',503)
 let receipt:Record<string,unknown>
 try{receipt=await response.json()}catch{throw new Fault('invalid_provider_readback',502)}
 if(receipt.sid!==event.externalId||receipt.account_sid!==event.account||event.kind==='message'&&(receipt.from!==event.from||receipt.to!==event.to)||event.kind==='recording'&&receipt.call_sid!==event.parent)throw new Fault('provider_readback_identity_mismatch',502)
 const occurredAt=Date.parse(String(event.kind==='message'?(receipt.date_sent??receipt.date_created):(receipt.start_time??receipt.date_created)))
 if(!Number.isFinite(occurredAt))throw new Fault('provider_time_unavailable',503)
 return {...event,occurredAt}
}

async function ingest(env:Bindings,source:Source,event:Event,bodyHash:string,parameters:string,receivedAt:number):Promise<{held?:boolean;recordId?:string;caseId?:string;replay?:boolean}>{
 const db=env.DB
 const receipt=await db.prepare('SELECT body_hash,record_id FROM hnd_source_receipts WHERE source_id=? AND event_id=?').bind(source.id,event.eventId).first<{body_hash:string;record_id:string}>()
 if(receipt){if(receipt.body_hash!==bodyHash)throw new Fault('source_event_conflict',409);await append(env,source.id,'source.replay',receipt.record_id,'completed',[sourceFence(env,source)]);return {recordId:receipt.record_id,replay:true}}
 const parent=event.parent?await db.prepare('SELECT record_id,case_id FROM hnd_source_objects WHERE source_id=? AND external_id=?').bind(source.id,event.parent).first<{record_id:string;case_id:string}>():null
 if(event.parent&&!parent){
  const pending=await db.prepare('SELECT body_hash FROM hnd_source_pending WHERE source_id=? AND event_id=?').bind(source.id,event.eventId).first<{body_hash:string}>()
  if(pending){if(pending.body_hash!==bodyHash)throw new Fault('source_event_conflict',409);return {held:true,replay:true}}
  await append(env,source.id,'source.held',source.id,'completed',[sourceFence(env,source),db.prepare('INSERT INTO hnd_source_pending VALUES (?,?,?,?,?,?)').bind(source.id,event.eventId,bodyHash,event.parent,parameters,receivedAt)])
  return {held:true}
 }
 const ownNumber=await db.prepare("SELECT data FROM hnd_records WHERE id=? AND kind='number'").bind(source.number_id).first<{data:string}>()
 const own=ownNumber&&JSON.parse(ownNumber.data).e164
 if(!own)throw new Fault('source_number_unavailable',409)
 if(!parent&&event.from!==own&&event.to!==own)throw new Fault('source_number_out_of_scope',403)
 const peer=event.from===own?event.to:event.from,correlation=await digest([source.id,own,peer])
 const existingCase=parent?{case_id:parent.case_id}:await db.prepare('SELECT case_id FROM hnd_source_cases WHERE source_id=? AND correlation=?').bind(source.id,correlation).first<{case_id:string}>()
 const caseId=existingCase?.case_id??id(),recordId=id(),now=receivedAt,occurredAt=event.occurredAt??receivedAt
 const kind=event.kind==='call'?(event.parent?'call_leg':'call_session'):event.kind
 const existingObject=await db.prepare('SELECT record_id,case_id FROM hnd_source_objects WHERE source_id=? AND external_id=?').bind(source.id,event.externalId).first<{record_id:string;case_id:string}>()
 if(existingObject&&existingObject.case_id!==caseId)throw new Fault('source_correlation_conflict',409)
 const statements=[sourceFence(env,source)]
 if(!existingCase){
  statements.push(db.prepare('INSERT INTO hnd_cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(caseId,'Communication with '+peer,source.owner_id,null,'','open',0,1,1,source.owner_id,now,''))
  statements.push(db.prepare('INSERT INTO hnd_source_cases VALUES (?,?,?)').bind(source.id,correlation,caseId))
 }
 const data={...event.data,direction:event.from===own?'outbound':'inbound',sourceOccurredAt: event.occurredAt===null?'not supplied by provider':'provider timestamp',customerOutcome:'unconfirmed'}
 statements.push(db.prepare('INSERT INTO hnd_records VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(recordId,kind,'native',source.id+':'+event.eventId,occurredAt,now,caseId,parent?.record_id??existingObject?.record_id??null,null,JSON.stringify(data),source.id))
 statements.push(db.prepare('INSERT INTO hnd_record_sources VALUES (?,?,?,?)').bind(recordId,source.id,'twilio',event.eventId))
 if(!existingObject)statements.push(db.prepare('INSERT INTO hnd_source_objects VALUES (?,?,?,?)').bind(source.id,event.externalId,recordId,caseId))
 statements.push(db.prepare('INSERT INTO hnd_source_receipts VALUES (?,?,?,?,?,?)').bind(source.id,event.eventId,bodyHash,occurredAt,now,recordId))
 statements.push(db.prepare('DELETE FROM hnd_source_pending WHERE source_id=? AND event_id=?').bind(source.id,event.eventId))
 try{await append(env,source.id,'source.receive',recordId,'completed',statements)}
 catch(error){if(/UNIQUE constraint failed: hnd_(source_cases|source_objects|source_receipts)/.test(String(error)))return ingest(env,source,event,bodyHash,parameters,receivedAt);throw error}
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
  let event=normalize(p)
  const source=await activeSource(env,event.account)
  knownSource=source??await env.DB.prepare('SELECT * FROM hnd_sources WHERE account_id=?').bind(event.account).first<Source>()
  if(!source)throw new Fault('invalid_source_proof',403)
  const alreadyRecorded=await env.DB.prepare('SELECT event_id FROM hnd_source_receipts WHERE source_id=? AND event_id=?').bind(source.id,event.eventId).first()
  if(!alreadyRecorded)event=await sourceTimestamp(env,event)
  // Persist only the documented fields needed to replay a verified dependent event.
  const allowed=['AccountSid','CallSid','ParentCallSid','CallStatus','CallDuration','SequenceNumber','Timestamp','From','To','MessageSid','MessageStatus','SmsStatus','Body','NumMedia','RecordingSid','RecordingStatus',...Array.from({length:10},(_,i)=>['MediaUrl'+i,'MediaContentType'+i]).flat()]
  const retained=new URLSearchParams([...p].filter(([key])=>allowed.includes(key))).toString(),bodyHash=await digest([...p].sort(([a],[b])=>a.localeCompare(b))),receivedAt=Date.now()
  const result=await ingest(env,source,event,bodyHash,retained,receivedAt)
  if(!result.held){
   const pending=(await env.DB.prepare('SELECT * FROM hnd_source_pending WHERE source_id=? AND parent_external_id=? ORDER BY received_at LIMIT 100').bind(source.id,event.externalId).all<{parameters:string;body_hash:string;received_at:number}>()).results
   for(const item of pending)await ingest(env,source,normalize(new URLSearchParams(item.parameters)),item.body_hash,item.parameters,item.received_at)
  }
  return json({...result,customerOutcome:'unconfirmed',externalEffectOccurred:false},result.held?202:200)
 }catch(error){
  if(error instanceof Fault){if(knownSource)await append(env,knownSource.id,'source.refuse','installation','refused');return json({error:error.code},error.status)}
  if(String(error).includes('CHECK constraint failed'))return json({error:'source_authority_changed'},409)
  console.error('Handset source event failed',error instanceof Error?error.name:'unknown')
  return json({error:'source_unavailable'},503)
 }
}
