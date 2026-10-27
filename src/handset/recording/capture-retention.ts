import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, integer, type ObjectValue } from '../core'
import { sql } from '../delegation/store'
import { sourceFence } from '../providers/sources'
import { currentCapture, writeCapture, type Capture } from './capture-policy'
import { deleteCaptureMedia } from './capture-provider'

export async function retention(env:Bindings,actor:Session,r:Capture,v:ObjectValue){
 if(v.confirm!=='review this exact retention and hold')throw new Fault('retention_review_required',403)
 if(['uncertain','erasing','erased'].includes(r.state))throw new Fault('capture_state_conflict',409)
 if(typeof v.hold!=='boolean')throw new Fault('explicit_hold_required')
 const until=v.retainUntil===null?null:integer(v.retainUntil,'retainUntil',0,8640000000000000)
 return writeCapture(env,actor,r,'retention.reviewed',{retain_until:until,hold:v.hold?1:0})
}
export async function erase(env:Bindings,actor:Session,r:Capture,v:ObjectValue){
 if(v.confirm!=='erase this exact recording and supplied text')throw new Fault('erasure_review_required',403)
 if(r.hold)throw new Fault('recording_legal_hold',409)
 if(r.state!=='stopped'||!r.recording_sid)throw new Fault('stopped_recording_required',409)
 if(r.retain_until===null||r.retain_until>Date.now())throw new Fault('reviewed_retention_not_due',409)
 const source=await currentCapture(env,r)
 const pending=await writeCapture(env,actor,r,'erasure.requested',{state:'erasing'},[sourceFence(env,source)])
 await deleteCaptureMedia(env,r)
 // Provider receipt proves only this exact resource deletion, not backups or copies.
 const recordings=`SELECT id FROM hnd_records WHERE parent_id=? AND kind='recording' AND json_extract(data,'$.recordingSid')=?`
 const transcripts=`SELECT id FROM hnd_transcripts WHERE recording_id IN (${recordings})`
 return writeCapture(env,actor,pending,'erasure.confirmed',{state:'erased'},[
  sql(env,`DELETE FROM hnd_transcript_corrections WHERE transcript_id IN (${transcripts})`,r.call_id,r.recording_sid),
  sql(env,`DELETE FROM hnd_transcript_annotations WHERE transcript_id IN (${transcripts})`,r.call_id,r.recording_sid),
  sql(env,`UPDATE hnd_transcripts SET original='[]',state='missing',reason='Explicit owner-reviewed recording erasure' WHERE id IN (${transcripts})`,r.call_id,r.recording_sid),
  sql(env,`UPDATE hnd_transcript_access SET revoked_at=COALESCE(revoked_at,?) WHERE transcript_id IN (${transcripts})`,Date.now(),r.call_id,r.recording_sid),
  sql(env,`UPDATE hnd_recording_grants SET revoked_at=COALESCE(revoked_at,?) WHERE recording_id IN (${recordings})`,Date.now(),r.call_id,r.recording_sid),
 ])
}
