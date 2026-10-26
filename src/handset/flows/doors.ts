import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, id, integer, json, keys, owner, text, type ObjectValue } from '../core'
import { commit } from '../audit/store'
import { guard, sql } from '../delegation/store'
import { definition, type FlowDefinition } from './definition'
import { evaluateFlow, validateEvaluationInput } from './evaluation'

type Version = {id:string;flow_id:string;version:number;definition:string;state:string}
async function version(env:Bindings,target:string){const row=await sql(env,'SELECT * FROM hnd_flow_versions WHERE id=?',target).first<Version>();if(!row)throw new Fault('flow_version_missing',404);return row}
export async function flowDoor(request:Request,env:Bindings,actor:Session,value?:ObjectValue):Promise<Response>{
 owner(actor)
 const url=new URL(request.url),base='/api/handset/flows',path=url.pathname
 if(url.search)throw new Fault('unexpected_flow_query')
 if(path===base&&request.method==='GET'){
  const versions=(await sql(env,'SELECT * FROM hnd_flow_versions ORDER BY created_at DESC,id LIMIT 100').all()).results
  const publications=(await sql(env,'SELECT p.*,o.display_name AS approver_name FROM hnd_flow_publications p LEFT JOIN oa_operators o ON o.id=p.approved_by ORDER BY p.flow_id LIMIT 100').all()).results
  const tests=(await sql(env,'SELECT version_id,path FROM hnd_flow_tests ORDER BY created_at DESC LIMIT 1000').all()).results
  await commit(env,actor,'flow.read','installation','completed')
  return json({versions,publications,tests,bounded:true,qualification:'native path tests only; no carrier routing or audible test calls'})
 }
 if(path===base&&request.method==='POST'){
  keys(value!,['flowId','previousVersionId','definition']);const d=definition(value!.definition),target=id(),flow=value!.flowId?text(value!.flowId,'flowId'):id()
  for(const n of d.nodes)if(n.prompt&&!await sql(env,"SELECT 1 FROM hnd_prompt_versions WHERE id=? AND prompt_id=? AND state='approved'",n.prompt.versionId,n.prompt.promptId).first())throw new Fault('flow_prompt_unapproved',409)
  const previous=value!.flowId?await version(env,text(value!.previousVersionId,'previousVersionId')):null
  if(previous&&previous.flow_id!==flow)throw new Fault('flow_version_mismatch',409)
  const next=(previous?.version??0)+1
  await commit(env,actor,'flow.draft',target,'completed',[
   guard(env,'SELECT CASE WHEN COALESCE((SELECT max(version) FROM hnd_flow_versions WHERE flow_id=?),0)=? THEN 1 ELSE 0 END',flow,next-1),
   ...d.nodes.filter(n=>n.queueId).map(n=>guard(env,'SELECT count(*) FROM hnd_queues WHERE id=?',n.queueId!)),
   ...d.nodes.filter(n=>n.prompt).map(n=>guard(env,"SELECT count(*) FROM hnd_prompt_versions WHERE id=? AND prompt_id=? AND state='approved'",n.prompt!.versionId,n.prompt!.promptId)),
   sql(env,'INSERT INTO hnd_flow_versions VALUES (?,?,?,?,?,?,?)',target,flow,next,JSON.stringify(d),'draft',actor.operator.id,Date.now())])
  return json({id:target,flowId:flow,version:next,state:'draft'},201)
 }
 const match=path.match(/^\/api\/handset\/flows\/([^/]+)\/(test|publish|rollback|evaluate)$/)
 if(!match||request.method!=='POST')throw new Fault('not_found',404)
 const row=await version(env,match[1]),d=JSON.parse(row.definition) as FlowDefinition,action=match[2]
 if(action==='evaluate'){
  const result=evaluateFlow(d,validateEvaluationInput(value))
  await commit(env,actor,'flow.read',row.id,'completed')
  return json({versionId:row.id,...result,prompts:result.path.flatMap(nodeId=>{const pin=d.nodes.find(n=>n.id===nodeId)?.prompt;return pin?[{nodeId,...pin}]:[]}),qualification:'native scenario evaluation only; no carrier routing or audible test'})
 }
 if(action==='test'){
  keys(value!,['path']);if(!['draft','tested'].includes(row.state))throw new Fault('flow_not_testable',409)
  if(!Array.isArray(value!.path)||value!.path.length<1||value!.path.length>50)throw new Fault('invalid_test_path')
  const route=value!.path.map(x=>text(x,'nodeId'));if(![d.entry,...d.overrides.map(o=>o.entry)].includes(route[0]))throw new Fault('test_entry_required')
  for(let i=0;i<route.length;i++){const node=d.nodes.find(n=>n.id===route[i]);if(!node||i<route.length-1&&!node.next.includes(route[i+1])||i===route.length-1&&node.next.length)throw new Fault('incomplete_test_path')}
  const prior=(await sql(env,'SELECT path FROM hnd_flow_tests WHERE version_id=?',row.id).all<{path:string}>()).results.map(r=>JSON.parse(r.path) as string[]),paths=[...prior,route]
  const covered=d.nodes.every(n=>n.next.length?n.next.every(next=>paths.some(p=>p.some((id,i)=>id===n.id&&p[i+1]===next))):paths.some(p=>p.includes(n.id)))
  await commit(env,actor,'flow.test',row.id,'completed',[guard(env,"SELECT count(*) FROM hnd_flow_versions WHERE id=? AND state IN ('draft','tested')",row.id),sql(env,'INSERT INTO hnd_flow_tests VALUES (?,?,?,?)',row.id,JSON.stringify(route),actor.operator.id,Date.now()),sql(env,'UPDATE hnd_flow_versions SET state=? WHERE id=?',covered?'tested':'draft',row.id)])
  return json({state:covered?'tested':'draft',path:route,qualification:'native graph traversal; not an audible carrier test'})
 }
 keys(value!,['revision','confirm'])
 if(value!.confirm!=='approve this exact tested flow version')throw new Fault('exact_flow_approval_required',403)
 const revision=integer(value!.revision,'revision',0),publication=await sql(env,'SELECT version_id,revision FROM hnd_flow_publications WHERE flow_id=?',row.flow_id).first<{version_id:string;revision:number}>()
 if((publication?.revision??0)!==revision)throw new Fault('flow_publication_changed',409)
 if(action==='publish'&&row.state!=='tested'||action==='rollback'&&row.state!=='retired')throw new Fault('tested_or_retired_version_required',409)
 await commit(env,actor,action==='rollback'?'flow.rollback':'flow.publish',row.id,'completed',[
  guard(env,'SELECT CASE WHEN COALESCE((SELECT revision FROM hnd_flow_publications WHERE flow_id=?),0)=? THEN 1 ELSE 0 END',row.flow_id,revision),
  guard(env,'SELECT count(*) FROM hnd_flow_versions WHERE id=? AND state=?',row.id,row.state),
  sql(env,"UPDATE hnd_flow_versions SET state='retired' WHERE flow_id=? AND state='published'",row.flow_id),
  sql(env,"UPDATE hnd_flow_versions SET state='published' WHERE id=?",row.id),
  sql(env,'INSERT INTO hnd_flow_publications VALUES (?,?,?,?,?,?) ON CONFLICT(flow_id) DO UPDATE SET version_id=excluded.version_id,revision=excluded.revision,approved_by=excluded.approved_by,owner_version=excluded.owner_version,published_at=excluded.published_at',row.flow_id,row.id,revision+1,actor.operator.id,actor.operator.version,Date.now())])
 return json({flowId:row.flow_id,versionId:row.id,revision:revision+1,approvedBy:actor.operator.id,liveRouting:false})
}
