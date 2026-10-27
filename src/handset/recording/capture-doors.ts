import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { Fault, integer, json, keys, owner, type ObjectValue } from '../core'
import { sql } from '../delegation/store'
import { capture, createCapture, participantPolicy, writeCapture, type Capture } from './capture-policy'
import { captureCommand, stopCaptureMedia } from './capture-provider'
import { erase, retention } from './capture-retention'

export async function captureDoor(request:Request,env:Bindings,actor:Session,v?:ObjectValue):Promise<Response|null>{
 const url=new URL(request.url),base='/api/handset/recordings/capture',path=url.pathname
 if(path!==base&&!path.startsWith(base+'/'))return null
 if(actor.operator.role!=='owner'){
  await commit(env,actor,'recording.capture','installation','refused',[],false)
  throw new Fault('recording_permission_required',403)
 }
 owner(actor)
 if(url.search)throw new Fault('unexpected_capture_query')
 if(path===base){
  if(request.method==='GET'){
   const sessions=(await sql(env,'SELECT * FROM hnd_capture_sessions ORDER BY created_at DESC,id LIMIT 100').all<Capture>()).results
   const calls=(await sql(env,`SELECT r.id,COALESCE(json_extract(r.data,'$.from'),'Call')||' → '||COALESCE(json_extract(r.data,'$.to'),'selected number') AS name FROM hnd_records r WHERE r.kind IN ('call_session','call_leg') ORDER BY r.received_at DESC LIMIT 100`).all<{id:string;name:string}>()).results
   await commit(env,actor,'recording.capture','installation','completed')
   return json({sessions,calls})
  }
  if(request.method!=='POST')throw new Fault('method_not_allowed',405)
  keys(v!,['callId','jurisdiction','participants','confirm'])
  return json({session:await createCapture(env,actor,v!)},201)
 }
 const match=path.match(/^\/api\/handset\/recordings\/capture\/([0-9a-f-]{36})(?:\/(consent|announcement|start|pause|resume|stop|retention|erase))?$/)
 if(!match)throw new Fault('not_found',404)
 const r=await capture(env,match[1]),action=match[2]
 if(!action&&request.method==='GET'){await commit(env,actor,'recording.capture',r.id,'completed');return json({session:r})}
 if(request.method!=='POST'||!action)throw new Fault('method_not_allowed',405)
 const allowed=action==='consent'?['revision','jurisdiction','participants','confirm']:action==='retention'?['revision','retainUntil','hold','confirm']:['pause','stop'].includes(action)?['revision']:['revision','confirm']
 keys(v!,allowed)
 if(integer(v!.revision,'revision',1)!==r.revision)throw new Fault('capture_revision_conflict',409)
 let result:Capture
 if(action==='consent'){
  if(['uncertain','erasing','erased'].includes(r.state))throw new Fault('capture_state_conflict',409)
  if(v!.confirm!=='review exact call participants')throw new Fault('participant_review_required',403)
  // Fence downstream release first, before asking the carrier to stop capture.
  if(['capturing','paused'].includes(r.state)){
   const policy=participantPolicy(v!)
   const blocked=await writeCapture(env,actor,r,'participants.withdrawn',{...policy,state:'blocked',announced_revision:null})
   await stopCaptureMedia(env,blocked)
   result=await writeCapture(env,actor,blocked,'participants.stop.confirmed',{state:'blocked'})
   return json({session:result})
  }
  const policy=participantPolicy(v!)
  result=await writeCapture(env,actor,r,'participants.reviewed',{...policy,state:r.recording_sid?'blocked':policy.state,announced_revision:null})
 }else if(action==='announcement'){
  if(!['ready','paused'].includes(r.state)||v!.confirm!=='I heard the announcement finish for these exact participants')throw new Fault('exact_announcement_attestation_required',403)
  result=await writeCapture(env,actor,r,'announcement.attested',{announced_revision:r.revision+1})
 }else if(action==='retention')result=await retention(env,actor,r,v!)
 else if(action==='erase')result=await erase(env,actor,r,v!)
 else{
  if(['start','resume'].includes(action)&&v!.confirm!=='start this consented recording')throw new Fault('capture_start_confirmation_required',403)
  result=await captureCommand(env,actor,r,action as 'start'|'pause'|'resume'|'stop')
 }
 return json({session:result})
}
