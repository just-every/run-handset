import type { Bindings } from '../../auth.server'
import { needsFirstRun } from '../../base/setup'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { runtimeBindings } from '../../auth.server'
import { createImportOperatorHandler, readImportDoorHistory, writeImportDoorSettings } from '../../modules/import-kit/src/door/operator'
import { createImportDoorHandler } from '../../modules/import-kit/src/door/index'
import { DoorError } from '../../modules/import-kit/src/door/protocol'
import { session, owner, json, input, Fault, consolePage as page, ownerFence, id } from '../core'
import { claimConfig, installationId, ownerPredicate, runtime } from './context'
import { importSource, namespace } from './source'
import { importPage } from './pages'
import { doorClient, uploadForm } from './bridge'

async function event(env: Bindings, actor: Session, action: string) {
 await env.DB.batch([ownerFence(env.DB,actor),env.DB.prepare('INSERT INTO hnd_import_events(id,actor_id,action,occurred_at) VALUES(?,?,?,?)').bind(id(),actor.operator.id,action,Date.now()),env.DB.prepare('DELETE FROM hnd_guard')])
}
async function businessSettings(env: Bindings) {
 const setting=await env.DB.prepare('SELECT enabled FROM ik_door_settings WHERE installation_id=?').bind(installationId).first<{enabled:number}>()
 const revoked=(await env.DB.prepare('SELECT kid FROM ik_door_revoked_keys WHERE installation_id=? ORDER BY kid').bind(installationId).all<{kid:string}>()).results
 return {enabled:setting?.enabled===1,configured:claimConfig(env)!==null,revoked:revoked.map(r=>r.kid)}
}
function operatorHandler(env: Bindings) {
 return createImportOperatorHandler({...runtime(env),installationId,appOrigin:env.AUTH_ORIGIN,ownerEmail:env.OWNER_EMAIL,namespace,
  async authorize(request) {
   try { const {session:actor}=await session(request,env);owner(actor);return ownerPredicate(actor) }
   catch(error) { if (error instanceof Fault) return null; throw error }
  },
 })
}
export async function importResponse(request: Request, original: Bindings): Promise<Response | null> {
 const path=new URL(request.url).pathname
 if (!(path==='/app/import' || path.startsWith('/app/import/') || path.startsWith('/api/operator/import/') || path.startsWith('/api/rer/import/'))) return null
 const env=runtimeBindings(original),html=path.startsWith('/app/import')
 try {
  // A grant has independent authority; it must run before generic private-route rejection.
  if (path.startsWith('/api/rer/import/')) {
   const claim=claimConfig(env)
   if (!claim) return json({error:'not_found'},404)
   const {parse: _parse,mapping: _mapping,...options}=runtime(env)
   return await createImportDoorHandler({...options,claim,installationId,source:importSource})(request)
  }
  const auth=await session(request,env),actor=auth.session
  owner(actor)
  if (html && await needsFirstRun(env,actor)) return new Response(null,{status:303,headers:{location:'/setup','cache-control':'no-store'}})
  const source=html?namespace:request.headers.get('x-import-source')??''
  if (!importSource(source)) throw new Fault('unknown_import_source')
  const handle=operatorHandler(env),predicate=ownerPredicate(actor)
  if (!html && path!=='/api/operator/import/history' && path!=='/api/operator/import/settings') return handle(request)
  const history=()=>readImportDoorHistory(env.DB,installationId,predicate)
  if (request.method==='GET' && path==='/api/operator/import/history') return json({history:await history()})
  if (request.method==='GET' && path==='/app/import') return importPage(await history(),await businessSettings(env))
  if (request.method!=='POST') throw new Fault('method_not_allowed',405)
  const data=await input(request,html?6_500_000:65_536)
  const action=path.split('/').at(-1)!
  if (html && data.source!==undefined && data.source!==namespace) throw new Fault('unknown_import_source')
  if (action==='settings') {
   if (data.confirm!=='approve Business import settings') throw new Fault('explicit_import_consent_required')
   const enabled=data.enabled===true || data.enabled==='yes'
   if (enabled && !claimConfig(env)) throw new Fault('business_import_trust_unavailable',409)
   const revokeKid=typeof data.revokeKid==='string'?data.revokeKid.trim():''
   // Consent and its audit event commit together under the current owner predicate.
   await writeImportDoorSettings({prepare:q=>env.DB.prepare(q),batch:async statements=>{
    const result=await env.DB.batch([...statements as D1PreparedStatement[],env.DB.prepare('INSERT INTO hnd_import_events(id,actor_id,action,occurred_at) VALUES(?,?,?,?)').bind(id(),actor.operator.id,enabled?'business.enabled':'business.disabled',Date.now())]);return result.slice(0,-1)
   }},installationId,{enabled,...(revokeKid?{revokedKids:[revokeKid]}:{})},predicate)
   return html?importPage(await history(),await businessSettings(env),{settingsSaved:true}):json({settingsSaved:true})
  }
  if (!html) throw new Fault('not_found',404)
  const call=doorClient(request,handle)
  let result
  if (action==='upload') result=await uploadForm(data,call)
  else {
   if (!['apply','undo','status','reconcile'].includes(action)) throw new Fault('not_found',404)
   if (action==='apply' && !['I approve this exact fingerprint and these differences','I approve resuming this reviewed fingerprint'].includes(String(data.confirm))) throw new Fault('explicit_import_review_required')
   if (action==='undo' && !['I approve Undo and preserving later native edits','I approve cancelling this plan'].includes(String(data.confirm))) throw new Fault('explicit_undo_consent_required')
   if (['apply','undo'].includes(action)) await event(env,actor,action+'.requested')
   result=await call(action,{planId:data.planId,...(action==='apply'?{reviewedFingerprint:data.reviewedFingerprint}:{})})
   if (['apply','undo'].includes(action)) await event(env,actor,action+(result.response.ok?'.completed':'.refused'))
  }
  return importPage(await history(),await businessSettings(env),{...result.body,...(action==='apply'&&result.response.ok?{fingerprint:data.reviewedFingerprint}:{})},action==='upload'?'plan':action,result.response.status)
 } catch(error) {
  const known=error instanceof Fault || error instanceof DoorError,status=known?error.status:503,code=known?error.code:'import_unavailable'
  if (html && code==='unauthenticated' && request.method==='GET') return new Response(null,{status:303,headers:{location:'/signin?returnTo=%2Fapp%2Fimport','cache-control':'no-store'}})
  return html?page('Import request refused',`<p role="alert">${code.replaceAll('_',' ')}</p><p>No completion is claimed. Reload the current history before resuming.</p><a href="/app/import">Return to import history</a>`,status):json({error:code},status)
 }
}
