import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { actorRef, commit } from '../audit/store'
import { choice, Fault, input, json, keys, owner, ownerFence, text, type ObjectValue } from '../core'
import { admitProtection } from './admission'
import { protectionPage, type Overview } from './pages'
import { addRule, addStop, alertAction, configure, designateCallback, revokeRule } from './store'
export { admitProtection } from './admission'
export { protectionCarrierResponse } from './twilio'
export async function overview(env:Bindings):Promise<Overview>{
 const db=env.DB
 const results=await Promise.all([
  db.prepare('SELECT * FROM hnd_protection_rules WHERE revoked_at IS NULL ORDER BY created_at,id').all(),
  db.prepare('SELECT * FROM hnd_protection_routes ORDER BY source_id').all(),
  db.prepare(`SELECT a.*,p.principal,p.address,p.attempted_cents,
   (SELECT sum(x.attempted_cents) FROM hnd_protection_attempts x WHERE x.number_id=a.number_id AND x.device_id=a.device_id AND x.channel=a.channel AND x.direction!='inbound') AS total_attempted_cents
   FROM hnd_protection_alerts a JOIN hnd_protection_attempts p ON p.id=a.attempt_id ORDER BY a.created_at DESC LIMIT 100`).all(),
  db.prepare('SELECT * FROM hnd_protection_attempts ORDER BY occurred_at DESC,id LIMIT 100').all(),
  db.prepare('SELECT id,number_id FROM hnd_sources WHERE revoked_at IS NULL ORDER BY id').all(),
  db.prepare("SELECT id,json_extract(data,'$.e164') AS e164 FROM hnd_records WHERE kind='number' ORDER BY id").all(),
  db.prepare("SELECT id,display_name FROM oa_operators WHERE status='active' ORDER BY display_name,id").all(),
  db.prepare('SELECT * FROM hnd_protection_callbacks WHERE expires_at>? ORDER BY expires_at').bind(Date.now()).all(),
  db.prepare('SELECT * FROM hnd_protection_stops ORDER BY created_at DESC LIMIT 100').all(),
  db.prepare('SELECT id,source_id,number_id,caller,call_sid,rule_id,status,attempts,round,last_outcome,expires_at,continued_at,continued_route_revision FROM hnd_protection_challenges ORDER BY created_at DESC LIMIT 100').all(),
 ])
 return Object.fromEntries(['rules','routes','alerts','attempts','sources','numbers','people','callbacks','stops','challenges'].map((name,n)=>[name,results[n].results])) as unknown as Overview
}
export async function protectionDoor(request:Request,env:Bindings,actor:Session,data?:ObjectValue):Promise<Response|null>{
 const path=new URL(request.url).pathname,html=path.startsWith('/app/'),base=html?'/app/protection':'/api/handset/protection'
 if(path!==base&&!path.startsWith(base+'/'))return null
 owner(actor)
 if(request.method==='GET'&&path===base){await commit(env,actor,'protection.read','installation','completed');const value=await overview(env);return html?protectionPage(value):json({...value,boundaries:{outbound:'held_adapter_unqualified',fax:'native policy admission only; carrier reception is not blocked',emergency:'direct 911 and designated callbacks bypass restrictions'}})}
 if(request.method!=='POST')throw new Fault('method_not_allowed',405)
 const v=data??await input(request)
 if(html){for(const name of ['revision','maxAttempts','windowSeconds','attemptCents'])if(typeof v[name]==='string')v[name]=Number(v[name]);if(typeof v.expiresAt==='string')v.expiresAt=new Date(v.expiresAt+'Z').getTime()}
 let result:unknown,status=200
 if(path===base+'/rules'){result=await addRule(env,actor,v);status=201}
 else if(path===base+'/revoke')result=await revokeRule(env,actor,v)
 else if(path===base+'/configure')result=await configure(env,actor,v)
 else if(path===base+'/callbacks'){result=await designateCallback(env,actor,v);status=201}
 else if(path===base+'/stops'){result=await addStop(env,actor,v);status=201}
 else if(path===base+'/acknowledge')result=await alertAction(env,actor,v)
 else if(path===base+'/release')result=await alertAction(env,actor,v,true)
 else if(path===base+'/check'){
  keys(v,['numberId','deviceId','eventKey','channel','direction','address','personalId'])
  result=await admitProtection(env,{principal:await actorRef(env.DB,actor.operator.id),numberId:text(v.numberId,'numberId'),deviceId:text(v.deviceId,'deviceId'),eventKey:text(v.eventKey,'eventKey'),channel:choice(v.channel,['voice','fax','sms','sip'],'channel'),direction:choice(v.direction,['inbound','outbound','registration'],'direction'),address:text(v.address,'address'),...(v.personalId?{personalId:text(v.personalId,'personalId')}:{}),authorized:false,consent:false,fences:[ownerFence(env.DB,actor)]})
 }else throw new Fault('not_found',404)
 return html?protectionPage(await overview(env),'Saved. '+(result&&typeof result==='object'&&'decision' in result?String(result.decision)+' · '+String('reason' in result?result.reason:''):'Review the current policy and evidence below.')):json(result,status)
}
