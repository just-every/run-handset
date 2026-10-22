import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { adminCommit as commit } from './access'
import { Fault, digest, id } from '../core'
import type { Plan, PlanSnapshot, Profile, Template } from './model'

export async function catalog(db:D1Database) {
 const [profiles,operators,numbers]=await Promise.all([
  db.prepare('SELECT * FROM hnd_admin_profiles ORDER BY id').all<Profile>(),
  db.prepare('SELECT id,version,status,role,email,display_name FROM oa_operators ORDER BY id').all<{id:string;version:number;status:string;role:string;email:string;display_name:string}>(),
  db.prepare("SELECT id FROM hnd_records r WHERE kind='number' AND NOT EXISTS(SELECT 1 FROM hnd_records n WHERE n.supersedes_id=r.id) ORDER BY id").all<{id:string}>(),
 ])
 return {profiles:profiles.results,operators:operators.results,numbers:numbers.results}
}
export async function getPlan(db:D1Database,planId:string) {
 const plan=await db.prepare('SELECT * FROM hnd_admin_plans WHERE id=?').bind(planId).first<Plan>()
 if(!plan)throw new Fault('plan_not_found',404)
 return plan
}
export const planResult=(plan:Plan)=>({...plan,snapshot:JSON.parse(plan.snapshot) as PlanSnapshot,effectOccurred:false,charges:0})
export async function savePlan(env:Bindings,actor:Session,kind:'csv'|'template',snapshot:PlanSnapshot) {
 const planId=id(),hash=await digest(snapshot),now=Date.now()
 await commit(env,actor,'admin.preview',planId,'completed',[
  env.DB.prepare("INSERT INTO hnd_admin_plans(id,kind,snapshot,hash,status,created_by,created_at,expires_at) VALUES (?,?,?,?,'preview',?,?,?)").bind(planId,kind,JSON.stringify(snapshot),hash,actor.operator.id,now,now+3600000),
 ])
 return planResult(await getPlan(env.DB,planId))
}
export async function getProfile(db:D1Database,profileId:string) {
 const profile=await db.prepare('SELECT * FROM hnd_admin_profiles WHERE id=?').bind(profileId).first<Profile>()
 if(!profile)throw new Fault('profile_not_found',404)
 return profile
}
export async function getTemplate(db:D1Database,templateId:string) {
 const template=await db.prepare('SELECT * FROM hnd_admin_templates WHERE id=?').bind(templateId).first<Template>()
 if(!template)throw new Fault('template_not_found',404)
 return template
}
export function templateFences(db:D1Database,snapshot:PlanSnapshot) {
 return snapshot.templates.map(t=>db.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_admin_templates WHERE id=? AND version=?').bind(t.id,t.version))
}
export function nativeFence(db:D1Database,row:PlanSnapshot['rows'][number]) {
 const n=row.nativeBefore
 return n?[db.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM oa_operators WHERE id=? AND version=? AND status=? AND role=? AND email=? AND display_name=?').bind(n.id,n.version,n.status,n.role,n.email,n.display_name)]:[]
}
export const emptyCost=()=>({currency:'USD' as const,localConfigurationCents:0,providerCost:'unavailable' as const,chargesAuthorized:false as const})
export const heldEffects=['Employee invitations require the native invitation door and separate authority.','Carrier purchases, charges, emergency activation and device registration are held pending qualified provider authority.','Number assignments, queues, hours, ring rules, keys and greetings are saved configuration; live routing and active calls are unchanged.']
