import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { boundedBody, Fault } from '../core'
import { sql } from '../delegation/store'
import { sourceFence } from '../providers/sources'
import { captureFence, currentCapture, writeCapture, type Capture } from './capture-policy'

const accountUrl=(r:Capture)=>`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(r.account_id)}`
async function provider(env:Bindings,r:Capture,url:string,method='GET',body?:URLSearchParams){
 if(!env.HANDSET_TWILIO_AUTH_TOKEN)throw new Fault('capture_provider_unavailable',503)
 try{
  const response=await fetch(url,{method,headers:{authorization:'Basic '+btoa(r.account_id+':'+env.HANDSET_TWILIO_AUTH_TOKEN),...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},body,redirect:'manual',signal:AbortSignal.timeout(5000)})
  if(!response.ok)throw new Fault('capture_provider_unconfirmed',409)
  if(method==='DELETE'){if(response.status!==204)throw new Fault('capture_provider_unconfirmed',409);return null}
  return JSON.parse(new TextDecoder().decode(await boundedBody(response,32768))) as Record<string,unknown>
 }catch(error){if(error instanceof Fault)throw error;throw new Fault('capture_provider_unconfirmed',409)}
}
export async function captureCommand(env:Bindings,actor:Session,r:Capture,action:'start'|'pause'|'resume'|'stop'){
 const source=await currentCapture(env,r),base=accountUrl(r),call=await provider(env,r,base+'/Calls/'+encodeURIComponent(r.call_sid)+'.json')
 if(call?.sid!==r.call_sid||call.account_sid!==r.account_id||call.status!=='in-progress')throw new Fault('capture_live_call_required',409)
 if((action==='start'||action==='resume')&&(r.jurisdiction!=='all-party'||JSON.parse(r.participants).some((p:{consent:string})=>p.consent!=='yes')||r.announced_revision!==r.revision))throw new Fault('current_announcement_and_all_party_consent_required',409)
 if(action==='start'&&(r.state!=='ready'||r.recording_sid)||action==='resume'&&r.state!=='paused'||action==='pause'&&r.state!=='capturing'||action==='stop'&&!['capturing','paused'].includes(r.state))throw new Fault('capture_state_conflict',409)
 // Commit uncertainty before the provider write. No replay or automatic retry.
 const pending=await writeCapture(env,actor,r,action+'.requested',{state:'uncertain'},[sourceFence(env,source)])
 await env.DB.batch([captureFence(env,pending),sourceFence(env,source),sql(env,'DELETE FROM hnd_guard')])
 const recordingUrl=base+'/Calls/'+encodeURIComponent(r.call_sid)+'/Recordings'
 const status=action==='pause'?'paused':action==='stop'?'stopped':'in-progress'
 const body=action==='start'?new URLSearchParams({RecordingChannels:'dual',RecordingTrack:'both',Trim:'do-not-trim',RecordingStatusCallback:env.AUTH_ORIGIN+'/providers/twilio/events',RecordingStatusCallbackEvent:'completed'}):new URLSearchParams({Status:status,...(action==='pause'?{PauseBehavior:'skip'}:{})})
 const receipt=await provider(env,r,recordingUrl+(action==='start'?'':'/'+encodeURIComponent(r.recording_sid!))+'.json','POST',body)
 if(receipt?.account_sid!==r.account_id||receipt.call_sid!==r.call_sid||receipt.status!==status||typeof receipt.sid!=='string'||!receipt.sid||r.recording_sid&&receipt.sid!==r.recording_sid)throw new Fault('capture_provider_identity_mismatch',502)
 try{return await writeCapture(env,actor,pending,action+'.confirmed',{state:action==='start'||action==='resume'?'capturing':status,recording_sid:receipt.sid,announced_revision:null},[sourceFence(env,source)])}
 catch(error){
  if(action==='start'||action==='resume'){try{await stopCaptureMedia(env,{...r,recording_sid:receipt.sid})}catch{ /* Withhold uncertain media; never replay a create. */ }}
  throw error
 }
}
export async function deleteCaptureMedia(env:Bindings,r:Capture){
 if(!r.recording_sid)throw new Fault('capture_recording_required',409)
 await provider(env,r,accountUrl(r)+'/Recordings/'+encodeURIComponent(r.recording_sid)+'.json','DELETE')
}

export async function stopCaptureMedia(env:Bindings,r:Capture){
 if(!r.recording_sid)throw new Fault('capture_recording_required',409)
 const receipt=await provider(env,r,accountUrl(r)+'/Calls/'+encodeURIComponent(r.call_sid)+'/Recordings/'+encodeURIComponent(r.recording_sid)+'.json','POST',new URLSearchParams({Status:'stopped'}))
 if(receipt?.sid!==r.recording_sid||receipt.account_sid!==r.account_id||receipt.call_sid!==r.call_sid||receipt.status!=='stopped')throw new Fault('capture_stop_unconfirmed',409)
}
