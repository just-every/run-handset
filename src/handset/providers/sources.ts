import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { allowedNumbers, authorizeNumber, createNumberAccess, listNumberAccess, numberAccessForm, revokeNumberAccess, sourceConsentClause } from '../access/numbers'
import { Fault, json, text, keys, id, consolePage as page, escape as e, field, session, type ObjectValue } from '../core'

// Historical owner_* columns retain the exact consenting native person/version.
export interface Source {id:string;account_id:string;number_id:string;owner_id:string;owner_version:number;revision:number;revoked_at:number|null;created_at:number;consent_access_id?:string|null}
type ListedSource=Source & {status:'active'|'suspended'|'revoked';e164:string|null}
const current=`NOT EXISTS(SELECT 1 FROM hnd_sources newer WHERE newer.account_id=s.account_id AND newer.number_id=s.number_id AND newer.revision>s.revision)`
const numberCurrent=`n.kind='number' AND NOT EXISTS(SELECT 1 FROM hnd_records correction WHERE correction.supersedes_id=n.id)`
const authorized=`s.revoked_at IS NULL AND o.status='active' AND o.version=s.owner_version AND ${sourceConsentClause()} AND ${numberCurrent}`
export const sourceFence=(env:Bindings,s:Pick<Source,'id'|'revision'>)=>env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id JOIN hnd_records n ON n.id=s.number_id WHERE s.id=? AND s.revision=? AND ${authorized} AND ${current}`).bind(s.id,s.revision)
export async function activeSources(env:Bindings,account:string){
 return (await env.DB.prepare(`SELECT s.*,json_extract(n.data,'$.e164') AS e164 FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id JOIN hnd_records n ON n.id=s.number_id WHERE s.account_id=? AND ${authorized} AND ${current}`).bind(account).all<Source & {e164:string}>()).results
}
export async function activeSource(env:Bindings,account:string,numberId:string){return (await activeSources(env,account)).find(s=>s.number_id===numberId)??null}
export async function activeSourceById(env:Bindings,sourceId:string){
 return env.DB.prepare(`SELECT s.*,json_extract(n.data,'$.e164') AS e164 FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id JOIN hnd_records n ON n.id=s.number_id WHERE s.id=? AND ${authorized} AND ${current}`).bind(sourceId).first<Source&{e164:string}>()
}

export async function sourceDoor(request:Request,env:Bindings,actor:Session,value?:ObjectValue):Promise<Response|null>{
 const path=new URL(request.url).pathname,html=path.startsWith('/app/'),base=html?'/app/sources':'/api/handset/sources'
 if(![base,base+'/revoke',base+'/access',base+'/revoke-access'].includes(path))return null
 const checked=await session(request,env)
 if(checked.session.id!==actor.id)throw new Fault('session_mismatch',403)
 env=checked.env;actor=checked.session
 if(path===base+'/access'&&request.method==='GET')return json(await listNumberAccess(env,actor))
 if([base+'/access',base+'/revoke-access'].includes(path)){
  if(request.method!=='POST'||!value)throw new Fault('method_not_allowed',405)
  const v={...value}
  if(html&&path===base+'/access'){
   const choice=text(v.personChoice,'personChoice').split(':');if(choice.length!==2)throw new Fault('invalid_personChoice')
   delete v.personChoice;v.personId=choice[0];v.personVersion=Number(choice[1]);v.expiresAt=Date.parse(String(v.expiresAt)+'Z')
  }
  const granted=path===base+'/access',result=granted?await createNumberAccess(env,actor,v):await revokeNumberAccess(env,actor,v)
  return html?page(granted?'Number work granted':'Number work revoked','<p>Exact-number case work and inbound source authority updated. No call, capture or message was sent.</p><a href="/app/sources">Review sources</a>'):json(result,granted?201:200)
 }
 if(request.method==='GET'&&path===base){
  const numbers=actor.operator.role==='owner'?null:await allowedNumbers(env,actor)
  if(numbers&&!numbers.length)throw new Fault('number_access_required',403)
  const scope=numbers?JSON.stringify(numbers):null
  const rows=(await env.DB.prepare(`SELECT s.*,json_extract(n.data,'$.e164') AS e164,CASE WHEN s.revoked_at IS NOT NULL THEN 'revoked' WHEN ${authorized} AND ${current} THEN 'active' ELSE 'suspended' END AS status FROM hnd_sources s LEFT JOIN oa_operators o ON o.id=s.owner_id LEFT JOIN hnd_records n ON n.id=s.number_id WHERE (? IS NULL OR s.number_id IN (SELECT value FROM json_each(?))) ORDER BY s.account_id,s.number_id,s.revision DESC`).bind(scope,scope).all<ListedSource>()).results
  const pending=(await env.DB.prepare('SELECT source_id,event_id,parent_external_id,received_at FROM hnd_source_pending WHERE (? IS NULL OR source_id IN (SELECT id FROM hnd_sources WHERE number_id IN (SELECT value FROM json_each(?)))) ORDER BY received_at').bind(scope,scope).all()).results
  const administration=html?await numberAccessForm(env,actor):''
  const response=html?await page('Verified communication sources',`<p>Receive signed Twilio events for each selected business number. This grants no outbound or recording-capture authority. The installation owner supplies the Twilio authentication token through its private secret binding.</p><ul>${rows.map(r=>`<li>${e(r.account_id)} · ${r.status==='active'?'Active':r.status==='revoked'?'Revoked':'Suspended'}<p>Source ${e(r.id)} · Number ${e(r.e164??r.number_id)} · Revision ${e(r.revision)}</p>${r.status==='suspended'?'<p>The consenting person, their number scope or the selected number revision changed. Fresh explicit consent is required after current number authority is restored.</p>':''}${r.status!=='revoked'?`<form method="post" action="/app/sources/revoke"><input type="hidden" name="sourceId" value="${e(r.id)}"><button>Revoke source ${e(r.id)}</button></form>`:''}</li>`).join('')||'<li>No authorized sources.</li>'}</ul><form method="post">${field('Twilio account SID','accountId')}${field('Selected native business-number record ID','numberId')}<label><input type="checkbox" name="confirm" value="authorize signed inbound records" required>I authorize signed inbound communication records for this account and number</label><button>Authorize inbound records</button></form><h2>Unresolved source events</h2><ul>${pending.map(p=>`<li>${e(p.event_id)} · Waiting for parent ${e(p.parent_external_id)}</li>`).join('')||'<li>No unresolved events.</li>'}</ul>${administration}`):json({sources:rows,pending})
  if(numbers){
   const permissions=await Promise.all(numbers.map(number=>authorizeNumber(env,actor,number)))
   await commit(env,actor,'source.read','installation','completed',permissions.flatMap(p=>p.fences),false,{scopes:permissions.flatMap(p=>p.applied.access?[p.applied.access]:[])})
  }else await commit(env,actor,'source.read','installation','completed')
  return response
 }
 if(request.method!=='POST'||!value)throw new Fault('method_not_allowed',405)
 if(path===base+'/revoke'){
  keys(value,['sourceId']);const sourceId=text(value.sourceId,'sourceId')
  const source=await env.DB.prepare('SELECT * FROM hnd_sources WHERE id=?').bind(sourceId).first<Source>()
  if(!source)throw new Fault(actor.operator.role==='owner'?'source_not_found':'number_access_required',actor.operator.role==='owner'?404:403)
  const authority=await authorizeNumber(env,actor,source.number_id)
  await commit(env,actor,'source.revoke',sourceId,'completed',[...authority.fences,env.DB.prepare('UPDATE hnd_sources SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(Date.now(),sourceId)],false,{...sourcePolicy(source),...authority.applied})
  return html?page('Source revoked','<p>Further source events are refused. Completed communication evidence is retained.</p><a href="/app/sources">Review sources</a>'):json({revoked:true})
 }
 keys(value,['accountId','numberId','confirm'])
 if(value.confirm!=='authorize signed inbound records')throw new Fault('explicit_source_consent_required')
 if(!env.HANDSET_TWILIO_AUTH_TOKEN)throw new Fault('twilio_secret_binding_required',409)
 const numberId=text(value.numberId,'numberId'),accountId=text(value.accountId,'accountId'),sourceId=id()
 const authority=await authorizeNumber(env,actor,numberId)
 if(!await env.DB.prepare("SELECT n.id FROM hnd_records n WHERE n.id=? AND n.kind='number' AND NOT EXISTS(SELECT 1 FROM hnd_records correction WHERE correction.supersedes_id=n.id)").bind(numberId).first())throw new Fault('current_native_number_required',409)
 const latest=await env.DB.prepare('SELECT * FROM hnd_sources WHERE account_id=? AND number_id=? ORDER BY revision DESC LIMIT 1').bind(accountId,numberId).first<Source>()
 if(await activeSource(env,accountId,numberId))throw new Fault('source_already_registered',409)
 const revision=(latest?.revision??0)+1
 try{await commit(env,actor,'source.create',sourceId,'completed',[...authority.fences,env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_records n WHERE n.id=? AND n.kind='number' AND NOT EXISTS(SELECT 1 FROM hnd_records correction WHERE correction.supersedes_id=n.id)").bind(numberId),env.DB.prepare('INSERT INTO hnd_sources(id,account_id,number_id,owner_id,owner_version,revision,revoked_at,created_at,consent_access_id) VALUES (?,?,?,?,?,?,?,?,?)').bind(sourceId,accountId,numberId,actor.operator.id,actor.operator.version,revision,null,Date.now(),authority.grant?.id??null)],false,{...sourcePolicy({id:sourceId,revision,owner_version:actor.operator.version,consent_access_id:authority.grant?.id??null}),...authority.applied})}
 catch(error){if(String(error).includes('number_release_protected'))throw new Fault('number_release_protected',409);if(String(error).includes('UNIQUE constraint'))throw new Fault('source_already_registered',409);throw error}
 return html?page('Source authorized',`<p>Signed callbacks may use /providers/twilio/events. No call or message has been sent.</p><a href="/app/sources">Review sources</a>`):json({id:sourceId,revision,callbackPath:'/providers/twilio/events'},201)
}
