import assert from 'node:assert/strict'
import { post, signIn } from './handset-auth.mjs'

export async function flowRoleFixture(runtime,q){
 const base='/api/handset/flows',access='/api/handset/prompts/access',personId='synthetic-handset-2'
 const ownerPost=async(path,value,status=200)=>{const r=await post(runtime,path,value,q.headers);assert.equal(r.status,status,await r.clone().text());return r.json()}
 assert.equal((await post(runtime,'/auth/operator/status',{operatorId:personId,status:'active'},q.headers)).status,200)
 const person=(await runtime.sql('SELECT version FROM oa_operators WHERE id=?',personId)).results[0]
 const member=await signIn({...runtime,ownerEmail:personId+'@example.test'}),headers={cookie:member.cookie}
 const definition={name:'Austin reception access',entry:'sales',timezone:'America/Chicago',overrides:[],nodes:[{id:'sales',kind:'queue',next:[],queueId:q.sales.id,group:{strategy:'simultaneous',members:[q.spanish]}}]}
 const allowed=await ownerPost(base,{definition},201)
 const foreign=await ownerPost(base,{definition:{...definition,name:'Private support flow',nodes:[{id:'support',kind:'queue',next:[],queueId:q.support.id,group:{strategy:'simultaneous',members:[q.english]}}]}},201)
 await ownerPost(`${base}/${foreign.id}/test`,{path:['support']})
 await ownerPost(`${base}/${foreign.id}/publish`,{revision:0,confirm:'approve this exact tested flow version'})
 const roleInput={name:'Austin flow preparers',revision:0,capabilities:['flow.read','flow.draft','flow.test'],promptIds:[],flowIds:[allowed.flowId],confirm:'approve exact custom role'}
 const assign=role=>ownerPost(`${access}/${role.id}/assign`,{revision:role.revision,personId,personVersion:person.version,confirm:'assign exact custom role'})
 const actorPost=(path,value)=>post(runtime,path,value,headers)
 return {runtime,q,base,access,personId,person,member,headers,definition,allowed,foreign,roleInput,ownerPost,assign,actorPost}
}
