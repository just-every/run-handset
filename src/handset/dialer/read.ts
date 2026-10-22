import { list, qualification, sql, type Context } from './storage'
import { observations } from './report'
import type { Qualification, QualificationDefinition, Recipient } from './model'
import { Fault } from '../core'
export async function snapshot(ctx:Context){
 const tables=['qualifications','policies','lists','recipients','checks','sessions','ready','reservations','attempts','events','extracts','state_rules','approver_scopes'] as const
 const result=await Promise.all(tables.map(name=>sql(ctx,'SELECT * FROM hnd_dialer_'+name+' ORDER BY rowid DESC LIMIT 300').all()))
 const rows=Object.fromEntries(tables.map((name,i)=>[name,result[i].results])) as Record<(typeof tables)[number],Record<string,unknown>[]>
 return {...rows,boundaries:{status:'PARTIAL',qualification:'Final provider/legal configuration and permitted real traffic require independent qualification. This console records explicit external evidence; it does not certify lawfulness.',launch:'Owner only. No automatic campaign starts or retries. Exact list audience is supplied by its owner.',waitingAgent:'Official readback must show an independently connected human agent alone in its approved conference. Native availability alone is insufficient.',capacity:'Inbound reserve is subtracted from current suitable staffed slots; uncertain paid effects retain their reservations.',disclosures:'The preconnected human agent must deliver the qualified disclosure. Safety messages have no marketing content.',scope:'Explicit US jurisdiction and caller timezone only; unknown consent, DNC, media and legal qualification are held.'}}
}
export async function report(ctx:Context,listId:string){const l=await list(ctx,listId),q=await qualification(ctx,l.qualification_id),policy=JSON.parse(q.definition) as QualificationDefinition;return {listId:l.id,snapshotHash:l.snapshot_hash,...await observations(ctx,l,policy),policy,budget:{reservedCents:l.reserved_cents,limitCents:JSON.parse(l.definition).budgetCents,basis:'approved worst-case reservation, not provider billing'}}}

export async function consoleSnapshot(ctx:Context,focusListId?:string) {
 const data=await snapshot(ctx),focus=focusListId??(data.lists[0]?.id as string|undefined)
 if(!focus)return {...data,focusListId:null}
 const selected=await list(ctx,focus)
 if(!data.lists.some(l=>l.id===focus))data.lists.push({...selected})
 const [recipients,checks]=await Promise.all([
  sql(ctx,'SELECT * FROM hnd_dialer_recipients WHERE list_id=? ORDER BY ordinal',focus).all<Recipient>(),
  sql(ctx,'SELECT * FROM hnd_dialer_checks WHERE list_id=? AND rowid IN (SELECT max(rowid) FROM hnd_dialer_checks WHERE list_id=? GROUP BY ordinal) ORDER BY ordinal',focus,focus).all(),
 ])
 return {...data,recipients:recipients.results,checks:checks.results,focusListId:focus}
}

export interface NativeOptions {
 sources:{id:string;account_id:string;e164:string}[];
 operators:{id:string;display_name:string}[];
 queues:{id:string;name:string}[];
 consents:{id:string;case_id:string;person_id:string;person_name:string;case_title:string;purpose:string;state:string}[];
 evidence:{id:string;kind:string;case_title:string|null;summary:string}[];
 agentRoutes:{operator_id:string;source_id:string;display_name:string}[];
 qualifications:Qualification[];
 policies:{id:string;definition:string;revision:number;expires_at:number}[];
}
// These owner-only selectors describe current native records. They neither
// supply consent nor infer external qualification from a record's presence.
export async function nativeOptions(ctx:Context):Promise<NativeOptions> {
 if(!ctx.actor||ctx.actor.operator.role!=='owner')throw new Fault('owner_required',403)
 const now=Date.now()
 const [sources,operators,queues,consents,evidence,agentRoutes,qualifications,policies]=await Promise.all([
  sql(ctx,`SELECT s.id,s.account_id,json_extract(n.data,'$.e164') AS e164 FROM hnd_sources s JOIN hnd_records n ON n.id=s.number_id JOIN oa_operators o ON o.id=s.owner_id WHERE s.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=s.owner_version ORDER BY e164,s.id`).all<NativeOptions['sources'][number]>(),
  sql(ctx,"SELECT id,display_name FROM oa_operators WHERE status='active' ORDER BY display_name,id").all<NativeOptions['operators'][number]>(),
  sql(ctx,'SELECT id,name FROM hnd_queues ORDER BY name,id').all<NativeOptions['queues'][number]>(),
  sql(ctx,`SELECT c.id,c.case_id,p.id AS person_id,json_extract(p.data,'$.name') AS person_name,k.title AS case_title,json_extract(c.data,'$.purpose') AS purpose,json_extract(c.data,'$.state') AS state FROM hnd_records c JOIN hnd_records p ON p.id=c.parent_id AND p.kind='person' AND p.case_id=c.case_id JOIN hnd_cases k ON k.id=c.case_id WHERE c.kind='consent' AND c.supersedes_id IS NULL AND NOT EXISTS(SELECT 1 FROM hnd_records n WHERE n.supersedes_id=c.id OR n.supersedes_id=p.id) ORDER BY k.title,person_name,c.id`).all<NativeOptions['consents'][number]>(),
  sql(ctx,`SELECT r.id,r.kind,k.title AS case_title,substr(COALESCE(json_extract(r.data,'$.purpose'),json_extract(r.data,'$.text'),''),1,160) AS summary FROM hnd_records r LEFT JOIN hnd_cases k ON k.id=r.case_id WHERE r.kind IN ('comment','consent') AND r.supersedes_id IS NULL AND NOT EXISTS(SELECT 1 FROM hnd_records n WHERE n.supersedes_id=r.id) ORDER BY r.received_at DESC,r.id`).all<NativeOptions['evidence'][number]>(),
  sql(ctx,`SELECT r.operator_id,r.source_id,a.display_name FROM hnd_queue_agent_routes r JOIN oa_operators a ON a.id=r.operator_id JOIN oa_operators o ON o.id=r.approved_by WHERE r.revoked_at IS NULL AND a.status='active' AND o.status='active' AND o.role='owner' ORDER BY a.display_name,r.operator_id`).all<NativeOptions['agentRoutes'][number]>(),
  sql(ctx,`SELECT q.* FROM hnd_dialer_qualifications q JOIN oa_operators o ON o.id=q.approved_by JOIN hnd_sources s ON s.id=q.source_id JOIN oa_operators so ON so.id=s.owner_id WHERE q.revoked_at IS NULL AND q.expires_at>? AND o.status='active' AND o.role='owner' AND o.version=q.owner_version AND s.revoked_at IS NULL AND so.status='active' AND so.role='owner' AND so.version=s.owner_version ORDER BY q.created_at DESC`,now).all<Qualification>(),
  sql(ctx,`SELECT p.id,p.definition,p.revision,p.expires_at FROM hnd_dialer_policies p JOIN oa_operators o ON o.id=p.approved_by WHERE p.revoked_at IS NULL AND p.expires_at>? AND o.status='active' AND (o.role='owner' OR EXISTS(SELECT 1 FROM hnd_dialer_approver_scopes a WHERE a.operator_id=p.approved_by AND a.standing=1 AND a.revoked_at IS NULL AND a.review_at>strftime('%s','now')*1000)) AND o.version=p.owner_version ORDER BY p.created_at DESC`,now).all<NativeOptions['policies'][number]>(),
 ])
 return {sources:sources.results,operators:operators.results,queues:queues.results,consents:consents.results,evidence:evidence.results,agentRoutes:agentRoutes.results,qualifications:qualifications.results,policies:policies.results}
}
