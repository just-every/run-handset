import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openHandset } from './helpers/handset-worker.mjs'
import { sourceFixture } from './helpers/handset-sources.mjs'
import { post, signIn } from './helpers/handset-auth.mjs'

async function fixture(){
 const runtime=await openHandset({twilio:true})
 try{
  const f=await sourceFixture(runtime),base='/api/handset/transcripts'
  async function write(path,value,status=201,headers=f.headers){const r=await post(runtime,base+path,value,headers);assert.equal(r.status,status,await r.clone().text());return r.json()}
  async function get(path='',headers=f.headers){const r=await runtime.request(base+path,{headers});assert.equal(r.status,200,await r.clone().text());return r.json()}
  async function create(day=0,state='supplied'){
   const callSid=`synthetic-handset-${810+day}`,sid=`synthetic-handset-${830+day}`,date=new Date(Date.parse('2026-10-19T16:00:00Z')+day*86400000).toUTCString()
   const call=await f.callback({CallSid:callSid,CallStatus:'completed',SequenceNumber:'0',Timestamp:date});assert.equal(call.status,200,await call.clone().text())
   f.resource('Recordings',sid,{call_sid:callSid,start_time:date,status:'completed'})
   const recording=await f.callback({RecordingSid:sid,CallSid:callSid,RecordingStatus:'completed',From:'',To:''});assert.equal(recording.status,200,await recording.clone().text())
   const recordingId=(await recording.json()).recordId
   const input={recordingId,durationMs:120000,state,confirm:'authorize supplied transcript for my exact identity',...(state==='supplied'?{segments:[{id:'synthetic-handset-850',speaker:'Maria Torres',language:'en',startMs:32000,endMs:37000,text:'I will call about the refund on Tuesday. Check the condensor.',confidence:0.96},{id:'synthetic-handset-851',speaker:'Rosa García',language:'es',startMs:45000,endMs:50000,text:'El condensor no funciona; necesito el reembolso.',confidence:0.65}]}:{reason:'Audio unavailable from the speech processor'})}
   return {...await write('',input),input,recordingId}
  }
  return {...f,runtime,base,write,get,create}
 }catch(error){await runtime.close();throw error}
}

test('Supplied bilingual transcript moments retain originals and attributed corrections with stale-write refusal',async()=>{
 const f=await fixture()
 try{
  const week=[];for(let day=0;day<7;day++)week.push(await f.create(day))
  const tuesday=week[1],path='/'+tuesday.transcriptId
  assert.equal((await f.get('?q=refund')).matches.length,7)
  const filtered=await f.get('?q=refund&from='+Date.parse('2026-10-20T00:00:00Z')+'&to='+Date.parse('2026-10-20T23:59:59Z')+'&numberId='+f.numberId)
  assert.equal(filtered.matches.length,1);assert.equal(filtered.matches[0].id,tuesday.transcriptId)
  const result=await f.get(path)
  assert.deepEqual(result.segments[0].moment,{recordingId:tuesday.recordingId,startMs:32000,endMs:37000})
  assert.equal(result.segments[1].lowConfidence,true)
  assert.match(result.provenance,/owner-supplied/)
  for(const [index,value] of [[0,'I will call about the refund on Tuesday. Check the condenser.'],[1,'El condensador no funciona; necesito el reembolso.']])await f.write(path+'/corrections',{segmentId:tuesday.input.segments[index].id,text:value,revision:index})
  const corrected=await f.get(path)
  assert.match(corrected.original[0].text,/condensor/);assert.match(corrected.original[1].text,/condensor/)
  assert.match(corrected.segments[0].text,/condenser/);assert.match(corrected.segments[1].text,/condensador/)
  assert.deepEqual(corrected.corrections.map(c=>c.created_by),['synthetic-handset-1','synthetic-handset-1'])
  await f.write(path+'/corrections',{segmentId:tuesday.input.segments[0].id,text:'Stale correction',revision:0},409)
  await f.runtime.restart()
  assert.equal((await f.get(path)).revision,2)
  assert.equal((await f.get('?q=condensador')).matches.length,1)
  const corrections=await Promise.all(['First concurrent correction','Second concurrent correction'].map(value=>post(f.runtime,f.base+path+'/corrections',{segmentId:tuesday.input.segments[0].id,text:value,revision:2},f.headers)))
  assert.deepEqual(corrections.map(r=>r.status).sort(),[201,409])
  assert.equal((await f.get(path)).revision,3)
 }finally{await f.runtime.close()}
})

test('Transcript annotations separate inference and sentiment from human-confirmed promises and refuse missing-audio fabrication',async()=>{
 const f=await fixture()
 try{
  const created=await f.create(),path='/'+created.transcriptId,citation={segmentId:'synthetic-handset-850'}
  await f.write(path+'/annotations',{...citation,kind:'sentiment',text:'Possibly frustrated; supplied human judgment'})
  await f.write(path+'/annotations',{...citation,kind:'action',text:'Review the refund',ownerId:'synthetic-handset-1',dueState:'pending'})
  await f.write(path+'/annotations',{...citation,kind:'promise',text:'Call Tuesday',ownerId:'synthetic-handset-1',dueState:'scheduled',dueAt:Date.parse('2026-10-27T16:00:00Z')},403)
  await f.write(path+'/annotations',{...citation,kind:'promise',text:'Call Tuesday',ownerId:'synthetic-handset-1',dueState:'scheduled',dueAt:Date.parse('2026-10-27T16:00:00Z'),confirm:'I confirm this exact cited promise'})
  await f.write(path+'/annotations',{...citation,kind:'action',text:'No accountable owner',dueState:'pending'},400)
  await f.write(path+'/annotations',{...citation,kind:'action',text:'Ambiguous due state',ownerId:'synthetic-handset-1',dueState:'scheduled'},400)
  await f.write(path+'/annotations',{segmentId:'synthetic-handset-absent',kind:'summary',text:'An invented moment'},400)
  const result=await f.get(path)
  assert.deepEqual(result.annotations.map(a=>a.kind).sort(),['action','promise','sentiment'])
  assert.equal((await f.get('?ownerId=synthetic-handset-1')).matches.length,1)
  assert.equal((await f.get('?ownerId=synthetic-handset-2')).matches.length,0)
  const promise=result.annotations.find(a=>a.kind==='promise');assert.equal(promise.owner_id,'synthetic-handset-1');assert.equal(promise.created_by,'synthetic-handset-1')
  const missing=await f.create(1,'missing'),empty=await f.get('/'+missing.transcriptId)
  assert.equal(empty.state,'missing');assert.match(empty.reason,/Audio unavailable/);assert.deepEqual(empty.segments,[]);assert.deepEqual(empty.annotations,[])
  await f.write('/'+missing.transcriptId+'/annotations',{...citation,kind:'promise',text:'Fabrication',ownerId:'synthetic-handset-1',dueState:'pending',confirm:'I confirm this exact cited promise'},409)
 }finally{await f.runtime.close()}
})

test('Exact-person transcript permissions and source revocation stop direct search detail and correction access after restart',async()=>{
 const f=await fixture()
 try{
  const created=await f.create(),path='/'+created.transcriptId
  await f.runtime.sql("UPDATE oa_operators SET status='active' WHERE id='synthetic-handset-2'")
  const member=await signIn({...f.runtime,ownerEmail:'synthetic-handset-2@example.test'}),headers={cookie:member.cookie}
  const playback=await post(f.runtime,'/api/handset/recordings/grants',{recordingId:created.recordingId,personId:'synthetic-handset-2',expiresAt:Date.now()+1200000,confirm:'approve consented recording for this exact person'},f.headers)
  assert.equal(playback.status,201,'playback is independently approved before transcript read is refused')
  assert.deepEqual((await f.get('?q=refund',headers)).matches,[])
  assert.equal((await f.runtime.request(f.base+path,{headers})).status,403)
  assert.equal((await f.runtime.request(f.base+path)).status,401)
  const allowed=await f.write(path+'/grants',{personId:'synthetic-handset-2',expiresAt:Date.now()+1200000,confirm:'approve this exact person to read transcript text'})
  await f.write(path+'/revoke',{personId:'synthetic-handset-1'},200)
  assert.equal((await f.runtime.request(f.base+path,{headers:f.headers})).status,403,'owner administration alone never returns text')
  await f.write(path+'/grants',{personId:'synthetic-handset-1',expiresAt:Date.now()+1200000,confirm:'approve this exact person to read transcript text'})
  assert.equal((await f.get(path)).id,created.transcriptId,'a fresh explicit approval restores text access')
  assert.equal(allowed.personId,'synthetic-handset-2');assert.equal((await f.get('?q=refund',headers)).matches.length,1)
  await f.write(path+'/corrections',{segmentId:'synthetic-handset-850',text:'Unauthorized edit',revision:0},403,headers)
  await f.write(path+'/grants',{personId:'synthetic-handset-2',expiresAt:Date.now()+1200000,confirm:'approve this exact person to read transcript text'})
  await f.write(path+'/revoke',{personId:'synthetic-handset-2'},200)
  await f.runtime.restart()
  assert.equal((await f.runtime.request(f.base+path,{headers})).status,403)
  assert.deepEqual((await f.get('?q=refund',headers)).matches,[])
  const revoked=await post(f.runtime,'/api/handset/sources/revoke',{sourceId:f.source.id},f.headers);assert.equal(revoked.status,200)
  assert.deepEqual((await f.get('?q=refund')).matches,[])
  assert.equal((await f.runtime.request(f.base+path,{headers:f.headers})).status,403)
  await f.write(path+'/revoke',{personId:'synthetic-handset-1'},200)
  await f.write(path+'/corrections',{segmentId:'synthetic-handset-850',text:'Forbidden stale write',revision:0},403)
  assert.equal((await post(f.runtime,f.base,{...created.input,confirm:'not consent'},f.headers)).status,403)
  const foreign=await f.runtime.request(f.base,{method:'POST',headers:{cookie:f.cookie,origin:'https://synthetic-handset-foreign.example.test','content-type':['application','json'].join('/')},body:JSON.stringify(created.input)})
  assert.equal(foreign.status,403)
  const events=await f.runtime.sql("SELECT action FROM hnd_audit WHERE action LIKE 'transcript.%'");assert.ok(events.results.some(e=>e.action==='transcript.revoke'))
 }finally{await f.runtime.close()}
})
