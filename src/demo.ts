import type { Bindings } from './auth.server'

/** Existing native case samples; these are observations, never carrier receipts. */
export async function seedDemo(env: Bindings, { ownerEmail, now }: { ownerEmail: string; now: Date }) {
 const owner = await env.DB.prepare("SELECT id FROM oa_operators WHERE email=? AND role='owner' AND status='active'").bind(ownerEmail).first<{id:string}>()
 if (!owner) throw new Error('Demo owner is missing')
 const at = now.getTime(), due = at + 86400000
 const cases = [
  ['demo-austin-callback', 'Austin service callback / Devolución de llamada', 'Confirm the replacement appointment'],
  ['demo-delivery-question', 'Delivery appointment / Cita de entrega', 'Review the requested delivery window'],
 ]
 const statements = [env.DB.prepare('INSERT INTO oa_first_run(singleton,completed_by,completed_at) VALUES(1,?,?) ON CONFLICT DO NOTHING').bind(owner.id,at)]
 for (const [id,title,promise] of cases) statements.push(env.DB.prepare('INSERT INTO hnd_cases(id,title,owner_id,due_at,promise,status,handled,unread,version,actor_id,updated_at,close_reason) VALUES(?,?,?,?,?,\'open\',0,1,1,?,?,\'\') ON CONFLICT DO NOTHING').bind(id,title,owner.id,due,promise,owner.id,at))
 // Reuse the application's Austin case sample, retaining native/unverified provenance.
 const records: [string,string,Record<string,unknown>][] = [
  ['company','company',{name:'Austin Service Co.'}],
  ['location','location',{name:'Congress Avenue',timezone:'America/Chicago'}],
  ['person','person',{name:'Rosa García'}],
  ['conversation','conversation',{subject:'Replacement appointment'}],
  ['callback','callback',{state:'pending',dueAt:due}],
  ['comment','comment',{text:'Please follow up / Por favor confirma'}],
 ]
 for (const [id,kind,data] of records) statements.push(env.DB.prepare("INSERT INTO hnd_records(id,kind,source,source_id,occurred_at,received_at,case_id,data,actor_id) VALUES(?,?,'native',?,?,?,'demo-austin-callback',?,?) ON CONFLICT DO NOTHING").bind('demo-'+id,kind,'demo-'+id,at,at,JSON.stringify(data),owner.id))
 statements.push(env.DB.prepare("INSERT INTO hnd_filters(id,operator_id,name,query,created_at) VALUES('demo-open-cases',?,'Open cases / Casos abiertos',?,?) ON CONFLICT DO NOTHING").bind(owner.id,JSON.stringify({status:'open'}),at))
 await env.DB.batch(statements)
}
