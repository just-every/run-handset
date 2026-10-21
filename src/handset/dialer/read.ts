import { list, qualification, sql, type Context } from './storage'
import { observations } from './report'
import type { QualificationDefinition } from './model'
export async function snapshot(ctx:Context){
 const tables=['qualifications','policies','lists','recipients','checks','sessions','ready','reservations','attempts','events']
 const result=await Promise.all(tables.map(name=>sql(ctx,'SELECT * FROM hnd_dialer_'+name+' ORDER BY rowid DESC LIMIT 300').all()))
 const rows=Object.fromEntries(tables.map((name,i)=>[name,result[i].results]))
 return {...rows,boundaries:{status:'PARTIAL',qualification:'Final provider/legal configuration and permitted real traffic require independent qualification. This console records explicit external evidence; it does not certify lawfulness.',launch:'Owner only. No automatic campaign starts or retries. Exact list audience is supplied by its owner.',waitingAgent:'Official readback must show an independently connected human agent alone in its approved conference. Native availability alone is insufficient.',capacity:'Inbound reserve is subtracted from current suitable staffed slots; uncertain paid effects retain their reservations.',disclosures:'The preconnected human agent must deliver the qualified disclosure. Safety messages have no marketing content.',scope:'Explicit US jurisdiction and caller timezone only; unknown consent, DNC, media and legal qualification are held.'}}
}
export async function report(ctx:Context,listId:string){const l=await list(ctx,listId),q=await qualification(ctx,l.qualification_id),policy=JSON.parse(q.definition) as QualificationDefinition;return {listId:l.id,snapshotHash:l.snapshot_hash,...await observations(ctx,l,policy),policy,budget:{reservedCents:l.reserved_cents,limitCents:JSON.parse(l.definition).budgetCents,basis:'approved worst-case reservation, not provider billing'}}}
