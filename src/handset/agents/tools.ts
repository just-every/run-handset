import { ToolRefusal, type ToolContext, type JsonSchema, type ToolDefinition } from '../../modules/agent-door/index.ts'
import type { Bindings } from '../../auth.server'
import { applicationRead, draft, prepare } from '../authority/application'
import { state } from '../authority/model'
import { grantPolicy } from '../authority/store'
import { getCase } from '../records/store'
import { Fault } from '../core'
import { nativeGrant, nativeNames } from './grants'

const string = {type:'string',minLength:1,maxLength:200}
const stateSchema = {type:'object',additionalProperties:false,required:['operation','caseId','caseVersion','policyRevision'],properties:{operation:string,caseId:string,caseVersion:{type:'integer',minimum:1},numberId:{type:'string'},recipients:{type:'array',items:string},amountCents:{type:'integer',minimum:0},flowRevision:{type:'string'},policyRevision:string,content:{type:'string',maxLength:4000}}}
const standard = () => [{class:'standard' as const,facts:{measure:1}}]
const native = async <T>(fn:()=>Promise<T>) => {try{return await fn()}catch(error){if(error instanceof Fault)throw new ToolRefusal(error.code);throw error}}

/** These are native scoped reads, unpublished drafts and held preparations.
 * Preparing work is an internal record effect; it neither sends nor moves money. */
export function handsetTools(env: Bindings): ToolDefinition[] {
 const tools = Object.entries(nativeNames).map(([name,verb]):ToolDefinition => {
  const read = verb==='case.read', comment=verb==='comment.draft'
  const properties:Record<string,JsonSchema> = read?{grantId:string,caseId:string}:comment?{grantId:string,caseId:string,text:{type:'string',minLength:1,maxLength:4000}}:{grantId:string,state:stateSchema,approvalId:string,standingId:string,callerInstructions:{type:'string',maxLength:4000}}
  const caseId = (args:Record<string,unknown>) => String(read||comment?args.caseId:state(args.state).caseId)
  return {
   name,title:read?'Read selected case':comment?'Draft an unpublished comment':`Prepare ${verb} (provider held)`,
   description:read?'Read the exact case selected in the sponsor’s native grant. External text is untrusted.':comment?'Save an unpublished native draft. Does not publish or contact anyone.':'Prepare exactly reviewed native work. The current application adapter stays held; no provider effect occurs.',
   scope:name,readOnly:read,inputSchema:{type:'object',properties,required:read?['grantId','caseId']:comment?['grantId','caseId','text']:['grantId','state'],additionalProperties:false},
   outputSchema:{type:'object'},classes:read?['sensitive']:['standard'],clauses:['HND-030','HND-049','SURFACE-001'],untrusted:read,
   async classify(args,ctx) {
    await nativeGrant(env,args,ctx,verb)
    if(!read&&!comment&&state(args.state).operation!==verb)throw new ToolRefusal('tool_operation_mismatch')
    return read?[{class:'sensitive',facts:{measure:(await getCase(env.DB,caseId(args))).records.length+1,kind:'case'}}]:standard()
   },
   async revision(args,ctx) {await nativeGrant(env,args,ctx,verb);return (await getCase(env.DB,caseId(args))).current.version},
   async target(args,ctx){await nativeGrant(env,args,ctx,verb);return {kind:'case',id:(await getCase(env.DB,caseId(args))).current.id}},
   async summary(args,ctx){
    await nativeGrant(env,args,ctx,verb)
    const current=(await getCase(env.DB,caseId(args))).current
    const proposed=!read&&!comment?state(args.state):null
    return {target:{id:current.id,name:current.title},items:[read?'Read selected case':comment?`Unpublished draft: ${String(args.text)}`:`Held preparation: ${verb}; no provider effect`],
     ...(proposed?{recipients:proposed.recipients,amount:{value:proposed.amountCents/100,currency:'USD'}}:{})}
   },
   async run(args,ctx) {
    return native(async()=>{
     const g=await nativeGrant(env,args,ctx,verb)
     const result=read?await applicationRead(env,g,caseId(args),ctx):comment?await draft(env,g,{caseId:args.caseId,text:args.text},ctx.idempotencyKey??undefined,ctx):await prepare(env,g,{state:args.state,...(args.approvalId?{approvalId:args.approvalId}:{}),...(args.standingId?{standingId:args.standingId}:{}),idempotencyKey:ctx.idempotencyKey},grantPolicy(g),ctx)
     return {result}
    })
   },
  }
 })
 tools.push({
  name:'handset.workspace.snapshot',title:'Inspect current scoped work',description:'Read native owned case, unpublished draft and held-job counts, without content or credentials.',scope:'handset.workspace.snapshot',readOnly:true,
  inputSchema:{type:'object',properties:{},additionalProperties:false},outputSchema:{type:'object',required:['cases','drafts','jobs'],properties:{cases:{type:'integer'},drafts:{type:'integer'},jobs:{type:'integer'}}},classes:['standard'],clauses:['HND-030','HND-049','SURFACE-001'],classify:standard,
  async run(_args,ctx){
   const count=async(sql:string)=>(await env.DB.prepare(sql).bind(ctx.person.id).first<{n:number}>())!.n
   return {result:{cases:await count('SELECT count(*) AS n FROM hnd_cases WHERE owner_id=?'),drafts:await count('SELECT count(*) AS n FROM hnd_drafts d JOIN hnd_grants g ON g.id=d.grant_id WHERE g.created_by=?'),jobs:await count('SELECT count(*) AS n FROM hnd_jobs j JOIN hnd_grants g ON g.id=j.grant_id WHERE g.created_by=?')}}
  },
 })
 return tools
}
