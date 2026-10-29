import assert from 'node:assert/strict'
import { post, signIn } from './handset-auth.mjs'

export async function authorityFixture(runtime){
 const {cookie}=await signIn(runtime),headers={cookie}
 async function create(path,value){const response=await post(runtime,path,value,headers);assert.equal(response.status,201,await response.clone().text());return response.json()}
 const detail=await create('/api/handset/cases',{title:'Controlled receptionist work'})
 const caseId=detail.current.id
 const number=(await create('/api/handset/records',{kind:'number',sourceId:'synthetic-handset-200',occurredAt:Date.now(),caseId,data:{e164:'+15125550124'}})).record.id
 const recipients=[]
 for(const n of [201,202])recipients.push((await create('/api/handset/records',{kind:'person',sourceId:`synthetic-handset-${n}`,occurredAt:Date.now(),caseId,data:{name:`Synthetic customer ${n}`}})).record.id)
 const definition={scopes:['read','draft','send'],tools:['case.read','comment.draft','call.paid','message.send','campaign.launch','number.port','number.release','flow.publish','recording.read'],records:[caseId],numbers:[number],recipients,budgetCents:1000,policyRevision:'owner-only-v1'}
 const grantInput={name:'Controlled receptionist',definition,expiresAt:Date.now()+3600000,confirm:'approve scoped credential'}
 const proposed={operation:'call.paid',caseId,caseVersion:1,numberId:number,recipients:[recipients[0]],amountCents:60,flowRevision:'1',policyRevision:'owner-only-v1',content:'Confirm the requested appointment'}
 const issue=(input={})=>create('/api/handset/mcp/consent',{...grantInput,...input})
 const approve=(grantId,state=proposed)=>create('/api/handset/grants/approve',{grantId,state,expiresAt:Date.now()+1800000,confirm:'approve exact reviewed state'})
 const app=(token,path,data)=>post(runtime,'/api/handset/application/'+path,path==='mcp'?{...data,params:{...data.params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}}:data,{authorization:'Bearer '+token,...(path==='mcp'?{'MCP-Protocol-Version':'2026-07-28','Mcp-Method':data.method,...(data.params?.name?{'Mcp-Name':data.params.name}:{})}:{})})
 return {cookie,headers,caseId,number,recipients,definition,grantInput,proposed,create,issue,approve,app}
}
