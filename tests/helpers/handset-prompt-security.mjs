import assert from 'node:assert/strict'
import { post,signIn } from './handset-auth.mjs'
import { b64, newPrompt, people, wavBytes } from './handset-prompts.mjs'

const redirectTarget='https://handset-redirect.example.test/private'
const markers=['synthetic-handset-500','synthetic-handset-970']
export async function promptSecurity(f,greeting){
 const path=`/api/handset/prompts/${greeting.id}/versions`,body={source:'tts',language:'en',variant:'always',script:'A greeting whose response stays private'}
 const before=await f.ok('GET','/api/handset/prompts'),speechCount=f.speech.length
 for(const headers of [{origin:'https://foreign.example.test'},{origin:''},{'sec-fetch-site':'cross-site'}]){
  const response=await post(f.runtime,path,body,{...f.headers,...headers});assert.equal(response.status,403)
 }
 assert.equal(f.speech.length,speechCount,'origin refusal happens before any provider request')
 const form=new URLSearchParams({promptId:greeting.id,source:'upload',language:'en',variant:'always',audioBase64:b64(wavBytes({rate:8000}))})
 assert.equal((await f.runtime.request('/app/prompts/versions',{method:'POST',headers:{...f.headers,origin:'https://foreign.example.test','content-type':'application/x-www-form-urlencoded'},body:form.toString()})).status,403)
 const responses=[]
 for(const [factory,status] of [
  [(request,Response)=>new Response(markers.join(' '),{status:302,headers:{location:redirectTarget}}),502],
  [(request,Response)=>new Response(markers.join(' '),{status:500}),502],
  [(request,Response)=>new Response(markers.join(' '),{headers:{'content-type':'text/html'}}),502],
  [(request,Response)=>new Response(new Uint8Array(1),{headers:{'content-type':'audio/wav','content-length':String(4*1024*1024)}}),413],
 ]){
  f.speechResponses.push(factory)
  const response=await post(f.runtime,path,body,f.headers);assert.equal(response.status,status);responses.push(await response.text())
 }
 let produced=0
 f.speechResponses.push((request,Response)=>new Response(new ReadableStream({pull(controller){if(produced===16){controller.close();return}produced++;controller.enqueue(new Uint8Array(256*1024))}}),{headers:{'content-type':'audio/wav'}}))
 const streamed=await post(f.runtime,path,body,f.headers);assert.equal(streamed.status,413);responses.push(await streamed.text())
 assert.deepEqual(f.redirectRequests,[],'redirect destinations receive no request or credential')
 const after=await f.ok('GET','/api/handset/prompts')
 assert.deepEqual(after.versions.map(v=>v.id).sort(),before.versions.map(v=>v.id).sort(),'refused requests save no draft')
 const html=await (await f.runtime.request('/app/prompts',{headers:f.headers})).text()
 const audit=await f.ok('GET','/api/handset/audit/export')
 const stored=await f.runtime.sql('SELECT * FROM hnd_prompt_versions')
 assert.ok(f.runtime.logs.length>0,'the runtime log capture is populated')
 for(const marker of markers)assert.equal(JSON.stringify([responses,after,html,audit,stored.results,f.runtime.logs]).includes(marker),false,'provider credentials stay out of responses, logs, prompt storage and ordinary audit export')
 const odd=await newPrompt(f,'Odd frame greeting','main_attendant'),oddPath=`/api/handset/prompts/${odd.id}/versions`
 const valid=await f.ok('POST',oddPath,{source:'upload',language:'en',variant:'always',audioBase64:b64(wavBytes({rate:8000,seconds:1.000125}))},201)
 const normalized=await f.runtime.request(`/api/handset/prompts/versions/${valid.id}/audio`,{headers:f.headers})
 assert.equal(normalized.status,200)
 assert.equal((await post(f.runtime,oddPath,{source:'upload',language:'en',variant:'always',audioBase64:b64(new Uint8Array(await normalized.arrayBuffer()))},f.headers)).status,201,'a valid odd-length normalized WAV remains uploadable')
}

export async function phoneSecurity(f){
 const greeting=await newPrompt(f,'Private phone greeting','main_attendant'),root=`/api/handset/prompts/${greeting.id}/phone-recordings`
 const userInfo=new URL('https://api.twilio.com/private');userInfo.username='synthetic-handset';userInfo.password='synthetic-handset'
 const inbound={MessageSid:'synthetic-handset-security-message',MessageStatus:'received',Timestamp:new Date().toISOString(),NumMedia:'1',MediaContentType0:'audio/wav',Body:'A permitted media reference'}
 const requestsBefore=f.runtime.sourceRequests.length
 for(const address of [redirectTarget,'https://api.twilio.com:444/private',userInfo.href,'http://api.twilio.com/private']){
  assert.equal((await f.source.callback({...inbound,MediaUrl0:address})).status,400)
 }
 assert.equal(f.runtime.sourceRequests.length,requestsBefore,'undeclared media destinations receive no bytes')
 assert.equal((await f.source.callback({...inbound,MediaUrl0:'https://api.twilio.com/2010-04-01/Accounts/'+f.source.account+'/Messages/synthetic-handset-security-message/Media/synthetic-handset-security-media'})).status,200)
 assert.equal(f.runtime.sourceRequests.length,requestsBefore,'permitted MMS references remain metadata without a media fetch')
 // The source issuer stays authorized while the separate recording author loses authority.
 assert.equal((await post(f.runtime,'/auth/operator/status',{operatorId:'synthetic-handset-2',status:'active'},f.headers)).status,200)
 assert.equal((await post(f.runtime,'/auth/operator/role',{operatorId:'synthetic-handset-2',role:'owner'},f.headers)).status,200)
 const author=await signIn({...f.runtime,ownerEmail:'synthetic-handset-2@example.test'}),authorHeaders={cookie:author.cookie},destination='+15125550145'
 assert.equal((await post(f.runtime,'/api/handset/prompts/extensions',{extension:'105',operatorId:'synthetic-handset-2',directoryName:'Elliot Brooks',destination,active:true},authorHeaders)).status,201)
 const authored=await post(f.runtime,root,{sourceId:f.source.source.id,destination,language:'en',variant:'always'},authorHeaders)
 assert.equal(authored.status,201);const held=await authored.json(),authorCall={CallSid:'synthetic-handset-withdrawn-author',From:'+18335550125',To:destination}
 assert.equal((await f.signed(held.providerPath,authorCall)).status,200)
 assert.equal((await f.signed(held.providerPath+'/pin',{...authorCall,Digits:held.pin})).status,200)
 assert.equal((await post(f.runtime,'/auth/operator/role',{operatorId:'synthetic-handset-2',role:'member'},f.headers)).status,200)
 const authorRequests=f.runtime.sourceRequests.length
 assert.equal((await f.signed(held.providerPath+'/recorded',{...authorCall,RecordingSid:'synthetic-handset-author-recording'})).status,409)
 assert.equal(f.runtime.sourceRequests.length,authorRequests,'withdrawing only the author prevents any provider read')
 let count=0
 async function pending(){
  const made=await f.ok('POST',root,{sourceId:f.source.source.id,destination:people[0].destination,language:'en',variant:'always'},201)
  const fields={CallSid:'synthetic-handset-security-call-'+(++count),From:'+18335550125',To:people[0].destination}
  assert.equal((await f.signed(made.providerPath,fields)).status,200)
  assert.equal((await f.signed(made.providerPath+'/pin',{...fields,Digits:made.pin})).status,200)
  return {made,fields}
 }
 const rec='synthetic-handset-security-recording',base=`https://api.twilio.com/2010-04-01/Accounts/${f.source.account}/Recordings/${rec}`
 const request=await pending()
 f.runtime.twilioResources.set(base+'.json',{__httpStatus:302,__headers:{location:redirectTarget}})
 assert.equal((await f.signed(request.made.providerPath+'/recorded',{...request.fields,RecordingSid:rec,RecordingUrl:redirectTarget})).status,503)
 assert.equal(f.runtime.sourceRequests.filter(r=>r.url===base+'.wav').length,0)
 f.source.resource('Recordings',rec,{call_sid:request.fields.CallSid,status:'completed',duration:'1'})
 f.runtime.twilioResources.set(base+'.wav',{__audio:[...wavBytes()],__httpStatus:302,__mime:'audio/wav',__headers:{location:redirectTarget}})
 assert.equal((await f.signed(request.made.providerPath+'/recorded',{...request.fields,RecordingSid:rec})).status,503)
 assert.deepEqual(f.redirectRequests,[])
 // Revoke the source during a successful metadata read: no media bytes may be requested.
 f.runtime.twilioResources.set(base+'.json',async()=>{
  assert.equal((await post(f.runtime,'/api/handset/sources/revoke',{sourceId:f.source.source.id},f.headers)).status,200)
  return {sid:rec,account_sid:f.source.account,call_sid:request.fields.CallSid,status:'completed'}
 })
 const mediaBefore=f.runtime.sourceRequests.filter(r=>r.url===base+'.wav').length
 assert.equal((await f.signed(request.made.providerPath+'/recorded',{...request.fields,RecordingSid:rec})).status,409)
 assert.equal(f.runtime.sourceRequests.filter(r=>r.url===base+'.wav').length,mediaBefore,'source withdrawal fences media retrieval itself')
 assert.equal((await f.ok('GET','/api/handset/prompts')).versions.filter(v=>v.prompt_id===greeting.id).length,0)
}
