import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { Fault, json, text, keys, id, page, escape as e, field, type ObjectValue } from '../core'

export interface Source {id:string;account_id:string;number_id:string;owner_id:string;owner_version:number;revision:number;revoked_at:number|null;created_at:number}
type ListedSource=Source & {status:'active'|'suspended'|'revoked';e164:string|null}
const current=`NOT EXISTS(SELECT 1 FROM hnd_sources newer WHERE newer.account_id=s.account_id AND newer.number_id=s.number_id AND newer.revision>s.revision)`
const numberCurrent=`n.kind='number' AND NOT EXISTS(SELECT 1 FROM hnd_records correction WHERE correction.supersedes_id=n.id)`
const authorized=`s.revoked_at IS NULL AND o.role='owner' AND o.status='active' AND o.version=s.owner_version AND ${numberCurrent}`
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
 if(path!==base && path!==base+'/revoke')return null
 if(request.method==='GET'&&path===base){
  const rows=(await env.DB.prepare(`SELECT s.*,json_extract(n.data,'$.e164') AS e164,CASE WHEN s.revoked_at IS NOT NULL THEN 'revoked' WHEN ${authorized} AND ${current} THEN 'active' ELSE 'suspended' END AS status FROM hnd_sources s LEFT JOIN oa_operators o ON o.id=s.owner_id LEFT JOIN hnd_records n ON n.id=s.number_id ORDER BY s.account_id,s.number_id,s.revision DESC`).all<ListedSource>()).results
  const pending=(await env.DB.prepare('SELECT source_id,event_id,parent_external_id,received_at FROM hnd_source_pending ORDER BY received_at').all()).results
  await commit(env,actor,'source.read','installation','completed')
  return html?page('Verified communication sources',`<p>Receive signed Twilio events for each selected business number. This grants no outbound or recording-capture authority. The installation owner supplies the Twilio authentication token through its private secret binding.</p><ul>${rows.map(r=>`<li>${e(r.account_id)} · ${r.status==='active'?'Active':r.status==='revoked'?'Revoked':'Suspended'}<p>Source ${e(r.id)} · Number ${e(r.e164??r.number_id)} · Revision ${e(r.revision)}</p>${r.status==='suspended'?'<p>The consenting owner’s authority or selected number revision changed. Fresh explicit owner consent is required for the current account and number record.</p>':''}${r.status!=='revoked'?`<form method="post" action="/app/sources/revoke"><input type="hidden" name="sourceId" value="${e(r.id)}"><button>Revoke source ${e(r.id)}</button></form>`:''}</li>`).join('')||'<li>No authorized sources.</li>'}</ul><form method="post">${field('Twilio account SID','accountId')}${field('Selected native business-number record ID','numberId')}<label><input type="checkbox" name="confirm" value="authorize signed inbound records" required>I authorize signed inbound communication records for this account and number</label><button>Authorize inbound records</button></form><h2>Unresolved source events</h2><ul>${pending.map(p=>`<li>${e(p.event_id)} · Waiting for parent ${e(p.parent_external_id)}</li>`).join('')||'<li>No unresolved events.</li>'}</ul>`):json({sources:rows,pending})
 }
 if(request.method!=='POST'||!value)throw new Fault('method_not_allowed',405)
 if(path===base+'/revoke'){
  keys(value,['sourceId']);const sourceId=text(value.sourceId,'sourceId')
  const source=await env.DB.prepare('SELECT * FROM hnd_sources WHERE id=?').bind(sourceId).first<Source>()
  if(!source)throw new Fault('source_not_found',404)
  await commit(env,actor,'source.revoke',sourceId,'completed',[env.DB.prepare('UPDATE hnd_sources SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(Date.now(),sourceId)],true,sourcePolicy(source))
  return html?page('Source revoked','<p>Further source events are refused. Completed communication evidence is retained.</p>'):json({revoked:true})
 }
 keys(value,['accountId','numberId','confirm'])
 if(value.confirm!=='authorize signed inbound records')throw new Fault('explicit_source_consent_required')
 if(!env.HANDSET_TWILIO_AUTH_TOKEN)throw new Fault('twilio_secret_binding_required',409)
 const numberId=text(value.numberId,'numberId'),accountId=text(value.accountId,'accountId'),sourceId=id()
 if(!await env.DB.prepare("SELECT n.id FROM hnd_records n WHERE n.id=? AND n.kind='number' AND NOT EXISTS(SELECT 1 FROM hnd_records correction WHERE correction.supersedes_id=n.id)").bind(numberId).first())throw new Fault('current_native_number_required',409)
 const latest=await env.DB.prepare('SELECT * FROM hnd_sources WHERE account_id=? AND number_id=? ORDER BY revision DESC LIMIT 1').bind(accountId,numberId).first<Source>()
 if(await activeSource(env,accountId,numberId))throw new Fault('source_already_registered',409)
 const revision=(latest?.revision??0)+1
 try{await commit(env,actor,'source.create',sourceId,'completed',[env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_records n WHERE n.id=? AND n.kind='number' AND NOT EXISTS(SELECT 1 FROM hnd_records correction WHERE correction.supersedes_id=n.id)").bind(numberId),env.DB.prepare('INSERT INTO hnd_sources(id,account_id,number_id,owner_id,owner_version,revision,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(sourceId,accountId,numberId,actor.operator.id,actor.operator.version,revision,null,Date.now())],true,sourcePolicy({id:sourceId,revision,owner_version:actor.operator.version}))}
 catch(error){if(String(error).includes('UNIQUE constraint'))throw new Fault('source_already_registered',409);throw error}
 return html?page('Source authorized',`<p>Signed callbacks may use /providers/twilio/events. No call or message has been sent.</p><a href="/app/sources">Review sources</a>`):json({id:sourceId,revision,callbackPath:'/providers/twilio/events'},201)
}
