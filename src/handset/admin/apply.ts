import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { adminCommit as commit } from './access'
import { Fault, digest, integer, keys, text, type ObjectValue } from '../core'
import type { PlanRow, PlanSnapshot } from './model'
import { catalog, getPlan, nativeFence, planResult, templateFences } from './store'
import { targetFences } from './access'

function profileFence(db:D1Database,row:PlanRow) {
 const p=row.before
 return p?db.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_admin_profiles WHERE id=? AND version=? AND config=? AND overrides=?').bind(p.id,p.version,p.config,p.overrides):db.prepare('INSERT INTO hnd_guard(ok) SELECT CASE WHEN count(*)=0 THEN 1 ELSE 0 END FROM hnd_admin_profiles WHERE id=? OR (kind=? AND identity=?) OR extension=?').bind(row.id,row.kind,row.kind==='user'?row.after.email:row.after.mac,row.after.extension)
}
export async function approvePlan(env:Bindings,actor:Session,planId:string,value:ObjectValue) {
 keys(value,['planHash','confirm'])
 const plan=await getPlan(env.DB,planId),hash=text(value.planHash,'planHash')
 if(hash!==plan.hash)throw new Fault('plan_hash_changed',409)
 if(value.confirm!=='approve exact local configuration')throw new Fault('exact_approval_required')
 if(plan.status!=='preview')return {...planResult(plan),replay:true}
 const snapshot=JSON.parse(plan.snapshot) as PlanSnapshot
 if(snapshot.errors.length)throw new Fault('plan_has_errors',409,snapshot.errors)
 if(Date.now()>=plan.expires_at)throw new Fault('plan_expired',409)
 if(await digest(await catalog(env.DB))!==snapshot.catalogHash)throw new Fault('plan_stale',409)
 await commit(env,actor,'admin.approve',plan.id,'completed',[
  env.DB.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_admin_plans WHERE id=? AND status='preview' AND hash=? AND expires_at>?").bind(plan.id,hash,Date.now()),
  ...templateFences(env.DB,snapshot),...snapshot.rows.flatMap(row=>[profileFence(env.DB,row),...nativeFence(env.DB,row),...targetFences(env.DB,actor,row.authorityTargets)]),
  env.DB.prepare("UPDATE hnd_admin_plans SET status='approved',approved_by=?,approved_version=?,approved_role=?,approved_at=? WHERE id=?").bind(actor.operator.id,actor.operator.version,actor.operator.role,Date.now(),plan.id),
 ])
 return planResult(await getPlan(env.DB,plan.id))
}

// Each row and its cursor receipt commit in one transaction. A disconnected
// browser resumes at the stored cursor, without replaying an admitted row.
export async function applyPlan(env:Bindings,actor:Session,planId:string,value:ObjectValue) {
 keys(value,['planHash','limit'])
 const expected=text(value.planHash,'planHash'),limit=integer(value.limit??20,'limit',1,25)
 let plan=await getPlan(env.DB,planId)
 if(expected!==plan.hash)throw new Fault('plan_hash_changed',409)
 if(plan.status==='completed')return {...planResult(plan),replay:true}
 if(!['approved','applying'].includes(plan.status))throw new Fault('plan_not_approved',409)
 const snapshot=JSON.parse(plan.snapshot) as PlanSnapshot
 for(let count=0;count<limit&&plan.cursor<snapshot.rows.length;count++){
  if(Date.now()>=plan.expires_at)throw new Fault('plan_expired',409,{planId:plan.id,cursor:plan.cursor})
  const row=snapshot.rows[plan.cursor],db=env.DB,now=Date.now()
  const statements=[
   db.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_admin_plans WHERE id=? AND hash=? AND cursor=? AND status IN ('approved','applying') AND expires_at>?").bind(plan.id,expected,plan.cursor,now),
   db.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND role=? AND role IN ('owner','admin') AND status='active'").bind(plan.approved_by,plan.approved_version,plan.approved_role),
   ...templateFences(db,snapshot),profileFence(db,row),...nativeFence(db,row),...targetFences(db,actor,row.authorityTargets),
  ]
  if(row.after.numberId)statements.push(db.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_records r WHERE id=? AND kind='number' AND NOT EXISTS(SELECT 1 FROM hnd_records n WHERE n.supersedes_id=r.id)").bind(row.after.numberId))
  let parentId:string|null=null
  if(row.kind==='device'&&row.after.userEmail){
   const user=await db.prepare("SELECT record_id FROM hnd_admin_profiles WHERE kind='user' AND identity=?").bind(row.after.userEmail).first<{record_id:string}>()
   if(!user)throw new Fault('assigned_user_changed',409)
   parentId=user.record_id
   statements.push(db.prepare("INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_admin_profiles WHERE kind='user' AND identity=? AND record_id=?").bind(row.after.userEmail,parentId))
  }
  // A pending native account has no token or session. Only the separate native
  // invitation door may issue its admission credential and send its invitation.
  if(!row.before&&row.kind==='user'&&!row.nativeBefore)statements.push(db.prepare("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES (?,?,?,'member','invited',?)").bind(row.operatorId,row.after.email,row.after.name,now))
  if(!row.before||row.before.record_id!==row.recordId)statements.push(db.prepare("INSERT INTO hnd_records(id,kind,source,source_id,occurred_at,received_at,case_id,parent_id,supersedes_id,data,actor_id) VALUES (?,?,'native',?,?,?,NULL,?,?,?,?)").bind(row.recordId,row.kind==='user'?'person':'endpoint','bulk:'+row.id+':'+((row.before?.version??0)+1),now,now,parentId,row.before?.record_id??null,JSON.stringify(row.kind==='user'?{name:row.after.name}:{name:row.after.name,platform:'desk'}),actor.operator.id))
  if(!row.before){
   statements.push(db.prepare('INSERT INTO hnd_admin_profiles(id,kind,operator_id,record_id,identity,extension,config,overrides,template_id,template_version,version,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)').bind(row.id,row.kind,row.operatorId,row.recordId,row.kind==='user'?row.after.email:row.after.mac,row.after.extension,JSON.stringify(row.after),JSON.stringify(row.overrides),row.templateId,row.templateVersion,now))
  }else statements.push(db.prepare('UPDATE hnd_admin_profiles SET record_id=?,extension=?,config=?,overrides=?,template_id=?,template_version=?,version=version+1,updated_at=? WHERE id=?').bind(row.recordId,row.after.extension,JSON.stringify(row.after),JSON.stringify(row.overrides),row.templateId,row.templateVersion,now,row.id))
  if(row.kind==='user'&&row.nativeBefore&&row.after.name!==row.nativeBefore.display_name)statements.push(db.prepare('UPDATE oa_operators SET display_name=? WHERE id=?').bind(row.after.name,row.operatorId))
  statements.push(
   db.prepare('INSERT INTO hnd_admin_applied_rows VALUES (?,?,?,?)').bind(plan.id,plan.cursor,row.id,now),
   db.prepare('UPDATE hnd_admin_plans SET cursor=cursor+1,status=? WHERE id=?').bind(plan.cursor+1===snapshot.rows.length?'completed':'applying',plan.id),
  )
  try{await commit(env,actor,'admin.apply',plan.id,'completed',statements)}catch(error){
   if(/UNIQUE constraint failed/.test(String(error)))throw new Fault('plan_conflict',409,{planId:plan.id,cursor:plan.cursor})
   throw error
  }
  plan=await getPlan(db,plan.id)
 }
 return {...planResult(plan),replay:false}
}
