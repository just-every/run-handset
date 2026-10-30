import assert from 'node:assert/strict'
import { test } from 'node:test'
import { post } from './helpers/handset-auth.mjs'
import { receptionistFixture, policyFor } from './helpers/handset-receptionist.mjs'

// A scope change while the receiving system answers preflight must take effect
// before the POST, not only at the start of the enclosing HTTP request.
test('Grant, STOP, case and policy changes during connector preflight prevent the subsequent provider write', async () => {
 for (const change of ['grant','stop','case','policy','rotation']) {
  const f = await receptionistFixture()
  try {
   await f.savePolicy()
   // The signature-verified source normally supplies From/To. Add that context
   // via its public ingress rather than planting a carrier receipt in native records.
   const { sourceFixture } = await import('./helpers/handset-sources.mjs')
   const source = await sourceFixture(f.runtime)
   const inbound = await source.callback({ CallSid: 'synthetic-handset-race-inbound', CallStatus: 'no-answer', SequenceNumber: '0', Timestamp: new Date().toISOString() })
   assert.equal(inbound.status, 200)
   const sourcedCase = (await inbound.json()).caseId
   const grant = await f.create('/api/handset/mcp/consent', { name: 'Preflight-race worker', definition: { scopes: ['send'], tools: ['outcome.work'], records: [sourcedCase], numbers: [], recipients: [], budgetCents: 0, policyRevision: 'owner-only-v1' }, expiresAt: Date.now() + 3600000, confirm: 'approve scoped credential' })
   const opened = await f.agent('outcomes', { callId: 'synthetic-handset-race-call', caseId: sourcedCase, language: 'en', callerName: 'Jordan Lee', callerEmail: 'synthetic-handset-race@example.test', identityBasis: 'callback_to_number_on_file', identityVerified: true }, grant.token)
   assert.equal(opened.status, 201)
   const outcome = (await opened.json()).outcome
   f.edges.orbitCheckHook = async () => {
    let response
    if (change === 'grant') response = await post(f.runtime, `/api/handset/grants/${grant.grant.id}/revoke`, {}, f.headers)
    if (change === 'rotation') response = await post(f.runtime, `/api/handset/grants/${grant.grant.id}/rotate`, {}, f.headers)
    if (change === 'stop') response = await post(f.runtime, '/api/handset/protection/stops', { numberId: source.numberId, recipient: '+15125550126', channel: 'all', reason: 'dnc', confirm: 'record outbound consent stop' }, f.headers)
    if (change === 'case') response = await post(f.runtime, `/api/handset/cases/${sourcedCase}`, { title: 'Human changed the callback plan', version: 1 }, f.headers)
    if (change === 'policy') response = await post(f.runtime, '/api/handset/receptionist/policy', { policy: policyFor('synthetic-handset-2'), expectedVersion: 1, confirm: 'set receptionist limits' }, f.headers)
    assert.ok([200,201].includes(response.status), await response.clone().text())
   }
   const response = await f.agent(`outcomes/${outcome.id}/handoffs\/crm`, { summary: 'Approved context before preflight' }, grant.token)
   assert.ok([200,409].includes(response.status), change + ' ' + await response.clone().text())
   assert.equal(f.edges.effects.size, 0, change + ' changed while preflight was in flight')
   assert.equal(f.edges.requests.filter(r => r.host === f.edges.origins.orbit && r.method === 'POST').length, 0)
   const overview = await f.runtime.request('/api/handset/delivery', { headers: f.headers })
   assert.equal(overview.status, 200)
   const view = await overview.json()
   assert.ok(view.steps.some(s => s.outcome_id === outcome.id && ['sent','uncertain'].includes(s.state)), 'interrupted claim remains visible for repair')
   assert.ok(!JSON.stringify(view).includes('synthetic-handset-703'), 'no connector secret enters the repair inventory')
   assert.equal((await f.runtime.request('/api/handset/delivery')).status, 401)
  } finally { await f.runtime.close() }
 }
})


async function apiFixture(scopes, tools) {
 const f = await receptionistFixture()
 const issued = await f.create('/api/handset/mcp/consent', { name: 'Scoped REST client', definition: { scopes, tools, records: f.cases.slice(0, 2), numbers: [], recipients: [], budgetCents: 0, policyRevision: 'owner-only-v1' }, expiresAt: Date.now() + 3600000, confirm: 'approve scoped credential' })
 const headers = { authorization: 'Bearer ' + issued.token }
 const read = path => f.runtime.request('/api/handset/v1' + path, { headers })
 const write = (path, value, key) => post(f.runtime, '/api/handset/v1' + path, value, { ...headers, ...(key ? { 'idempotency-key': key } : {}) })
 return { ...f, restGrant: issued, read, write }
}

test('Versioned REST pagination and OpenAPI preserve exact selected-case scope and immediate credential revocation', async () => {
 const f = await apiFixture(['read'], ['case.read'])
 try {
  const document = await f.read('/openapi.json')
  assert.equal(document.status, 200)
  const spec = await document.json(); assert.equal(spec.openapi, '3.1.0'); assert.ok(spec.paths['/drafts'].post.parameters.some(p => p.name === 'Idempotency-Key'))
  const first = await (await f.read('/cases?limit=1')).json()
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor)
  const second = await (await f.read('/cases?limit=1&cursor=' + first.nextCursor)).json()
  assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null)
  assert.deepEqual([first.items[0].current.id, second.items[0].current.id].sort(), f.cases.slice(0, 2).sort())
  assert.equal((await f.read('/cases/' + f.cases[2])).status, 403)
  assert.equal((await f.read('/cases?cursor=' + f.cases[2])).status, 403)
  const audit = await (await f.runtime.request('/api/handset/audit/export', { headers: f.headers })).json()
  assert.ok(audit.rows.some(row => row.actor === f.restGrant.grant.id && row.action === 'application.attempt' && row.outcome === 'refused' && row.subject === 'installation'), 'scoped refusals retain opaque audit attribution')
  assert.equal((await f.runtime.request('/api/handset/v1/cases', { headers: f.headers })).status, 401, 'a native cookie is not an application credential')
  assert.equal((await post(f.runtime, `/api/handset/grants/${f.restGrant.grant.id}/revoke`, {}, f.headers)).status, 200)
  assert.equal((await f.read('/cases')).status, 401)
  assert.equal((await f.write('/prepare', {})).status, 401)
  const revokedAudit = await (await f.runtime.request('/api/handset/audit/export', { headers: f.headers })).json()
  assert.ok(revokedAudit.rows.filter(row => row.actor === f.restGrant.grant.id && row.action === 'application.attempt' && row.outcome === 'refused').length >= 4, 'known revoked credentials retain refusal attribution too')
 } finally { await f.runtime.close() }
})

test('Versioned draft idempotency survives replay, conflicting bodies, races and restart without publishing or repeating work', async () => {
 const f = await apiFixture(['draft'], ['comment.draft'])
 try {
  const body = { caseId: f.cases[0], text: 'Draft an Austin estimate; no message has been sent' }
  assert.equal((await f.write('/drafts', body)).status, 400)
  const initial = await f.write('/drafts', body, 'synthetic-handset-draft-1'); assert.equal(initial.status, 201)
  const draft = await initial.json(); assert.equal(draft.published, false)
  const replay = await f.write('/drafts', body, 'synthetic-handset-draft-1'); assert.equal(replay.status, 200); assert.equal((await replay.json()).id, draft.id)
  assert.equal((await f.write('/drafts', { ...body, text: 'Changed proposal' }, 'synthetic-handset-draft-1')).status, 409)
  const racing = await Promise.all([1, 2].map(() => f.write('/drafts', body, 'synthetic-handset-draft-race')))
  assert.ok(racing.every(r => [200,201,409].includes(r.status)))
  const recovered = await (await f.write('/drafts', body, 'synthetic-handset-draft-race')).json()
  await f.runtime.restart()
  assert.equal((await (await f.write('/drafts', body, 'synthetic-handset-draft-race')).json()).id, recovered.id)
  assert.equal((await f.runtime.sql('SELECT count(*) AS n FROM hnd_drafts WHERE grant_id=?', f.restGrant.grant.id)).results[0].n, 2)
  assert.equal((await f.read('/cases')).status, 403)
  assert.equal(f.edges.effects.size, 0)
 } finally { await f.runtime.close() }
})

test('Versioned API rate limits are durable per credential and authentication still refuses revoked callers', async () => {
 const f = await apiFixture(['read'], ['case.read'])
 try {
  let limited
  for (let n = 0; n < 122; n++) {
   const response = await f.read('/openapi.json')
   if (response.status === 429) { limited = response; break }
   assert.equal(response.status, 200)
  }
  assert.ok(limited, 'the bounded minute bucket refuses excess requests')
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  assert.equal(limited.headers.get('ratelimit-remaining'), '0')
  await f.runtime.restart()
  // A restart retains the rate bucket; current auth remains an earlier fence.
  assert.equal((await post(f.runtime, `/api/handset/grants/${f.restGrant.grant.id}/revoke`, {}, f.headers)).status, 200)
  assert.equal((await f.read('/openapi.json')).status, 401)
 } finally { await f.runtime.close() }
})


test('Expired credentials and removed connector scope preserve uncertain committed work and its repair reason through restart', async () => {
 const f = await receptionistFixture()
 try {
  await f.savePolicy()
  for (const [index, flag, reason] of [[0, 'orbitExpired', 'orbit_credential_refused'], [1, 'orbitMissingScope', 'orbit_target_out_of_scope']]) {
   const opened = await f.open(80 + index, 'en', f.cases[index]), base = `outcomes/${opened.outcome.id}/`
   f.edges.drop.add('orbit')
   const lost = await f.ok(base + 'handoffs\/crm', { summary: 'One authorized handoff' })
   assert.equal(lost.step.state, 'uncertain')
   const posts = () => f.edges.requests.filter(r => r.host === f.edges.origins.orbit && r.method === 'POST').length
   const before = posts(), original = [...f.edges.effects.keys()].sort()
   await f.runtime.restart({HANDSET_ORBIT_ORIGIN:f.edges.origins.helpdesk})
   const requestCount=f.edges.requests.length
   const redirected=await f.agent(base+'reconcile',{step:'crm'})
   assert.equal(redirected.status,409);assert.equal((await redirected.json()).error,'connector_destination_changed')
   assert.equal(f.edges.requests.length,requestCount,'an old attempt cannot disclose its correlation to a replacement receiver')
   await f.runtime.restart({HANDSET_ORBIT_ORIGIN:f.edges.origins.orbit})
   f.edges[flag] = true
   await f.runtime.restart()
   const blocked = await f.ok(base + 'reconcile', { step: 'crm' })
   assert.equal(blocked.step.state, 'uncertain', 'a refused read cannot disprove the prior committed write')
   assert.equal(blocked.reason, reason)
   assert.equal(blocked.step.id, lost.step.id)
   assert.equal(posts(), before)
   await f.runtime.restart()
   const inventory = await (await f.runtime.request('/api/handset/delivery', { headers: f.headers })).json()
   assert.ok(inventory.steps.some(s => s.id === lost.step.id && s.state === 'uncertain' && s.reason === reason))
   const connection=inventory.connections.find(c=>c.id==='orbit')
   assert.equal(connection.configured,true);assert.equal(connection.authority,'current')
   assert.deepEqual(connection.mappings,[{target:f.orbitTarget}])
   assert.equal(connection.lastAttempt.reason,reason);assert.ok(connection.unresolved>=1)
   if(index===0)assert.equal(connection.lastConfirmedAt,null);else assert.ok(connection.lastConfirmedAt>0)
   assert.ok(connection.unresolvedAgeMs>=0)
   f.edges[flag] = false
   const reconciled = await f.ok(base + 'reconcile', { step: 'crm' })
   assert.equal(reconciled.step.state, 'confirmed')
   assert.equal(reconciled.reason, 'readback_matched')
   assert.equal(posts(), before)
   assert.deepEqual([...f.edges.effects.keys()].sort(), original)
   const settled=await (await f.runtime.request('/api/handset/delivery',{headers:f.headers})).json()
   const current=settled.connections.find(c=>c.id==='orbit')
   assert.equal(current.unresolved,0);assert.equal(current.lastAttempt.state,'confirmed');assert.ok(current.lastConfirmedAt>0)
  }
 } finally { await f.runtime.close() }
})


test('The shared MCP door retries one native unpublished draft across REST and restart under company policy', async () => {
 const f = await apiFixture(['draft'], ['comment.draft'])
 try {
  const policy = {schema:'rer-agent-policy/1',catalogue:'rer-agent-classes/1',rules:[{id:'all',class:'*',do:'autonomous'}],spend:{none:true}}
  const adopted=await f.runtime.request('/agents/api/policy',{method:'PUT',headers:{origin:f.runtime.origin,cookie:f.headers.cookie,'content-type':'application/json'},body:JSON.stringify({document:policy})})
  assert.equal(adopted.status,200)
  const call = (method, params, key, id = 1) => post(f.runtime,'/api/handset/v1/mcp',{
   jsonrpc:'2.0',...(id===null?{}:{id}),method,
   params:{...params,...(params?.arguments?{arguments:{...params.arguments,...(key?{idempotency_key:key}:{})}}:{})},
  },{authorization:'Bearer '+f.restGrant.token,'MCP-Protocol-Version':'2025-11-25','Mcp-Method':method,...(params?.name?{'Mcp-Name':params.name}:{})})
  const initialized = await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-handset-client', version: '1' } })
  assert.equal(initialized.status,200)
  assert.equal((await initialized.json()).result.protocolVersion,'2025-11-25')
  assert.equal((await call('notifications/initialized',{},undefined,null)).status,202)
  const available=(await (await call('tools/list')).json()).result.tools
  assert.ok(available.some(t=>t.name==='handset.comments.draft'&&t.annotations.readOnlyHint===false))
  const body={caseId:f.cases[0],text:'Draft only; caller instructions cannot authorize outreach'}
  const params={name:'handset.comments.draft',arguments:{grantId:f.restGrant.grant.id,...body}},key='synthetic-handset-mcp-draft'
  const code=async response=>(await response.json()).result?._meta?.['com.runeditrun/error']?.code
  assert.equal(await code(await call('tools/call',params)),'idempotency_key_required')
  const created=await call('tools/call',params,key);assert.equal(created.status,200)
  const result=(await created.json()).result
  assert.equal(result.isError,false);assert.equal(result.structuredContent.published,false)
  assert.equal(JSON.parse(result.content[0].text).id,result.structuredContent.id)
  await f.runtime.restart()
  const replay=(await (await call('tools/call',params,key)).json()).result.structuredContent
  assert.equal(replay.id,result.structuredContent.id)
  assert.equal((await (await f.write('/drafts',body,key)).json()).id,replay.id)
  assert.equal(await code(await call('tools/call',{...params,arguments:{...params.arguments,text:'Changed instruction'}},key)),'idempotency_conflict')
  assert.equal((await call('tools/call',{name:'handset.cases.read',arguments:{grantId:f.restGrant.grant.id,caseId:f.cases[0]}})).status,403)
  assert.equal(await code(await call('tools/call',{name:'handset.comments.draft',arguments:{...params.arguments,caseId:f.cases[2]}},'synthetic-handset-mcp-foreign')),'record_not_available')
  assert.equal(f.edges.effects.size,0)
  assert.equal((await f.runtime.sql('SELECT count(*) AS n FROM hnd_drafts WHERE grant_id=?',f.restGrant.grant.id)).results[0].n,1)
  await post(f.runtime,`/api/handset/grants/${f.restGrant.grant.id}/revoke`,{},f.headers)
  assert.equal((await call('tools/list')).status,401)
  assert.equal((await call('tools/call',params,key)).status,401)
 } finally { await f.runtime.close() }
})


test('Signed call status reordering preserves one canonical call and every original event without repeating work', async () => {
 const { openHandset } = await import('./helpers/handset-worker.mjs')
 const { sourceFixture } = await import('./helpers/handset-sources.mjs')
 const runtime = await openHandset({ twilio: true })
 try {
  const f = await sourceFixture(runtime), at = Date.now() - 10000
  for (const address of ['not a URL', 'http://api.twilio.com/media', 'https://api.twilio.com:8443/media', 'https://example.invalid/media', 'https://api.twilio.com/media?secret=synthetic-handset-982']) {
   const refused = await f.callback({ MessageSid: 'synthetic-handset-mms-refused', NumMedia: '1', MediaUrl0: address, MediaContentType0: 'audio/wav', Timestamp: new Date(at).toISOString() })
   assert.equal(refused.status, 400); assert.equal((await refused.json()).error, 'invalid_media_reference')
  }
  const mms = await f.callback({ MessageSid: 'synthetic-handset-mms-valid', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/synthetic-handset-983', MediaContentType0: 'audio/wav', Timestamp: new Date(at).toISOString() })
  assert.equal(mms.status, 200)
  assert.equal(runtime.sourceRequests.length, 0, 'MMS is declared metadata only and never fetches supplied media URLs')
  const orders = [[3, 1, 0, 2], [1, 3, 2, 0], [0, 2, 3, 1]]
  for (const [index, order] of orders.entries()) {
   const events = ['initiated', 'ringing', 'in-progress', 'completed'].map((state, sequence) => ({ CallSid: 'synthetic-handset-order-' + index, CallStatus: state, SequenceNumber: String(sequence), Timestamp: new Date(at + sequence * 1000).toISOString() }))
   const receipts = []
   for (const sequence of order) {
    const response = await f.callback(events[sequence]); assert.equal(response.status, 200)
    receipts.push(await response.json())
   }
   await runtime.restart()
   for (const event of events) {
    const replay = await f.callback(event); assert.equal(replay.status, 200); assert.equal((await replay.json()).replay, true)
   }
   assert.equal((await f.callback({ ...events[0], CallStatus: 'failed' })).status, 409)
   const canonical = receipts[0].recordId
   const detail = await (await runtime.request('/api/handset/records/' + canonical, { headers: f.headers })).json()
   assert.equal(detail.record.kind, 'call_session')
   const states = [detail.record, ...detail.related.filter(record => record.parent_id === canonical && record.kind === 'provider_attempt')].sort((a, b) => a.occurred_at - b.occurred_at)
   assert.deepEqual(states.map(record => JSON.parse(record.data).providerStatus), ['initiated', 'ringing', 'in-progress', 'completed'])
   assert.equal(new Set(receipts.map(receipt => receipt.caseId)).size, 1)
   assert.equal((await (await runtime.request('/api/handset/cases/' + receipts[0].caseId, { headers: f.headers })).json()).current.status, 'open')
  }
  const inventory=await (await runtime.request('/api/handset/delivery',{headers:f.headers})).json()
  const connection=inventory.sources.find(s=>s.id===f.source.id)
  assert.equal(connection.authority,'current');assert.equal(connection.number_id,f.numberId)
  assert.equal(connection.account_id,f.account);assert.ok(connection.last_receipt_at>=at)
  assert.ok(connection.receiptAgeMs>=0);assert.equal(connection.pending_parents,0)
  await post(runtime,'/api/handset/sources/revoke',{sourceId:f.source.id},f.headers)
  const revoked=await (await runtime.request('/api/handset/delivery',{headers:f.headers})).json()
  assert.equal(revoked.sources.find(s=>s.id===f.source.id).authority,'revoked')
  assert.equal((await runtime.sql('SELECT count(*) AS n FROM hnd_source_receipts')).results[0].n, 13)
  assert.equal(runtime.sourceRequests.filter(request => request.method === 'POST').length, 0)
 } finally { await runtime.close() }
})

test('Signed inbox MMS retains shared history and exactly one claim while unsupported routes and foreign sessions are refused',async()=>{
 const {openHandset}=await import('./helpers/handset-worker.mjs'),{messagesFixture,messageNow}=await import('./helpers/handset-messages.mjs')
 const runtime=await openHandset({twilio:true,clockTime:messageNow})
 try {
  const f=await messagesFixture(runtime),media=`https://api.twilio.com/2010-04-01/Accounts/${f.source.account}/Messages/synthetic-handset-1810/Media/synthetic-handset-1811`
  const received=await f.incoming('The heater display is flashing',{MessageSid:'synthetic-handset-1810',NumMedia:'1',MediaUrl0:media,MediaContentType0:'image/jpeg'})
  const t=await f.current();assert.ok(t)
  const races=await Promise.all([1,2].map(()=>post(runtime,f.base+'/threads/'+t.id+'/claim',{revision:t.revision},f.headers)))
  assert.deepEqual(races.map(r=>r.status).sort(),[200,409])
  const detail=await f.get('/threads/'+t.id)
  assert.equal(detail.thread.owner_id,'synthetic-handset-1');assert.equal(detail.thread.revision,2)
  assert.equal(detail.messages.length,1);assert.equal(detail.messages[0].body,'The heater display is flashing')
  assert.deepEqual(JSON.parse(detail.messages[0].participants),[f.business,f.recipient])
  assert.deepEqual(JSON.parse(detail.messages[0].media),[{providerUrl:media,mime:'image/jpeg',content:'metadata only; not fetched'}])
  assert.equal(detail.history.filter(h=>h.event==='Conversation claimed').length,1)
  assert.equal(runtime.sourceRequests.filter(r=>r.url===media).length,0,'metadata does not fetch private media')
  const group=await f.source.callback({MessageSid:'synthetic-handset-1812',MessageStatus:'received',Body:'Group invitation',Participants:JSON.stringify([f.business,f.recipient,'+15125550127']),Timestamp:new Date(messageNow).toISOString()})
  assert.equal(group.status,409);assert.equal((await f.get('/threads/'+t.id)).messages.length,1)
  assert.equal((await f.source.callback({MessageSid:'synthetic-handset-1813',Body:'Unsigned'},{signature:false})).status,403)
  const {groupsFixture}=await import('./helpers/handset-message-groups.mjs'),grouped=await groupsFixture(runtime)
  assert.equal((await grouped.receive({},false)).status,403)
  const groupReceived=await grouped.receive();assert.equal(groupReceived.status,200,await groupReceived.clone().text())
  const groupId=(await groupReceived.json()).threadId,groupDetail=await f.get('/threads/'+groupId)
  assert.equal(groupDetail.thread.route_kind,'conversations')
  assert.deepEqual(JSON.parse(groupDetail.messages[0].participants),['+15125550145','+15125550126','+15125550127'])
  assert.deepEqual(JSON.parse(groupDetail.messages[0].media),[{sid:'synthetic-handset-1877',mime:'image/jpeg',bytes:1024,content:'metadata only; not fetched'}])
  assert.equal((await (await grouped.receive()).json()).replay,true)
  grouped.members.meta.next_page_url='https://conversations.twilio.com/v1/pending'
  assert.equal((await grouped.receive()).status,409);grouped.members.meta.next_page_url=null
  assert.equal((await grouped.receive({Author:'+15125550129'})).status,502)
  assert.equal((await post(runtime,f.base+'/threads/'+groupId+'/schedule',{revision:1},f.headers)).status,409,'group sends remain refused without a qualified long-code route')
  assert.equal((await post(runtime,f.base+'/group-routes/'+grouped.binding.id+'/revoke',{},f.headers)).status,200)
  assert.equal((await grouped.receive()).status,403)
  assert.equal((await runtime.request(f.base+'/threads/'+groupId,{headers:f.headers})).status,403)
  await runtime.restart();assert.deepEqual((await f.get('/threads/'+t.id)).messages,detail.messages)
  assert.equal((await runtime.request(f.base)).status,401)
  await runtime.sql("UPDATE oa_operators SET status='active' WHERE id='synthetic-handset-2'")
  const {signIn}=await import('./helpers/handset-auth.mjs'),member=await signIn({...runtime,ownerEmail:'synthetic-handset-2@example.test'})
  assert.equal((await runtime.request(f.base,{headers:{cookie:member.cookie}})).status,403)
  assert.equal((await post(runtime,f.base+'/threads/'+t.id+'/claim',{revision:2},{cookie:member.cookie})).status,403)
 }finally{await runtime.close()}
})

test('Exact reviewed snippets send MMS once and keep provider acceptance distinct from carrier delivery and uncertain creates',async()=>{
 const {openHandset}=await import('./helpers/handset-worker.mjs'),{messagesFixture,messageNow}=await import('./helpers/handset-messages.mjs')
 const {createEdges}=await import('./helpers/handset-edges.mjs'),edges=createEdges()
 let mediaAccount,mediaUrl,mediaBytes=1024,mediaHeaders={},mediaStatus=200,mediaReads=0
 edges.handle=async(request,Response)=>{
  if(request.url!==mediaUrl)return null
  mediaReads++
  assert.equal(request.headers.get('authorization'),'Basic '+Buffer.from(mediaAccount+':synthetic-handset-500').toString('base64'))
  return new Response(new Uint8Array(mediaBytes),{status:mediaStatus,headers:{'content-type':'image/png',...mediaHeaders}})
 }
 const runtime=await openHandset({twilio:true,clockTime:messageNow,edges})
 try {
  const f=await messagesFixture(runtime),url=`https://api.twilio.com/2010-04-01/Accounts/${f.source.account}/Messages/synthetic-handset-1820/Media/synthetic-handset-1821`
  mediaUrl=url;mediaAccount=f.source.account
  await f.incoming('Please send the diagram',{MessageSid:'synthetic-handset-1820',NumMedia:'1',MediaUrl0:url,MediaContentType0:'image/png'})
  runtime.twilioResources.set(url+'.json',{account_sid:f.source.account,parent_sid:'synthetic-handset-1820',sid:'synthetic-handset-1821',content_type:'image/png',date_created:new Date(messageNow).toUTCString(),date_updated:new Date(messageNow).toUTCString(),uri:new URL(url).pathname+'.json'})
  const t=await f.claimed(),draft=await f.draft({media:[{url,mime:'image/png',bytes:1024}]})
  assert.equal(draft.state,'draft');assert.equal(f.receiver.sent.length,0)
  assert.equal((await post(runtime,f.base+'/jobs/'+draft.id+'/approve',{revision:draft.revision,confirm:'unchecked'},f.headers)).status,403)
  const queued=(await f.write('/jobs/'+draft.id+'/approve',{revision:draft.revision,confirm:'approve exact scheduled message'},200)).job
  assert.equal(queued.state,'queued');assert.equal(queued.body,draft.body)
  assert.equal((await post(runtime,f.base+'/threads/'+t.id+'/schedule',{revision:t.revision,snippetId:draft.snippet_id,snippetRevision:1,dueAt:messageNow,permissionId:draft.permission_id,media:[{url,mime:'image/png',bytes:5000001}]},f.headers)).status,400)
  assert.equal((await post(runtime,f.base+'/threads/'+t.id+'/schedule',{revision:t.revision,snippetId:draft.snippet_id,snippetRevision:1,dueAt:messageNow,permissionId:draft.permission_id,participants:[f.recipient,'+15125550127']},f.headers)).status,409)
  // Refuse incorrect approvals with and without a provider length header.
  for(const sample of [
   {bytes:1025,headers:{},claimed:1024},
   {bytes:1025,headers:{'content-length':'1025'},claimed:1024},
   {bytes:1023,headers:{},claimed:1024},
   {bytes:5000001,headers:{},claimed:1},
   {bytes:1024,headers:{location:'https://example.invalid/synthetic-handset-1822'},status:302,claimed:1024},
  ]) {
   mediaBytes=sample.bytes;mediaHeaders=sample.headers;mediaStatus=sample.status??200
   const rejected=await f.queued({media:[{url,mime:'image/png',bytes:sample.claimed}]})
   const result=(await f.write('/jobs/'+rejected.id+'/dispatch',{revision:rejected.revision},200)).job
   assert.equal(result.state,'suppressed','Unverified attachment bytes must be refused before submission: '+JSON.stringify(sample))
   assert.match(result.reason,/provider_media_(size_mismatch|unavailable)/)
   assert.equal(f.receiver.sent.length,0,'A rejected attachment must never create a provider message')
   assert.equal(result.provider_sid,null)
  }
  mediaBytes=1024;mediaHeaders={};mediaStatus=200
  const sent=(await f.write('/jobs/'+queued.id+'/dispatch',{revision:queued.revision},200)).job
  assert.equal(sent.state,'accepted');assert.equal(sent.provider_state,'queued');assert.equal(sent.carrier_state,'unconfirmed')
  assert.equal(mediaReads,6,'Every attachment is independently read before submission')
  assert.equal(f.receiver.sent.length,1);assert.deepEqual(f.receiver.sent[0].form.getAll('MediaUrl'),[url])
  await runtime.restart();await runtime.scheduled(messageNow);assert.equal(f.receiver.sent.length,1)
  const m=f.receiver.sent[0].message;m.status='delivered';f.source.resource('Messages',m.sid,m)
  const callback=await f.source.callback({MessageSid:m.sid,From:f.business,To:f.recipient,MessageStatus:'delivered',Timestamp:new Date(messageNow).toISOString()})
  assert.equal(callback.status,200,await callback.clone().text())
  const delivered=(await f.get()).jobs.find(j=>j.id===sent.id)
  assert.equal(delivered.state,'delivered');assert.equal(delivered.carrier_state,'delivered');assert.match(delivered.reason,/no read receipt/)
  m.status='sent';f.source.resource('Messages',m.sid,m)
  assert.equal((await f.write('/jobs/'+sent.id+'/refresh',{},200)).job.state,'delivered','stale provider state cannot regress delivery')
  const uncertain=await f.queued();f.receiver.drop=true
  const unknown=(await f.write('/jobs/'+uncertain.id+'/dispatch',{revision:uncertain.revision},200)).job
  assert.equal(unknown.state,'uncertain');assert.equal(unknown.provider_state,'unknown')
  await runtime.restart();await runtime.scheduled(messageNow);assert.equal(f.receiver.sent.length,2,'a lost create response is not sent twice')
  const lost=f.receiver.sent[1]
  const inventory=async()=>{const response=await runtime.request('/api/handset/delivery',{headers:f.headers});assert.equal(response.status,200);return response.json()}
  assert.ok((await inventory()).messages.some(j=>j.id===unknown.id&&j.state==='uncertain'&&j.provider_sid===null))
  assert.equal((await f.receipt(lost,{},false)).status,403,'unsigned repair cannot establish a provider identity')
  assert.equal((await f.receipt(lost,{AccountSid:'synthetic-handset-foreign'})).status,403)
  const repair='/jobs/'+unknown.id+'/reconcile',proposal={revision:unknown.revision,providerSid:lost.message.sid,confirm:'read back this submitted message'}
  assert.equal((await post(runtime,f.base+repair,proposal)).status,401)
  assert.equal((await post(runtime,f.base+repair,{...proposal,providerSid:m.sid},f.headers)).status,409,'one receipt cannot settle two jobs')
  const actual=lost.message.body
  lost.message.body='Different work';f.source.resource('Messages',lost.message.sid,lost.message)
  assert.equal((await post(runtime,f.base+repair,proposal,f.headers)).status,502)
  lost.message.body=actual
  lost.message.date_created=new Date(messageNow-1000).toUTCString();f.source.resource('Messages',lost.message.sid,lost.message)
  assert.equal((await post(runtime,f.base+repair,proposal,f.headers)).status,409,'an old matching message is not this submission')
  lost.message.date_created=new Date(messageNow).toUTCString();f.source.resource('Messages',lost.message.sid,lost.message)
  const readUrl=`https://api.twilio.com/2010-04-01/Accounts/${f.source.account}/Messages/${lost.message.sid}.json`
  runtime.twilioResources.set(readUrl,{__httpStatus:401})
  assert.equal((await f.receipt(lost)).status,503)
  const refusedRead=(await f.get()).jobs.find(j=>j.id===unknown.id)
  assert.equal(refusedRead.state,'uncertain');assert.match(refusedRead.reason,/credential_refused/)
  await runtime.restart()
  assert.ok((await inventory()).messages.some(j=>j.id===unknown.id&&/credential_refused/.test(j.reason)))
  f.source.resource('Messages',lost.message.sid,lost.message)
  const repaired=await f.receipt(lost);assert.equal(repaired.status,200,await repaired.clone().text())
  assert.equal((await repaired.json()).providerSid,lost.message.sid)
  assert.equal((await f.receipt(lost)).status,200)
  assert.equal((await f.receipt(lost,{Body:'Altered replay'})).status,409)
  // Provider truth may advance while an older signed status is delayed.
  lost.message.status='delivered';f.source.resource('Messages',lost.message.sid,lost.message)
  assert.equal((await f.receipt(lost,{MessageStatus:'sent'})).status,200)
  const settled=(await f.get()).jobs.find(j=>j.id===unknown.id)
  assert.equal(settled.state,'delivered');assert.equal(settled.carrier_state,'delivered');assert.equal(settled.provider_sid,lost.message.sid)
  assert.ok((await inventory()).messages.some(j=>j.id===unknown.id&&j.readback_at===messageNow))
  await runtime.restart();await runtime.scheduled(messageNow+120000)
  assert.equal((await f.get()).jobs.find(j=>j.id===unknown.id).state,'delivered');assert.equal(f.receiver.sent.length,2)
  // A current owner can supply the independently inspected identity if its
  // callback was also lost; this API only reads and never resubmits.
  const manual=await f.queued();f.receiver.drop=true
  const manualLost=(await f.write('/jobs/'+manual.id+'/dispatch',{revision:manual.revision},200)).job
  const manualReceipt=f.receiver.sent[2]
  const manualResult=(await f.write('/jobs/'+manual.id+'/reconcile',{revision:manualLost.revision,providerSid:manualReceipt.message.sid,confirm:'read back this submitted message'},200)).job
  assert.equal(manualResult.state,'accepted');assert.equal(manualResult.provider_sid,manualReceipt.message.sid)
  // Two concurrent repairs must not claim the same receiving message.
  const duplicates=[]
  for(let n=0;n<2;n++){const draft=await f.queued();f.receiver.drop=true;duplicates.push((await f.write('/jobs/'+draft.id+'/dispatch',{revision:draft.revision},200)).job)}
  const oneIdentity=f.receiver.sent[3].message
  let readers=0,release
  const bothReading=new Promise(resolve=>{release=resolve})
  runtime.twilioResources.set(`https://api.twilio.com/2010-04-01/Accounts/${f.source.account}/Messages/${oneIdentity.sid}.json`,async()=>{if(++readers===2)release();await bothReading;return oneIdentity})
  const competing=await Promise.all(duplicates.map(j=>post(runtime,f.base+'/jobs/'+j.id+'/reconcile',{revision:j.revision,providerSid:oneIdentity.sid,confirm:'read back this submitted message'},f.headers)))
  assert.deepEqual(competing.map(r=>r.status).sort(),[200,409],'a provider identity has exactly one local winner')
  const claimed=(await f.get()).jobs.filter(j=>duplicates.some(d=>d.id===j.id))
  assert.equal(claimed.filter(j=>j.state==='accepted').length,1)
  assert.equal(claimed.filter(j=>j.state==='uncertain'&&j.provider_sid===null).length,1)
  const revoked=await f.queued()
  await f.write('/permissions/'+revoked.permission_id+'/revoke',{},200)
  assert.equal((await f.get()).jobs.find(j=>j.id===revoked.id).state,'suppressed')
  assert.equal(f.receiver.sent.length,5)
 }finally{await runtime.close()}
})
