import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { adminCommit as commit } from './access'
import { Fault, integer, json, text, type ObjectValue } from '../core'
import { administrator } from './access'
import { approvePlan, applyPlan } from './apply'
import { parseJson } from './model'
import { bulkPage, planPage, planPath, profilePage, templatePage, templatesPage } from './pages'
import { previewCsv } from './preview'
import { getPlan, getProfile, getTemplate, planResult } from './store'
import { previewTemplate, writeOverride, writeTemplate } from './templates'

const redirect=(location:string)=>new Response(null,{status:303,headers:{location,'cache-control':'no-store'}})
const list=(value:unknown)=>typeof value==='string'?value.split(',').map(v=>v.trim()).filter(Boolean):value
export async function adminDoor(request:Request,env:Bindings,actor:Session,data?:ObjectValue):Promise<Response|null> {
 const path=new URL(request.url).pathname,html=path.startsWith('/app/')
 if(!/^\/(?:api\/handset\/admin|app\/admin\/(?:bulk|templates))(?:\/|$)/.test(path))return null
 administrator(actor)
 const read=request.method==='GET',write=request.method==='POST'
 if(!read&&!write)throw new Fault('method_not_allowed',405)
 const api='/api/handset/admin',bulk=html?'/app/admin/bulk':api+'/bulk',templates=html?'/app/admin/templates':api+'/templates'
 if(read&&(path===bulk||path===api)){
  await commit(env,actor,'admin.read','installation','completed')
  return html?bulkPage(env):json({profiles:(await env.DB.prepare('SELECT * FROM hnd_admin_profiles ORDER BY kind,identity').all()).results,plans:(await env.DB.prepare('SELECT id,kind,status,cursor,created_at FROM hnd_admin_plans ORDER BY created_at DESC LIMIT 50').all()).results,externalEffects:false})
 }
 if(write&&data&&path===bulk+'/preview'){
  const result=await previewCsv(env,actor,data)
  return html?redirect(planPath(result.id)):json(result,201)
 }
 const planMatch=path.match(/^\/(?:api\/handset\/admin|app\/admin\/bulk)\/plans\/([^/]+)(?:\/(approve|apply))?$/)
 if(planMatch){
  const planId=text(planMatch[1],'planId')
  if(read&&!planMatch[2]){const plan=await getPlan(env.DB,planId);await commit(env,actor,'admin.read',plan.id,'completed');return html?planPage(plan):json(planResult(plan))}
  if(write&&data&&planMatch[2]){
   const value=html&&data.limit!==undefined?{...data,limit:integer(Number(data.limit),'limit',1,25)}:data
   const result=await(planMatch[2]==='approve'?approvePlan(env,actor,planId,value):applyPlan(env,actor,planId,value))
   return html?redirect(planPath(planId)):json(result)
  }
 }
 if(read&&path===templates){await commit(env,actor,'admin.read','installation','completed');return html?templatesPage(env):json({templates:(await env.DB.prepare('SELECT * FROM hnd_admin_templates ORDER BY name,id').all()).results})}
 if(write&&data&&path===templates){const result=await writeTemplate(env,actor,html?{...data,roleScope:list(data.roleScope),settings:parseJson(data.settings)}:data);return html?redirect('/app/admin/templates/'+result.id):json(result,201)}
 const templateMatch=path.match(/^\/(?:api\/handset\/admin|app\/admin)\/templates\/([^/]+)(?:\/(preview))?$/)
 if(templateMatch){
  const templateId=text(templateMatch[1],'templateId')
  if(read&&!templateMatch[2]){
   const t=await getTemplate(env.DB,templateId);await commit(env,actor,'admin.read',t.id,'completed')
   return html?templatePage(env,templateId):json({template:t,history:(await env.DB.prepare('SELECT * FROM hnd_admin_template_history WHERE template_id=? ORDER BY version').bind(t.id).all()).results})
  }
  if(write&&data){
   const value=html?{...data,version:Number(data.version),...(templateMatch[2]?{profileIds:list(data.profileIds)}:{roleScope:list(data.roleScope),settings:parseJson(data.settings)})}:data
   if(templateMatch[2]){const result=await previewTemplate(env,actor,templateId,value);return html?redirect(planPath(result.id)):json(result,201)}
   const result=await writeTemplate(env,actor,value,templateId)
   return html?redirect('/app/admin/templates/'+templateId):json(result)
  }
 }
 const profileMatch=path.match(/^\/(?:api\/handset\/admin|app\/admin\/bulk)\/profiles\/([^/]+)(?:\/(override))?$/)
 if(profileMatch){
  const profileId=text(profileMatch[1],'profileId')
  if(read&&!profileMatch[2]){const p=await getProfile(env.DB,profileId);await commit(env,actor,'admin.read',p.id,'completed');return html?profilePage(env,profileId):json(p)}
  if(write&&data&&profileMatch[2]){const result=await writeOverride(env,actor,profileId,html?{...data,version:Number(data.version),settings:parseJson(data.settings)}:data);return html?redirect('/app/admin/bulk/profiles/'+profileId):json(result)}
 }
 return null
}
