import { choice, digest, Fault, id, integer, keys, object, owner, text, timestamp, type ObjectValue } from '../core'
import { evidence, guard, sql, write, type Context } from './storage'
import { expiry, modeList, phone, type RecipientDefinition } from './model'

export async function importExtract(ctx:Context,v:ObjectValue){
 owner(ctx.actor!)
 keys(v,['kind','jurisdiction','publishedAt','expiresAt','sourceReference','evidenceId','rows','confirm'])
 if(v.confirm!=='import licensed compliance results')throw new Fault('licensed_extract_consent_required',403)
 const kind=choice(v.kind,['national','state','reassigned'],'kind'),jurisdiction=text(v.jurisdiction,'jurisdiction'),publishedAt=timestamp(v.publishedAt,'publishedAt'),expiresAt=expiry(v.expiresAt,31*86400000),evidenceId=text(v.evidenceId,'evidenceId')
 if(kind==='state'?!/^US-[A-Z]{2}$/.test(jurisdiction):jurisdiction!=='US')throw new Fault('invalid_extract_jurisdiction')
 if(publishedAt>Date.now()||expiresAt<=publishedAt)throw new Fault('invalid_extract_dates')
 if(!Array.isArray(v.rows)||!v.rows.length||v.rows.length>10000)throw new Fault('invalid_extract_rows')
 const rows=v.rows.map(value=>{const r=object(value);keys(r,['recipient','status','consentId']);const consentId=kind==='reassigned'?text(r.consentId,'consentId'):'';if(kind!=='reassigned'&&r.consentId)throw new Fault('unexpected_consent_id');return {recipient:phone(r.recipient),status:choice(r.status,['clear','blocked','reassigned','unknown'],'status'),consentId}})
 if(new Set(rows.map(r=>r.recipient+':'+r.consentId)).size!==rows.length)throw new Fault('duplicate_extract_row')
 const target=id(),hash=await digest({kind,jurisdiction,publishedAt,rows}),sourceReference=text(v.sourceReference,'sourceReference',1000),fence=await evidence(ctx,evidenceId)
 await write(ctx,target,[fence,sql(ctx,'INSERT INTO hnd_dialer_extracts VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)',target,kind,jurisdiction,publishedAt,expiresAt,sourceReference,evidenceId,hash,ctx.actor!.operator.id,ctx.actor!.operator.version,Date.now()),...rows.map(r=>sql(ctx,'INSERT INTO hnd_dialer_extract_rows VALUES (?,?,?,?)',target,r.recipient,r.consentId,r.status))])
 return {id:target,digest:hash,rows:rows.length,qualification:'Imported results and license/provenance evidence; human attestation remains separate.'}
}
export async function configureState(ctx:Context,v:ObjectValue){
 owner(ctx.actor!)
 keys(v,['jurisdiction','startMinute','endMinute','maxAttempts','windowHours','writtenModes','evidenceId','reviewAt','revision','confirm'])
 if(v.confirm!=='approve reviewed state calling rules')throw new Fault('reviewed_state_rules_required',403)
 const jurisdiction=text(v.jurisdiction,'jurisdiction'),start=integer(v.startMinute,'startMinute',480,1259),end=integer(v.endMinute,'endMinute',481,1260),max=integer(v.maxAttempts,'maxAttempts',1,100),hours=integer(v.windowHours,'windowHours',24,720),written=v.writtenModes===undefined?[]:Array.isArray(v.writtenModes)&&!v.writtenModes.length?[]:modeList(v.writtenModes),reviewAt=expiry(v.reviewAt,90*86400000),evidenceId=text(v.evidenceId,'evidenceId')
 if(!/^US-[A-Z]{2}$/.test(jurisdiction)||end<=start)throw new Fault('invalid_state_rules')
 if(jurisdiction==='US-FL'&&(end>1200||max>3||hours<24))throw new Fault('florida_calling_bounds')
 const old=await sql(ctx,'SELECT revision FROM hnd_dialer_state_rules WHERE jurisdiction=?',jurisdiction).first<{revision:number}>()
 if(old&&integer(v.revision,'revision',1)!==old.revision)throw new Fault('state_rule_revision_conflict',409)
 await write(ctx,'installation',[await evidence(ctx,evidenceId),...(old?[guard(ctx,'SELECT count(*) FROM hnd_dialer_state_rules WHERE jurisdiction=? AND revision=?',jurisdiction,old.revision)]:[]),sql(ctx,'INSERT INTO hnd_dialer_state_rules VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(jurisdiction) DO UPDATE SET start_minute=excluded.start_minute,end_minute=excluded.end_minute,max_attempts=excluded.max_attempts,window_hours=excluded.window_hours,written_modes=excluded.written_modes,evidence_id=excluded.evidence_id,review_at=excluded.review_at,revision=excluded.revision,approved_by=excluded.approved_by,owner_version=excluded.owner_version',jurisdiction,start,end,max,hours,JSON.stringify(written),evidenceId,reviewAt,(old?.revision??0)+1,ctx.actor!.operator.id,ctx.actor!.operator.version)])
 return {jurisdiction,revision:(old?.revision??0)+1}
}
export async function registryChecks(ctx:Context,numberId:string,recipient:string,d:RecipientDefinition){
 const now=Date.now(),fences:D1PreparedStatement[]=[]
 const stop=await sql(ctx,"SELECT reason FROM hnd_protection_stops WHERE (number_id=? OR reason='dnc') AND recipient=? AND channel IN ('voice','all') LIMIT 1",numberId,recipient).first<{reason:string}>()
 if(stop)throw new Fault(stop.reason,409)
 fences.push(guard(ctx,"SELECT CASE WHEN EXISTS(SELECT 1 FROM hnd_protection_stops WHERE (number_id=? OR reason='dnc') AND recipient=? AND channel IN ('voice','all')) THEN 0 ELSE 1 END",numberId,recipient))
 for(const kind of ['national','state','reassigned']){
  const jurisdiction=kind==='state'?d.jurisdiction:'US',consent=kind==='reassigned'?d.consentId:''
  // Select the newest relevant source, including a missing recipient result.
  // A new extract cannot silently fall back to a superseded clear result.
  const extract=await sql(ctx,'SELECT * FROM hnd_dialer_extracts WHERE kind=? AND jurisdiction=? ORDER BY created_at DESC,rowid DESC LIMIT 1',kind,jurisdiction).first<{id:string;published_at:number;expires_at:number;evidence_id:string;approved_by:string;owner_version:number;revoked_at:number|null}>()
  if(!extract||extract.revoked_at||extract.expires_at<=now||extract.published_at>now||extract.published_at<now-31*86400000)throw new Fault(kind+'_extract_missing_or_stale',409)
  const result=await sql(ctx,'SELECT status FROM hnd_dialer_extract_rows WHERE extract_id=? AND recipient=? AND consent_id=?',extract.id,recipient,consent).first<{status:string}>()
  if(!result||result.status!=='clear')throw new Fault(kind+'_'+(result?.status??'unknown'),409)
  fences.push(await evidence(ctx,extract.evidence_id),guard(ctx,`SELECT count(*) FROM hnd_dialer_extracts x JOIN oa_operators o ON o.id=x.approved_by WHERE x.id=? AND x.revoked_at IS NULL AND x.expires_at>? AND x.published_at>=? AND o.status='active' AND o.role='owner' AND o.version=x.owner_version AND x.id=(SELECT id FROM hnd_dialer_extracts WHERE kind=? AND jurisdiction=? ORDER BY created_at DESC,rowid DESC LIMIT 1)`,extract.id,now,now-31*86400000,kind,jurisdiction))
 }
 return fences
}
export async function stateChecks(ctx:Context,recipient:string,d:RecipientDefinition,mode:string,dialTime:boolean,excludeAttemptId='',at=Date.now()){
 const now=at,r=await sql(ctx,"SELECT r.* FROM hnd_dialer_state_rules r JOIN oa_operators o ON o.id=r.approved_by WHERE jurisdiction=? AND review_at>? AND o.status='active' AND o.role='owner' AND o.version=r.owner_version",d.jurisdiction,now).first<{start_minute:number;end_minute:number;max_attempts:number;window_hours:number;written_modes:string;evidence_id:string;revision:number}>()
 if(!r)throw new Fault('state_rules_unknown_or_expired',409)
 const fences=[await evidence(ctx,r.evidence_id),guard(ctx,'SELECT count(*) FROM hnd_dialer_state_rules WHERE jurisdiction=? AND revision=? AND review_at>?',d.jurisdiction,r.revision,now)]
 if(JSON.parse(r.written_modes).includes(mode)){
  if(!d.writtenConsentEvidenceId)throw new Fault('written_consent_required',409)
  fences.push(await evidence(ctx,d.writtenConsentEvidenceId))
 }
 if(!dialTime)return fences
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:d.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)),minute=Number(parts.find(p=>p.type==='hour')?.value)*60+Number(parts.find(p=>p.type==='minute')?.value)
 if(!Number.isFinite(minute)||minute<Math.max(r.start_minute,d.startMinute)||minute>=Math.min(r.end_minute,d.endMinute))throw new Fault('recipient_quiet_hours',409)
 const since=now-r.window_hours*3600000,count=await sql(ctx,"SELECT count(*) AS n FROM hnd_dialer_attempts WHERE recipient=? AND created_at>? AND state<>'held' AND disposition<>'not_called' AND id<>?",recipient,since,excludeAttemptId).first<{n:number}>()
 if((count?.n??0)>=r.max_attempts)throw new Fault('state_frequency_limit',409)
 fences.push(guard(ctx,"SELECT CASE WHEN count(*)<? THEN 1 ELSE 0 END FROM hnd_dialer_attempts WHERE recipient=? AND created_at>? AND state<>'held' AND disposition<>'not_called' AND id<>?",r.max_attempts,recipient,since,excludeAttemptId))
 return fences
}

/** Read-only owner simulation. The supplied time never reaches a paid launch. */
export async function previewState(ctx:Context,v:ObjectValue){
 owner(ctx.actor!);keys(v,['recipient','timezone','jurisdiction','consentId','writtenConsentEvidenceId','mode','at'])
 const recipient=phone(v.recipient),timezone=text(v.timezone,'timezone'),jurisdiction=text(v.jurisdiction,'jurisdiction'),consentId=text(v.consentId,'consentId'),at=timestamp(v.at,'at'),mode=modeList([v.mode])[0]
 try{
  await stateChecks(ctx,recipient,{timezone,jurisdiction,consentId,startMinute:480,endMinute:1260,...(v.writtenConsentEvidenceId?{writtenConsentEvidenceId:text(v.writtenConsentEvidenceId,'writtenConsentEvidenceId')}:{})},mode,true,'',at)
  return {decision:'eligible_state_preview',effectOccurred:false,authorityGranted:false}
 }catch(error){if(error instanceof Fault)return {decision:'held',reason:error.code,effectOccurred:false,authorityGranted:false};throw error}
}
