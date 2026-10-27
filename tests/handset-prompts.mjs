import assert from 'node:assert/strict'
import { test } from 'node:test'
import { post, signIn } from './helpers/handset-auth.mjs'
import { phoneSecurity, promptSecurity } from './helpers/handset-prompt-security.mjs'
import { approve, authoredFlow, b64, business, coverage, flowDefinition, instants, newPrompt, people, promptFixture, publishFlow, queueId, registerPeople, wavBytes } from './helpers/handset-prompts.mjs'

const versionPath = (id, tail) => `/api/handset/prompts/versions/${id}/${tail}`
const listing = f => f.ok('GET', '/api/handset/prompts')

test('Custom greeting roles permit only scoped drafts and current role and person authority fences every subsequent request', async () => {
 const f=await promptFixture()
 try {
  await registerPeople(f)
  const greeting=await newPrompt(f,'Austin reception','main_attendant'),foreign=await newPrompt(f,'Private management menu','menu')
  const body={source:'upload',language:'en',variant:'always',audioBase64:b64(wavBytes({rate:8000}))},path=p=>`/api/handset/prompts/${p.id}/versions`,access='/api/handset/prompts/access'
  const original=await f.ok('POST',path(greeting),body,201);await approve(f,original.id)
  const roleInput={revision:0,name:'Front desk greetings',capabilities:['greeting.draft'],promptIds:[greeting.id],confirm:'approve greeting draft role'}
  await f.refused(access,{...roleInput,capabilities:['billing.read']},403,'unsupported_role_capability')
  const role=await f.ok('POST',access,roleInput,201)
  await f.refused(`${access}/${role.id}`,roleInput,409,'role_revision_changed')
  const assign=()=>f.ok('POST',`${access}/${role.id}/assign`,{revision:role.revision,personId:people[1].id,personVersion:1,confirm:'assign exact greeting role'})
  const member=await signIn({...f.runtime,ownerEmail:people[1].id+'@example.test'}),headers={cookie:member.cookie}
  assert.equal((await post(f.runtime,path(greeting),body,headers)).status,403)
  await assign()
  const saved=await post(f.runtime,path(greeting),body,headers);assert.equal(saved.status,201,await saved.clone().text());const draft=await saved.json()
  assert.deepEqual([draft.prompt_id,draft.author_name,draft.state,draft.version],[greeting.id,people[1].name,'draft',2])
  const catalog=await (await f.runtime.request('/api/handset/prompts',{headers})).json()
  assert.deepEqual(catalog.prompts.map(p=>p.id),[greeting.id]);assert.deepEqual(catalog.versions.map(v=>v.id).sort(),[original.id,draft.id].sort())
  assert.deepEqual(catalog.extensions,[])
  assert.equal((await f.runtime.request(versionPath(draft.id,'audio'),{headers})).status,200)
  const other=await f.ok('POST',path(foreign),body,201)
  for(const [method,target,value] of [
   ['POST',path(foreign),body],['GET',versionPath(other.id,'audio')],
   ['GET',access],['POST',access,roleInput],['POST',`${access}/${role.id}/assign`,{revision:1,personId:people[2].id,personVersion:1,confirm:'assign exact greeting role'}],
   ['POST',versionPath(draft.id,'approve'),{audioSha256:draft.audio_sha256,confirm:'approve this exact prompt version'}],
   ['POST',path(greeting),{source:'tts',language:'en',variant:'always',script:'Spend no money'}],
   ['POST',`/api/handset/prompts/${greeting.id}/phone-recordings`,{}],['POST','/api/handset/prompts/test-calls',{}],
   ['GET','/api/handset/billing'],['POST','/api/handset/numbers/purchase',{}],['POST','/api/handset/compliance',{kind:'port_pin',sourceId:f.source.source.id}],
   ['GET','/api/handset/exports/csv'],['POST','/api/handset/exports/archives',{}],['POST','/api/handset/flows',{}],
   ['POST','/auth/operator/role',{operatorId:people[1].id,role:'owner'}],
  ])assert.equal((await (method==='GET'?f.runtime.request(target,{headers}):post(f.runtime,target,value,headers))).status,403,target)
  assert.equal(f.speech.length,0)
  assert.equal((await listing(f)).versions.find(v=>v.id===original.id).state,'approved')
  assert.equal((await listing(f)).versions.find(v=>v.id===draft.id).state,'draft')
  const moved=await f.ok('POST',`${access}/${role.id}`,{...roleInput,revision:role.revision,promptIds:[foreign.id]},201);role.revision=moved.revision
  assert.equal((await post(f.runtime,path(greeting),body,headers)).status,403,'a scope change fences the existing assignment')
  await assign()
  assert.equal((await post(f.runtime,path(greeting),body,headers)).status,403,'fresh assignment covers only the changed greeting scope')
  assert.equal((await post(f.runtime,path(foreign),body,headers)).status,201)
  const back=await f.ok('POST',`${access}/${role.id}`,{...roleInput,revision:role.revision},201);role.revision=back.revision
  await assign()
  const revised=await f.ok('POST',`${access}/${role.id}`,{...roleInput,revision:role.revision,capabilities:[]},201);role.revision=revised.revision
  for(const target of ['/api/handset/prompts',versionPath(draft.id,'audio')])assert.equal((await f.runtime.request(target,{headers})).status,403)
  assert.equal((await post(f.runtime,path(greeting),body,headers)).status,403)
  await assign();assert.equal((await post(f.runtime,path(greeting),body,headers)).status,403,'assignment cannot add a missing capability')
  const restored=await f.ok('POST',`${access}/${role.id}`,{...roleInput,revision:role.revision},201);role.revision=restored.revision
  await assign();assert.equal((await post(f.runtime,path(greeting),body,headers)).status,201)
  await f.runtime.restart();assert.equal((await post(f.runtime,path(greeting),body,headers)).status,201)
  assert.equal((await post(f.runtime,'/auth/operator/status',{operatorId:people[1].id,status:'inactive'},f.headers)).status,200)
  for(const target of ['/api/handset/prompts',versionPath(draft.id,'audio')])assert.equal((await f.runtime.request(target,{headers})).status,401)
  assert.equal((await post(f.runtime,path(greeting),body,headers)).status,401)
  assert.equal((await post(f.runtime,'/auth/operator/status',{operatorId:people[1].id,status:'active'},f.headers)).status,200)
  const renewed=await signIn({...f.runtime,ownerEmail:people[1].id+'@example.test'})
  assert.equal((await post(f.runtime,path(greeting),body,{cookie:renewed.cookie})).status,403,'reactivation never revives old assignments')
  const current=await listing(f)
  assert.equal(current.versions.filter(v=>v.prompt_id===greeting.id).length,4)
  const audit=await f.ok('GET','/api/handset/audit/export')
  assert.ok(audit.rows.some(r=>r.action==='prompt.create'&&r.subject===draft.id&&JSON.parse(r.policy).applied.access?.id===role.id))
 }finally{await f.runtime.close()}
})

test('Uploaded, browser-recorded, phone-recorded and Spanish speech prompts are refused, previewed, approved, pinned and kept through rollback', async () => {
 const f = await promptFixture()
 try {
  await registerPeople(f)
  const queue = await queueId(f), greeting = await newPrompt(f, 'Main greeting', 'main_attendant', true), versions = `/api/handset/prompts/${greeting.id}/versions`
  // Invalid audio never becomes a version.
  await f.refused(versions, { source: 'upload', language: 'en', variant: 'business_hours', audioBase64: b64(Buffer.alloc(300, 7)) }, 422, 'unsupported_audio_format')
  await f.refused(versions, { source: 'upload', language: 'en', variant: 'business_hours', audioBase64: b64(wavBytes().subarray(0, 30)) }, 422, 'invalid_audio_file')
  await f.refused(versions, { source: 'upload', language: 'en', variant: 'business_hours', audioBase64: b64(wavBytes({ seconds: 0.05 })) }, 422, 'audio_duration_out_of_range')
  const malformed=[]
  const truncatedData=wavBytes();truncatedData.writeUInt32LE(truncatedData.length,40);malformed.push(truncatedData)
  const incorrectRiff=wavBytes();incorrectRiff.writeUInt32LE(incorrectRiff.length+40,4);malformed.push(incorrectRiff)
  const incompleteFrame=wavBytes().subarray(0,-1);incompleteFrame.writeUInt32LE(incompleteFrame.length-8,4);incompleteFrame.writeUInt32LE(incompleteFrame.length-44,40);malformed.push(incompleteFrame)
  const wrongAlignment=wavBytes();wrongAlignment.writeUInt16LE(1,32);malformed.push(wrongAlignment)
  const duplicateFormat=Buffer.concat([wavBytes().subarray(0,36),wavBytes().subarray(12)]);duplicateFormat.writeUInt32LE(duplicateFormat.length-8,4);malformed.push(duplicateFormat)
  for(const bytes of malformed)await f.refused(versions,{source:'upload',language:'en',variant:'always',audioBase64:b64(bytes)},422,'invalid_audio_file')
  await f.refused(versions,{source:'upload',language:'en',variant:'always',audioBase64:'!not-base64'},422,'invalid_audio_file')
  assert.equal((await listing(f)).versions.length, 0)
  const upload = await f.ok('POST', versions, { source: 'upload', language: 'en', variant: 'business_hours', schedule: { effectiveFrom: '2026-11-01', note: 'Weekday greeting' }, audioBase64: b64(wavBytes({ rate: 44100, channels: 2, seconds: 1.2 })) }, 201)
  assert.deepEqual([upload.source, upload.language, upload.variant, upload.author_name, upload.state, upload.version, upload.original_format], ['upload', 'en', 'business_hours', 'Mara Patel', 'draft', 1, 'pcm16-44100-2ch'])
  assert.deepEqual(JSON.parse(upload.schedule), { effectiveFrom: '2026-11-01', note: 'Weekday greeting' })
  // The stored audio is the qualified carrier format: 8 kHz mono mu-law WAV.
  const audio = Buffer.from(await (await f.runtime.request(versionPath(upload.id, 'audio'), { headers: f.headers })).arrayBuffer())
  assert.equal(audio.toString('latin1', 0, 4), 'RIFF'); assert.equal(audio.readUInt16LE(20), 7); assert.equal(audio.readUInt32LE(24), 8000); assert.equal(audio.readUInt16LE(22), 1)
  assert.equal(audio.length, 58 + Math.floor(1.2 * 8000))
  // Preview comes first, and approval names the exact audio.
  await f.refused(versionPath(upload.id, 'approve'), { audioSha256: upload.audio_sha256, confirm: 'approve this exact prompt version' }, 409, 'prompt_preview_required')
  await f.refused(versionPath(upload.id, 'preview'), { audioSha256: 'f'.repeat(64) }, 409, 'exact_audio_required')
  await f.ok('POST', versionPath(upload.id, 'preview'), { audioSha256: upload.audio_sha256 })
  await f.refused(versionPath(upload.id, 'approve'), { audioSha256: upload.audio_sha256, confirm: 'yes' }, 403, 'exact_prompt_approval_required')
  // A draft cannot be pinned into a flow.
  const pinOf = (p, v) => ({ promptId: p.id ?? p, versionId: v.id ?? v })
  const pins = { greeting: pinOf(greeting, upload) }
  const browser = await newPrompt(f, 'Queue wait', 'queue')
  const recorded = await f.ok('POST', `/api/handset/prompts/${browser.id}/versions`, { source: 'browser_recording', language: 'en', variant: 'always', audioBase64: b64(wavBytes({ rate: 48000, seconds: 2 })) }, 201)
  assert.equal(recorded.source, 'browser_recording')
  const closed = await newPrompt(f, 'After hours', 'after_hours')
  const speech = await f.ok('POST', `/api/handset/prompts/${closed.id}/versions`, { source: 'tts', language: 'es', variant: 'after_hours', script: 'Hola, estamos cerrados. Llámenos mañana.' }, 201)
  assert.equal(speech.script, 'Hola, estamos cerrados. Llámenos mañana.'); assert.match(speech.original_format, /^tts-pcm16-24000-1ch/)
  assert.equal(f.speech.length, 1)
  assert.deepEqual([f.speech[0].body.model, f.speech[0].body.input, f.speech[0].body.response_format], ['gpt-4o-mini-tts', speech.script, 'wav'])
  assert.match(f.speech[0].body.instructions, /español/); assert.ok(f.speech[0].body.voice); assert.match(f.speech[0].headers.authorization, /^Bearer /)
  await f.refused(`/api/handset/prompts/${closed.id}/versions`, { source: 'tts', language: 'es', variant: 'after_hours', script: 'x', audioBase64: b64(wavBytes()) }, 400, 'tts_takes_script_only')
  const holiday = await newPrompt(f, 'Holiday', 'holiday')
  // Record by phone: only the author's own registered number, only through the signed door.
  const phone = `/api/handset/prompts/${holiday.id}/phone-recordings`, mara = people[0].destination
  await f.refused(phone, { sourceId: f.source.source.id, destination: people[1].destination, language: 'en', variant: 'holiday' }, 403, 'unauthorized_record_destination')
  await f.refused(phone, { sourceId: f.source.source.id, destination: '+15125559999', language: 'en', variant: 'holiday' }, 403, 'unauthorized_record_destination')
  assert.equal((await listing(f)).recordings.length, 0)
  const request = await f.ok('POST', phone, { sourceId: f.source.source.id, destination: mara, language: 'en', variant: 'holiday' }, 201)
  assert.match(request.pin, /^\d{6}$/); assert.match(request.placement, /held/)
  const call = { CallSid: 'synthetic-handset-phone-1', From: business, To: mara, Direction: 'outbound-api' }
  assert.equal((await f.signed(request.providerPath, call, { signature: false })).status, 403)
  assert.equal((await f.signed(request.providerPath, call, { account: 'synthetic-handset-999' })).status, 403)
  assert.equal((await f.signed(request.providerPath, { ...call, To: people[1].destination })).status, 403)
  const start = await f.signed(request.providerPath, call); assert.equal(start.status, 200); assert.match(await start.text(), /six digit/)
  assert.equal((await f.signed(request.providerPath + '/recorded', { ...call, RecordingSid: 'synthetic-handset-rec-0' })).status, 409, 'recording needs the PIN first')
  assert.match(await (await f.signed(request.providerPath + '/pin', { ...call, Digits: '000000' })).text(), /not accepted/)
  assert.match(await (await f.signed(request.providerPath + '/pin', { ...call, Digits: request.pin })).text(), /<Record /)
  const recording = (sid, callSid, bytes = wavBytes({ rate: 8000, seconds: 2 })) => {
   f.source.resource('Recordings', sid, { call_sid: callSid, status: 'completed', duration: '2' })
   f.runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${f.source.account}/Recordings/${sid}.wav`, { __audio: [...bytes] })
  }
  recording('synthetic-handset-rec-other', 'synthetic-handset-someone-else')
  assert.equal((await f.signed(request.providerPath + '/recorded', { ...call, RecordingSid: 'synthetic-handset-rec-other' })).status, 409, 'a recording from another call is refused')
  recording('synthetic-handset-rec-1', call.CallSid)
  assert.equal((await f.signed(request.providerPath + '/recorded', { ...call, RecordingSid: 'synthetic-handset-rec-1' })).status, 200)
  assert.equal((await f.signed(request.providerPath + '/recorded', { ...call, RecordingSid: 'synthetic-handset-rec-1' })).status, 409, 'one request records once')
  const phoneVersion = (await listing(f)).versions.find(v => v.source === 'phone_recording')
  assert.deepEqual([phoneVersion.author_name, phoneVersion.variant, phoneVersion.state, phoneVersion.prompt_id], ['Mara Patel', 'holiday', 'draft', holiday.id])
  // Three wrong codes close a request.
  const second = await f.ok('POST', phone, { sourceId: f.source.source.id, destination: mara, language: 'en', variant: 'holiday' }, 201), other = { ...call, CallSid: 'synthetic-handset-phone-2' }
  await f.signed(second.providerPath, other)
  for (let n = 0; n < 3; n++) await f.signed(second.providerPath + '/pin', { ...other, Digits: '111111' })
  assert.equal((await f.signed(second.providerPath + '/pin', { ...other, Digits: second.pin })).status, 409)
  // Unapproved versions cannot be pinned; approved ones can.
  const full = { greeting: pins.greeting, queue: pinOf(browser, recorded), closed: pinOf(closed, speech), holiday: pinOf(holiday, phoneVersion) }
  await f.refused('/api/handset/flows', { definition: flowDefinition(queue, full) }, 409, 'flow_prompt_unapproved')
  await approve(f, upload.id)
  for (const v of [recorded, speech, phoneVersion]) await approve(f, v.id)
  const first = await publishFlow(f, flowDefinition(queue, full))
  assert.equal((await f.ok('GET', '/api/handset/flows')).publications[0].version_id, first.id)
  // Changing the shared prompt creates a draft that cannot be pinned and never touches the published flow.
  const changed = await f.ok('POST', versions, { source: 'upload', language: 'en', variant: 'business_hours', audioBase64: b64(wavBytes({ seconds: 2, freq: 880 })) }, 201)
  assert.equal(changed.version, 2)
  const next = { ...full, greeting: pinOf(greeting, changed) }
  await f.refused('/api/handset/flows', { flowId: first.flowId, previousVersionId: first.id, definition: flowDefinition(queue, next) }, 409, 'flow_prompt_unapproved')
  await approve(f, changed.id)
  const published = await f.ok('GET', `/api/handset/prompts/pins/${first.id}`)
  assert.equal(published.flowState, 'published'); assert.equal(published.pins.find(p => p.nodeId === 'open').audio_sha256, upload.audio_sha256, 'the published flow still pins the original greeting')
  const second2 = await publishFlow(f, flowDefinition(queue, next), first, 1)
  assert.equal((await f.ok('GET', `/api/handset/prompts/pins/${second2.id}`)).pins.find(p => p.nodeId === 'open').version, 2)
  // Rollback restores the earlier flow with its original prompt versions, and every version is still readable.
  await f.ok('POST', `/api/handset/flows/${first.id}/rollback`, { revision: 2, confirm: 'approve this exact tested flow version' })
  const rolled = await f.ok('GET', `/api/handset/prompts/pins/${first.id}`)
  assert.equal(rolled.flowState, 'published'); assert.deepEqual(rolled.pins.map(p => p.id).sort(), Object.values(full).map(p => p.versionId).sort())
  assert.equal((await f.ok('GET', `/api/handset/prompts/pins/${second2.id}`)).flowState, 'retired')
  assert.equal((await listing(f)).versions.filter(v => v.prompt_id === greeting.id).length, 2)
  const evaluated = await f.ok('POST', `/api/handset/flows/${first.id}/evaluate`, { instant: instants.closed })
  assert.deepEqual(evaluated.prompts, [{ nodeId: 'closed', ...full.closed }])
  // A native human session is required; custom roles never grant anonymous access.
  assert.equal((await f.runtime.request('/api/handset/prompts')).status, 401)
  await promptSecurity(f,greeting)
  await phoneSecurity(f)
 } finally { await f.runtime.close() }
})

test('A signed Gather test call plays each pinned variant and dials an extension mid-greeting or a directory name', async () => {
 const f = await promptFixture()
 try {
  const { flow, pins } = await authoredFlow(f)
  const open = async (instant, n) => {
   const made = await f.ok('POST', '/api/handset/prompts/test-calls', { flowVersionId: flow.id, sourceId: f.source.source.id, instant }, 201)
   const fields = { CallSid: 'synthetic-handset-test-' + n, From: '+15125550199', To: business, Direction: 'inbound' }
   const response = await f.signed(made.providerPath, fields); assert.equal(response.status, 200, await response.clone().text())
   const twiml = await response.text(), enter = digits => f.signed(action(twiml), { ...fields, ...(digits === undefined ? {} : { Digits: digits }) })
   return { made, fields, twiml, enter }
  }
  const action = twiml => new URL(twiml.match(/action="([^"]+)"/)[1].replaceAll('&amp;', '&')).pathname
  const played = async twiml => {
   const url = new URL(twiml.match(/<Play>([^<]+)<\/Play>/)[1].replaceAll('&amp;', '&'))
   const response = await f.runtime.request(url.pathname); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'audio/wav')
   assert.equal((await f.runtime.request(url.pathname.replace(/[0-9a-f]\.wav$/, m => (m[0] === '0' ? '1' : '0') + '.wav'))).status, 404, 'the audio address is unguessable')
   return url.pathname.split('/').at(-2)
  }
  // Each schedule variant plays its own pinned prompt, with Gather wrapped around the audio so digits work during it.
  const business1 = await open(instants.open, 1)
  assert.match(business1.twiml, /<Gather input="dtmf" finishOnKey="#" timeout="3" actionOnEmptyResult="true"[^>]*><Play>/)
  assert.equal(await played(business1.twiml), pins.greeting.versionId)
  const after = await open(instants.closed, 2); assert.equal(await played(after.twiml), pins.closed.versionId); assert.match(after.twiml, /actionOnEmptyResult="false"[\s\S]*<Hangup\/>/)
  const holiday = await open(instants.holiday, 3); assert.equal(await played(holiday.twiml), pins.holiday.versionId)
  // A menu key goes to its destination.
  const sales = await (await business1.enter('1')).text(); assert.equal(await played(sales), pins.queue.versionId)
  // Dial an extension halfway through the greeting: three digits are an extension, one digit is a menu key.
  const dialed = await (await business1.enter('101')).text()
  assert.match(dialed, /<Dial [^>]*><Number>\+15125550142<\/Number><\/Dial>/)
  // Anything else never rings.
  for (const digits of ['10', '9', '999']) assert.doesNotMatch(await (await business1.enter(digits)).text(), /<Dial/, digits)
  let retry = await (await business1.enter('10')).text(); assert.match(retry, /digits\/1/)
  retry = await (await f.signed(action(retry), { ...business1.fields, Digits: '10' })).text(); assert.match(retry, /digits\/2/)
  assert.match(await (await f.signed(action(retry), { ...business1.fields, Digits: '10' })).text(), /<Hangup\/>/, 'three failed entries end the test call')
  assert.match(await (await (await open(instants.open, 4)).enter('')).text(), /digits\/1/)
  // Directory by name: star, then the first letters of the last name on the keypad.
  const directory = async (digits, fields = business1.fields) => (await f.signed(action(business1.twiml).replace(/digits\/\d$/, 'directory'), { ...fields, Digits: digits })).text()
  const star = await (await business1.enter('*')).text(); assert.match(star, /first letters of the last name/)
  const named = await directory('728'); assert.match(named, /Connecting you to Mara Patel/); assert.match(named, /<Number>\+15125550142<\/Number>/)
  assert.match(await (await business1.enter('*728')).text(), /<Number>\+15125550142<\/Number>/)
  const ambiguous = await directory('427242'); assert.match(ambiguous, /Ana Garcia-Lopez, press 1\. Rosa García, press 2\./); assert.doesNotMatch(ambiguous, /<Dial/)
  const pick = action(ambiguous)
  assert.match(await (await f.signed(pick, { ...business1.fields, Digits: '2' })).text(), /<Number>\+15125550143<\/Number>/)
  assert.doesNotMatch(await (await f.signed(pick, { ...business1.fields, Digits: '7' })).text(), /<Dial/)
  assert.doesNotMatch(await directory('555'), /<Dial/)
  // The test call keeps its own audit trail of what the carrier was told.
  const events = JSON.parse((await listing(f)).tests.find(t => t.id === business1.made.id).events).map(e => e.kind)
  for (const kind of ['node', 'menu_choice', 'extension_dial', 'directory_dial', 'directory_choice', 'unknown_extension']) assert.ok(events.includes(kind), kind)
  assert.ok((await listing(f)).tests.find(t => t.id === business1.made.id).events.includes('"midGreeting":true'))
  // An inactive extension is not dialed; the door is signed, account-bound, call-bound and expires.
  await f.ok('POST', '/api/handset/prompts/extensions', { extension: '101', operatorId: people[0].id, directoryName: people[0].name, destination: people[0].destination, active: false }, 201)
  assert.doesNotMatch(await (await business1.enter('101')).text(), /<Dial/)
  const path = business1.made.providerPath
  assert.equal((await f.signed(path, business1.fields, { signature: false })).status, 403)
  assert.equal((await f.signed(path, business1.fields, { account: 'synthetic-handset-999' })).status, 403)
  assert.equal((await f.signed(path, { ...business1.fields, CallSid: 'synthetic-handset-test-other' })).status, 403)
  await f.runtime.sql('UPDATE hnd_prompt_tests SET expires_at=? WHERE id=?', Date.now() - 1, business1.made.id)
  assert.equal((await f.signed(path, business1.fields)).status, 409)
  await f.runtime.restart()
  assert.equal((await f.signed((await open(instants.open, 9)).made.providerPath, { ...business1.fields, CallSid: 'synthetic-handset-test-9' })).status, 200, 'authored state survives restart')
 } finally { await f.runtime.close() }
})
