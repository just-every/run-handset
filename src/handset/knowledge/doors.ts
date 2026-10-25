import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { choice, Fault, id, integer, json, keys, owner, text, type ObjectValue } from '../core'
import { extracted, fetchSource, type Provider } from './sources'
import { expireKnowledge } from './retention'
import { processingDoor } from './processing'

interface Source { id:string; provider:Provider; external_id:string; cloud_id:string; title:string; revision:number; source_revision:string; citation:string; body:string; state:string; owner_id:string; owner_version:number; refreshed_at:number; expires_at:number }
const root = '/api/handset/knowledge'
const freshFor = 15 * 60000
const projection = (s:Source) => ({ id:s.id, provider:s.provider, externalId:s.external_id, title:s.title, revision:s.revision, sourceRevision:s.source_revision, citation:s.citation, state:s.state, refreshedAt:s.refreshed_at, expiresAt:s.expires_at })
const current = (db:D1Database,id:string) => db.prepare('SELECT * FROM hnd_knowledge_sources WHERE id=?').bind(id).first<Source>()
function fence(db:D1Database,s:Source) { return db.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_knowledge_sources WHERE id=? AND revision=? AND state=?').bind(s.id,s.revision,s.state) }
async function clear(env:Bindings,actor:Session,s:Source,state:string) {
 await commit(env,actor,'knowledge.change',s.id,'completed',[fence(env.DB,s),env.DB.prepare("UPDATE hnd_knowledge_sources SET body='',state=?,revision=revision+1,expires_at=0 WHERE id=?").bind(state,s.id)])
}
export async function knowledgeDoor(request:Request,env:Bindings,actor:Session,v?:ObjectValue):Promise<Response|null> {
 const url=new URL(request.url),path=url.pathname
 if(path!==root&&!path.startsWith(root+'/'))return null
 owner(actor)
 if(url.search)throw new Fault('not_found',404)
 const db=env.DB,action=path.slice(root.length)
 await expireKnowledge(env)
 const processing=await processingDoor(request,env,actor,v)
 if(processing)return processing
 if(request.method==='GET'&&!action){
  const rows=(await db.prepare('SELECT * FROM hnd_knowledge_sources ORDER BY title,id LIMIT 100').all<Source>()).results
  await commit(env,actor,'knowledge.read','installation','completed')
  return json({sources:rows.map(projection),modelProcessing:false})
 }
 if(request.method!=='POST'||!v)throw new Fault('method_not_allowed',405)
 if(action==='/search') {
  keys(v,['query','sourceIds'])
  const query=text(v.query,'query',200).toLocaleLowerCase()
  if(!Array.isArray(v.sourceIds)||!v.sourceIds.length||v.sourceIds.length>20)throw new Fault('knowledge_select_sources')
  const ids=[...new Set(v.sourceIds.map(value=>text(value,'sourceId',80)))], rows:Source[]=[]
  for(const sourceId of ids){ const s=await current(db,sourceId); if(s&&s.state==='active'&&s.expires_at>Date.now()&&s.owner_id===actor.operator.id&&s.owner_version===actor.operator.version)rows.push(s) }
  const matches=rows.filter(s=>s.body.toLocaleLowerCase().includes(query)).map(s=>({...projection(s),text:s.body,trust:'untrusted_source_data',mayInvokeTools:false}))
  await commit(env,actor,'knowledge.read','installation','completed',rows.flatMap(s=>[fence(db,s),db.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_knowledge_sources WHERE id=? AND expires_at>? AND owner_id=? AND owner_version=?').bind(s.id,Date.now(),actor.operator.id,actor.operator.version)]))
  // No model call or outbound action is authorized by source content or this read.
  return json({matches,state:matches.length?'found':'knowledge_gap',modelProcessing:false})
 }
 if(!action){
  keys(v,['provider','externalId','cloudId','title','credential','content','mediaType','confirm'])
  if(v.confirm!=='authorize this source for owner retrieval')throw new Fault('knowledge_consent_required',403)
  const provider=choice(v.provider,['notion','confluence','google-drive','upload'] as const,'provider'),sourceId=id(),title=text(v.title,'title',120),externalId=provider==='upload'?'':text(v.externalId,'externalId',128),cloudId=provider==='confluence'?text(v.cloudId,'cloudId',80):''
  let content:{body:string;sourceRevision:string;citation:string}
  if(provider==='upload'){
   if(!['text/plain','text/markdown'].includes(String(v.mediaType)))throw new Fault('knowledge_unsupported_document',415)
   content={body:extracted(v.content),sourceRevision:'1',citation:'upload:'+sourceId}
  }else content=await fetchSource(provider,externalId,text(v.credential,'credential',4000),cloudId)
  const now=Date.now()
  await commit(env,actor,'knowledge.change',sourceId,'completed',[db.prepare("INSERT INTO hnd_knowledge_sources VALUES (?,?,?,?,?,1,?,?,?,'active',?,?,?,?)").bind(sourceId,provider,externalId,cloudId,title,content.sourceRevision,content.citation,content.body,actor.operator.id,actor.operator.version,now,now+freshFor)])
  return json(projection((await current(db,sourceId))!),201)
 }
 const match=action.match(/^\/([0-9a-f-]{36})\/(refresh|revoke|erase)$/)
 if(!match)throw new Fault('not_found',404)
 const s=await current(db,match[1]);if(!s)throw new Fault('knowledge_source_not_found',404)
 if(match[2]!=='refresh'){
  keys(v,['revision','confirm'])
  if(integer(v.revision,'revision',1)!==s.revision)throw new Fault('knowledge_source_changed',409)
  if(v.confirm!==(match[2]==='revoke'?'revoke this source':'erase this source'))throw new Fault('knowledge_consent_required',403)
  await clear(env,actor,s,match[2]==='revoke'?'revoked':'erased')
  return json(projection((await current(db,s.id))!))
 }
 keys(v,['revision','credential','content','mediaType','confirm'])
 if(integer(v.revision,'revision',1)!==s.revision||s.state==='revoked'||s.state==='erased')throw new Fault('knowledge_source_changed',409)
 if(s.owner_id!==actor.operator.id||s.owner_version!==actor.operator.version)throw new Fault('knowledge_fresh_consent_required',403)
 if(v.confirm!=='authorize this source for owner retrieval')throw new Fault('knowledge_consent_required',403)
 let content:{body:string;sourceRevision:string;citation:string}
 try {
  if(s.provider==='upload'){
   if(!['text/plain','text/markdown'].includes(String(v.mediaType)))throw new Fault('knowledge_unsupported_document',415)
   content={body:extracted(v.content),sourceRevision:String(s.revision+1),citation:s.citation}
  }else content=await fetchSource(s.provider,s.external_id,text(v.credential,'credential',4000),s.cloud_id)
 }catch(error){await clear(env,actor,s,'unavailable');throw error}
 const now=Date.now()
 await commit(env,actor,'knowledge.change',s.id,'completed',[fence(db,s),db.prepare("UPDATE hnd_knowledge_sources SET body=?,source_revision=?,citation=?,revision=revision+1,state='active',refreshed_at=?,expires_at=? WHERE id=?").bind(content.body,content.sourceRevision,content.citation,now,now+freshFor,s.id)])
 return json(projection((await current(db,s.id))!))
}
