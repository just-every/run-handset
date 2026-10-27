import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { escape as e, Fault, field, hidden, integer, keys, object, owner, text } from '../core'

export interface ReportGroup {
 number:string; team:string; location:string; revision:number; updatedAt:number; updatedBy:string
}
interface GroupRow { number:string; team:string; location:string; revision:number; updated_at:number; actor_id:string }
const group=(row:GroupRow):ReportGroup=>({number:row.number,team:row.team,location:row.location,revision:row.revision,updatedAt:row.updated_at,updatedBy:row.actor_id})

export async function listGroups(db:D1Database):Promise<ReportGroup[]> {
 const rows=await db.prepare(`SELECT g.* FROM hnd_report_groups g WHERE g.revision=(SELECT max(n.revision) FROM hnd_report_groups n WHERE n.number=g.number) ORDER BY g.number`).all<GroupRow>()
 return rows.results.map(group)
}

export async function saveGroup(env:Bindings,actor:Session,raw:unknown):Promise<ReportGroup> {
 owner(actor)
 const value=object(raw);keys(value,['number','team','location','revision'])
 const number=text(value.number,'number',16),team=text(value.team,'team'),location=text(value.location,'location'),revision=integer(value.revision,'revision')
 if(!/^\+[1-9]\d{7,14}$/.test(number))throw new Fault('invalid_number')
 const db=env.DB,current=await db.prepare('SELECT max(revision) AS revision FROM hnd_report_groups WHERE number=?').bind(number).first<{revision:number|null}>()
 if((current?.revision??0)!==revision)throw new Fault('report_group_changed',409)
 const result:ReportGroup={number,team,location,revision:revision+1,updatedAt:Date.now(),updatedBy:actor.operator.id}
 try{
  await commit(env,actor,'metrics.configure','installation','completed',[
   db.prepare('INSERT INTO hnd_guard(ok) SELECT CASE WHEN COALESCE(max(revision),0)=? THEN 1 ELSE 0 END FROM hnd_report_groups WHERE number=?').bind(revision,number),
   db.prepare('INSERT INTO hnd_report_groups(number,revision,team,location,actor_id,updated_at) VALUES (?,?,?,?,?,?)').bind(number,result.revision,team,location,result.updatedBy,result.updatedAt),
  ])
 }catch(error){
  if(String(error).includes('UNIQUE constraint failed: hnd_report_groups'))throw new Fault('report_group_changed',409)
  throw error
 }
 return result
}

export function groupConflictForm(draft:{number:string;team:string;location:string;revision:number},current?:ReportGroup):string {
 return `<h2>${e(draft.number)}</h2><form method="post" action="/app/reports/queues/groups">${hidden('number',draft.number)}${hidden('revision',draft.revision)}${field('Reporting team','team',draft.team)}${field('Reporting location','location',draft.location)}<details open><summary>Compare current assignment</summary><p>Your submitted values are kept above. Review the current assignment before replacing it.</p><dl><dt>Reporting team</dt><dd>${e(current?.team??'Unassigned')}</dd><dt>Reporting location</dt><dd>${e(current?.location??'Unassigned')}</dd><dt>Assignment revision</dt><dd>${current?.revision??0}</dd></dl><button name="revision" value="${current?.revision??0}">Save reviewed assignment</button></details></form><p><a href="/app/reports/queues/groups">Reload assignments</a></p>`
}

export function groupsForm(groups:ReportGroup[]=[]):string {
 const form=(current?:ReportGroup)=>`<form method="post" action="/app/reports/queues/groups">${current?hidden('number',current.number):field('Business number (E.164)','number')}${hidden('revision',current?.revision??0)}${field('Reporting team','team',current?.team??'Unassigned')}${field('Reporting location','location',current?.location??'Unassigned')}<button>${current?'Save assignment version':'Assign business number'}</button></form>`
 return `<p>Owners assign business numbers to reporting teams and locations. These labels do not change staff membership. Calls use the current assignment when a report is captured; retained snapshots keep their captured labels. Numbers without an assignment use Unassigned. Save Unassigned to clear either label.</p>${groups.map(current=>`<h3>${e(current.number)} · assignment ${current.revision}</h3>${form(current)}`).join('')}${form()}`
}
