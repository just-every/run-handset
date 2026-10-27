import assert from 'node:assert/strict'
import { test } from 'node:test'
import { transcriptFixture } from './helpers/handset-transcripts.mjs'
import { post, signIn } from './helpers/handset-auth.mjs'
import { mediaSecurity } from './helpers/handset-media-security.mjs'

test('Prompt media refuses hostile redirects and cross-origin writes without leaking private bindings or reading audio after revocation', mediaSecurity)


test('Supplied bilingual transcript moments retain originals and attributed corrections with stale-write refusal',async()=>{
 const f=await transcriptFixture()
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
 const f=await transcriptFixture()
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
 const f=await transcriptFixture()
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

for(const width of [1440,390])test(`Transcript week search and bilingual correction history at ${width}`,async()=>{
 const {chromium}=await import('@playwright/test'),{mkdir}=await import('node:fs/promises')
 const f=await transcriptFixture(),browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']})
 const context=await browser.newContext({viewport:{width,height:960},ignoreHTTPSErrors:true}),page=await context.newPage()
 const directory=process.env.HANDSET_EVIDENCE_DIR??'.cache/handset-transcripts';await mkdir(directory,{recursive:true})
 async function proof(name){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:`${directory}/${width}-${name}.png`,fullPage:true})}
 try{
  const week=[];for(let day=0;day<7;day++)week.push(await f.create(day))
  const tuesday=week[1],path='/'+tuesday.transcriptId
  await f.write(path+'/annotations',{segmentId:'synthetic-handset-850',kind:'promise',text:'Call Tuesday about the refund',ownerId:'synthetic-handset-1',dueState:'scheduled',dueAt:Date.parse('2026-10-27T16:00:00Z'),confirm:'I confirm this exact cited promise'})
  const [name,...rest]=f.cookie.split('=');await context.addCookies([{name,value:rest.join('='),url:f.runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
  await page.goto(f.runtime.origin+'/app/recordings');await proof('recordings-entry');await page.getByRole('link',{name:'Search permitted transcript text'}).click();await page.getByLabel('Search permitted text').fill('refund');await page.getByRole('button',{name:'Search transcripts'}).click()
  assert.match(await page.locator('main').innerText(),/7 permitted results/);await proof('week-search')
  await page.getByLabel('From (UTC)').fill('2026-10-20T00:00');await page.getByLabel('Through (UTC)').fill('2026-10-20T23:59');await page.getByRole('button',{name:'Search transcripts'}).click();assert.match(await page.locator('main').innerText(),/1 permitted results/);await proof('tuesday-filter');await page.getByRole('link',{name:/2026-10-20T16:00/}).click();assert.ok(await page.locator('#moment-synthetic-handset-850').count())
  assert.match(await page.locator('main').innerText(),/32.0–37.0 seconds/);assert.match(await page.locator('main').innerText(),/Owner synthetic-handset-1 · scheduled/);await proof('tuesday-moment')
  await page.getByLabel('Correct en text').fill('I will call about the refund on Tuesday. Check the condenser.');await page.getByRole('button',{name:'Save en correction'}).click()
  await page.getByLabel('Correct es text').fill('El condensador no funciona; necesito el reembolso.');await page.getByRole('button',{name:'Save es correction'}).click()
  const history=await page.locator('main').innerText();assert.match(history,/Revision 1 · synthetic-handset-1/);assert.match(history,/Revision 2 · synthetic-handset-1/);assert.match(history,/condensor/);assert.match(history,/condensador/);await proof('bilingual-history')
  const missing=await f.create(8,'missing');await page.goto(f.runtime.origin+'/app/transcripts/'+missing.transcriptId);assert.match(await page.locator('main').innerText(),/Missing transcript: Audio unavailable/);assert.equal(await page.getByRole('button',{name:/Save .* correction/}).count(),0);await proof('missing-reason')
  await f.runtime.sql("UPDATE oa_operators SET status='active' WHERE id='synthetic-handset-2'")
  const outsider=await signIn({...f.runtime,ownerEmail:'synthetic-handset-2@example.test'}),[otherName,...otherValue]=outsider.cookie.split('=')
  await context.clearCookies();await context.addCookies([{name:otherName,value:otherValue.join('='),url:f.runtime.origin,secure:true,httpOnly:true,sameSite:'Lax'}])
  await page.goto(f.runtime.origin+'/app/transcripts?q=refund');assert.match(await page.locator('main').innerText(),/No permitted matches/);assert.doesNotMatch(await page.locator('main').innerText(),/Maria Torres|condensor|Call Tuesday/);await proof('outside-team')
  const denied=await page.goto(f.runtime.origin+'/app/transcripts/'+tuesday.transcriptId);assert.equal(denied.status(),403);await proof('denied-detail')
 }finally{await context.close();await browser.close();await f.runtime.close()}
})

test('Recording capture requires exact participant consent and announcement revisions and never replays an uncertain provider create',async()=>{
 const {captureFixture,captureParticipants,announceCapture,startCapture}=await import('./helpers/handset-capture.mjs')
 const f=await captureFixture()
 try{
  await f.create({jurisdiction:'unknown'})
  await f.act('start',{confirm:'start this consented recording'},409);assert.deepEqual(f.requests,[])
  await f.act('consent',{jurisdiction:'all-party',participants:[captureParticipants[0],{...captureParticipants[1],consent:'no'}],confirm:'review exact call participants'})
  await f.act('start',{confirm:'start this consented recording'},409);assert.deepEqual(f.requests,[])
  await f.act('consent',{jurisdiction:'all-party',participants:captureParticipants,confirm:'review exact call participants'})
  await f.act('start',{confirm:'start this consented recording'},409)
  const old=f.session.revision;await announceCapture(f)
  await f.act('start',{revision:old,confirm:'start this consented recording'},409)
  await f.act('start',{confirm:'start this consented recording'});assert.equal(f.session.state,'capturing')
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].body.RecordingTrack,'both');assert.equal(f.requests[0].body.RecordingStatusCallback,f.runtime.origin+'/providers/twilio/events')
  await f.act('pause');assert.equal(f.session.state,'paused');assert.equal(f.requests[1].body.PauseBehavior,'skip')
  await f.act('resume',{confirm:'start this consented recording'},409);assert.equal(f.requests.length,2)
  await announceCapture(f);await f.act('resume',{confirm:'start this consented recording'});assert.equal(f.session.state,'capturing')
  await f.act('consent',{jurisdiction:'all-party',participants:[...captureParticipants,{id:'synthetic-handset-103',consent:'unknown'}],confirm:'review exact call participants'})
  assert.equal(f.session.state,'blocked');assert.equal(f.requests.at(-1).body.Status,'stopped')
  await f.act('resume',{confirm:'start this consented recording'},409)
  await f.runtime.restart();assert.equal((await f.get()).state,'blocked')
  const member=await f.member()
  assert.equal((await post(f.runtime,f.base,{callId:f.callId,jurisdiction:'all-party',participants:captureParticipants,confirm:'review exact call participants'},{cookie:member.cookie})).status,403)
  assert.equal((await f.runtime.request(f.base)).status,401)
  const foreign=await post(f.runtime,f.base,{},{cookie:f.cookie,origin:'https://synthetic-handset-foreign.example.test'});assert.equal(foreign.status,403)
  await f.create()
  f.runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${f.account}/Calls/${f.callSid}/Recordings.json`,{__httpStatus:503})
  await announceCapture(f);await f.act('start',{confirm:'start this consented recording'},409)
  assert.equal((await f.get()).state,'uncertain')
  const attempts=f.runtime.sourceRequests.filter(r=>r.method==='POST').length
  await f.act('start',{confirm:'start this consented recording'},409)
  assert.equal(f.runtime.sourceRequests.filter(r=>r.method==='POST').length,attempts)
  const events=await f.runtime.sql("SELECT kind FROM hnd_capture_boundaries WHERE session_id=? ORDER BY revision",f.session.id)
  assert.deepEqual(events.results.map(r=>r.kind),['participants','announcement.attested','start.requested'])
 }finally{await f.runtime.close()}
})

test('Paused capture withholds direct audio and transcript release and reviewed retention enforces a legal hold before exact erasure',async()=>{
 const {captureFixture,startCapture,announceCapture}=await import('./helpers/handset-capture.mjs')
 const f=await captureFixture()
 try{
  await f.create();await startCapture(f)
  const arrival=await f.callback({RecordingSid:f.recordingSid,CallSid:f.callSid,RecordingStatus:'completed',From:'',To:''});assert.equal(arrival.status,200)
  const recordingId=(await arrival.json()).recordId
  const media=`https://api.twilio.com/2010-04-01/Accounts/${f.account}/Recordings/${f.recordingSid}`
  f.runtime.twilioResources.set(media+'.wav',{__audio:[82,73,70,70,1,2,3,4]})
  assert.equal((await post(f.runtime,'/api/handset/recordings/grants',{recordingId,personId:'synthetic-handset-1',expiresAt:Date.now()+1200000,confirm:'approve consented recording for this exact person'},f.headers)).status,201)
  const input={recordingId,durationMs:120000,state:'supplied',confirm:'authorize supplied transcript for my exact identity',segments:[{id:'synthetic-handset-112',speaker:'Agent',language:'en',startMs:1000,endMs:2000,text:'Discuss the refund after consent',confidence:1}]}
  await f.act('pause')
  const reads=f.runtime.sourceRequests.filter(r=>r.url.endsWith('.wav')).length
  assert.equal((await f.runtime.request('/api/handset/recordings/'+recordingId+'/playback',{headers:f.headers})).status,403)
  const planted={...input,segments:[{...input.segments[0],text:'synthetic-handset-113 paused payment value'}]}
  const refused=await post(f.runtime,'/api/handset/transcripts',planted,f.headers);assert.equal(refused.status,403)
  const absent=await f.runtime.sql('SELECT count(*) AS n FROM hnd_transcripts WHERE recording_id=?',recordingId);assert.equal(absent.results[0].n,0)
  assert.equal(f.runtime.sourceRequests.filter(r=>r.url.endsWith('.wav')).length,reads)
  await announceCapture(f);await f.act('resume',{confirm:'start this consented recording'})
  assert.equal((await post(f.runtime,'/api/handset/transcripts',input,f.headers)).status,403)
  await f.act('stop')
  let transcript=await post(f.runtime,'/api/handset/transcripts',input,f.headers);assert.equal(transcript.status,201,await transcript.clone().text());const transcriptId=(await transcript.json()).transcriptId
  assert.equal((await f.runtime.request('/api/handset/recordings/'+recordingId+'/playback',{headers:f.headers})).status,200)
  assert.equal((await f.runtime.request('/media/recordings/'+recordingId,{headers:f.headers})).status,404)
  await f.act('retention',{retainUntil:Date.now()+86400000,hold:true,confirm:'review this exact retention and hold'})
  await f.act('erase',{confirm:'erase this exact recording and supplied text'},409)
  await f.act('retention',{retainUntil:Date.now()-1000,hold:true,confirm:'review this exact retention and hold'})
  await f.act('erase',{confirm:'erase this exact recording and supplied text'},409)
  assert.equal((await f.runtime.request('/api/handset/recordings/'+recordingId+'/playback',{headers:f.headers})).status,403)
  assert.equal((await f.runtime.request('/api/handset/transcripts/'+transcriptId,{headers:f.headers})).status,403)
  const hidden=await f.runtime.request('/api/handset/transcripts?q=refund',{headers:f.headers});assert.deepEqual((await hidden.json()).matches,[])
  await f.act('retention',{retainUntil:Date.now()-1000,hold:false,confirm:'review this exact retention and hold'})
  f.runtime.twilioResources.set(media+'.json',request=>{assert.equal(request.method,'DELETE');return {__httpStatus:204}})
  await f.act('erase',{confirm:'erase this exact recording and supplied text'})
  assert.equal(f.session.state,'erased')
  const retained=await f.runtime.sql('SELECT original FROM hnd_transcripts WHERE id=?',transcriptId);assert.equal(retained.results[0].original,'[]')
  await f.runtime.restart();assert.equal((await f.get()).state,'erased')
  assert.equal((await f.runtime.request('/api/handset/transcripts/'+transcriptId,{headers:f.headers})).status,403)
  assert.equal((await f.runtime.request('/api/handset/recordings/'+recordingId+'/playback',{headers:f.headers})).status,403)
 }finally{await f.runtime.close()}
})
