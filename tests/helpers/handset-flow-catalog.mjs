import assert from 'node:assert/strict'

// Native retained data makes the public catalog exercise the full role scope.
export async function exerciseFlowCatalog(f){
 const {runtime,q,base,access}=f,now=Date.now()
 const references=Array.from({length:198},(_,i)=>({id:crypto.randomUUID(),promptId:crypto.randomUUID(),versionId:crypto.randomUUID(),name:'Catalog reference '+String(i).padStart(3,'0')}))
 const versions=Array.from({length:99},(_,i)=>{
  const pair=references.slice(i*2,i*2+2)
  return {id:crypto.randomUUID(),flowId:crypto.randomUUID(),definition:{name:'Catalog flow '+i,entry:'first',timezone:'America/Chicago',overrides:[],nodes:pair.map((r,n)=>({id:n?'last':'first',kind:'queue',next:n?[]:['last'],queueId:r.id,group:{strategy:'simultaneous',members:[r.id]},prompt:{promptId:r.promptId,versionId:r.versionId}}))}}
 })
 const data=JSON.stringify(references)
 await runtime.sql("INSERT INTO oa_operators(id,email,display_name,role,status,created_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.id')||'@example.test',json_extract(value,'$.name'),'member','active',? FROM json_each(?)",now,data)
 await runtime.sql("INSERT INTO hnd_queues(id,name,mode,skills,max_wait_seconds,wrap_seconds,max_waiting,overflow_kind,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),'longest_idle','[]',120,0,100,'voicemail',?,? FROM json_each(?)",now,now,data)
 await runtime.sql("INSERT INTO hnd_prompts SELECT json_extract(value,'$.promptId'),json_extract(value,'$.name'),'queue',0,?,? FROM json_each(?)",q.english,now,data)
 await runtime.sql("INSERT INTO hnd_prompt_versions(id,prompt_id,version,source,language,variant,schedule,original_format,audio,audio_sha256,duration_ms,state,author_id,created_at) SELECT json_extract(value,'$.versionId'),json_extract(value,'$.promptId'),1,'upload','en','always','{}','wav','','',1000,'approved',?,? FROM json_each(?)",q.english,now,data)
 await runtime.sql("INSERT INTO hnd_flow_versions SELECT json_extract(value,'$.id'),json_extract(value,'$.flowId'),1,json_extract(value,'$.definition'),'draft',?,? FROM json_each(?)",q.english,now,JSON.stringify(versions))
 const flowIds=[f.allowed.flowId,...versions.map(v=>v.flowId)],input={...f.roleInput,name:'Full catalog preparation',flowIds}
 const role=await f.ownerPost(access,input,201)
 await f.assign(role)
 const response=await runtime.request(base,{headers:f.headers})
 assert.equal(response.status,200,await response.clone().text())
 const catalog=await response.json()
 assert.equal(catalog.versions.length,100)
 assert.deepEqual(new Set(catalog.versions.map(v=>v.flow_id)),new Set(flowIds))
 assert.ok(!JSON.stringify(catalog).includes(f.foreign.id))
 const retained=catalog.versions.flatMap(v=>JSON.parse(v.definition).nodes)
 for(const key of ['queueId','group','prompt'])assert.ok(new Set(retained.map(n=>key==='group'?n.group?.members[0]:key==='prompt'?n.prompt?.versionId:n[key]).filter(Boolean)).size>100)
 const page=await runtime.request('/app/flows/'+versions.at(-1).id,{headers:f.headers})
 assert.equal(page.status,200,await page.clone().text())
 const html=await page.text()
 assert.ok(html.includes(references.at(-1).name))
 assert.ok(!html.includes('Private support flow'))
 const readOnly=await f.ownerPost(`${access}/${role.id}`,{...input,revision:role.revision,capabilities:['flow.read']},201)
 assert.equal((await runtime.request(base,{headers:f.headers})).status,403,'editing the exact bulk role immediately suspends all assigned flows')
 await f.assign(readOnly)
 const readPage=await runtime.request('/app/flows/'+versions.at(-1).id,{headers:f.headers})
 assert.equal(readPage.status,200,await readPage.clone().text())
 assert.doesNotMatch(await readPage.text(),/action="\/app\/flows\/save"/)
 await f.ownerPost(`${access}/${role.id}`,{...input,revision:readOnly.revision,capabilities:[]},201)
}
