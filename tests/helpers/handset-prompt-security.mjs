import assert from 'node:assert/strict'
import { post,signIn } from './handset-auth.mjs'
import { b64, newPrompt, wavBytes } from './handset-prompts.mjs'

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
  [(request,Response)=>new Response(new Uint8Array(1),{headers:{'content-type':'audio/wav','content-length':String(4*1024*1024)}}),502],
 ]){
  f.speechResponses.push(factory)
  const response=await post(f.runtime,path,body,f.headers);assert.equal(response.status,status);responses.push(await response.text())
 }
 let produced=0
 f.speechResponses.push((request,Response)=>new Response(new ReadableStream({pull(controller){if(produced===16){controller.close();return}produced++;controller.enqueue(new Uint8Array(256*1024))}}),{headers:{'content-type':'audio/wav'}}))
 const streamed=await post(f.runtime,path,body,f.headers);assert.equal(streamed.status,502);responses.push(await streamed.text())
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
 assert.equal((await f.ok('GET','/api/handset/prompts')).versions.filter(v=>v.prompt_id===greeting.id).length,0)
}
