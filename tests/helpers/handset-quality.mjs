import assert from 'node:assert/strict'
import { sourceFixture } from './handset-sources.mjs'
import { post, signIn } from './handset-auth.mjs'

export async function qualityFixture(runtime){
 const f=await sourceFixture(runtime),base='/api/handset/quality'
 const write=async(path,value,headers=f.headers)=>{
  const response=await post(runtime,base+path,value,headers)
  assert.equal(response.status,201,await response.clone().text())
  return response.json()
 }
 const identities=[['synthetic-handset-600','Agent'],['synthetic-handset-601','Other team agent'],['synthetic-handset-602','Supervisor']]
 for(const [id,name] of identities)await runtime.sql("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) VALUES (?,?,?,?,?,?)",id,id+'@example.test',name,'member','active',Date.now())
 const agent=await signIn({...runtime,ownerEmail:'synthetic-handset-600@example.test'}),foreign=await signIn({...runtime,ownerEmail:'synthetic-handset-601@example.test'}),supervisor=await signIn({...runtime,ownerEmail:'synthetic-handset-602@example.test'})
 const team=await write('/teams',{name:'Support'}),other=await write('/teams',{name:'Sales'})
 const grant=(teamId,personId,role,privateNotes=false,canExport=false)=>write('/grants',{teamId,personId,role,privateNotes,export:canExport,expiresAt:Date.now()+3500000,confirm:'approve exact quality access without recording rights'})
 const ownerGrant=await grant(team.id,'synthetic-handset-1','supervisor',true,true)
 const agentGrant=await grant(team.id,'synthetic-handset-600','agent')
 await grant(other.id,'synthetic-handset-601','agent')
 const supervisorGrant=await grant(team.id,'synthetic-handset-602','supervisor',false,true)
 const r=await write('/rubrics',{teamId:team.id,expectedRevision:0,criteria:[{id:'verify',label:'Verify consent',maxScore:5}]})
 const callExternal='synthetic-handset-603',recordingExternal='synthetic-handset-604',when=new Date(Date.now()-60000).toUTCString()
 assert.equal((await f.callback({CallSid:callExternal,CallStatus:'completed',SequenceNumber:'0',Timestamp:when,CallDuration:'60'})).status,200)
 f.resource('Recordings',recordingExternal,{call_sid:callExternal,start_time:when,status:'completed',duration:'60',channels:1})
 const receipt=await f.callback({CallSid:callExternal,RecordingSid:recordingExternal,RecordingStatus:'completed'})
 assert.equal(receipt.status,200,await receipt.clone().text())
 const caseId=(await receipt.json()).caseId
 const c=await(await runtime.request('/api/handset/cases/'+caseId,{headers:f.headers})).json()
 const callId=c.records.find(r=>r.kind==='call_session').id,recordingId=c.records.find(r=>r.kind==='recording').id
 const playback=async personId=>{
  const response=await post(runtime,'/api/handset/recordings/grants',{recordingId,personId,expiresAt:Date.now()+3500000,confirm:'approve consented recording for this exact person'},f.headers)
  assert.equal(response.status,201,await response.clone().text());return response.json()
 }
 const recordingGrant=await playback('synthetic-handset-1')
 const grades=[{criterionId:'verify',score:2,segmentId:'moment',explanation:'The supplied excerpt does not show a clear consent question.',uncertainty:'Human observation of owner-supplied text; speech is not verified.'}]
 const reviewInput={teamId:team.id,callId,recordingId,agentId:'synthetic-handset-600',rubricId:r.id,segments:[{id:'moment',startMs:0,endMs:5000,text:'Synthetic supplied consent question.'}],grades,confirm:'attest permission for supplied text human review only'}
 const review=await write('/reviews',reviewInput)
 return {...f,base,write,grant,playback,team,other,r,review,reviewInput,grades,agent,foreign,supervisor,ownerGrant,agentGrant,supervisorGrant,recordingGrant}
}
