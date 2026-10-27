import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, consolePage, escape as e, hidden, json, owner, type ObjectValue } from '../core'
import { assignRole, roleSnapshot, saveRole } from './custom-roles'

async function view(env:Bindings,actor:Session,notice='',status=200){
 const {roles,members,people,prompts,flows}=await roleSnapshot(env,actor)
 const fields=(prefix:string,capabilities:string[]=[],selected:string[]=[],selectedFlows:string[]=[])=>`<label><input type="checkbox" name="draft" value="yes" ${capabilities.includes('greeting.draft')?'checked':''}>Edit greeting drafts</label>${['flow.read','flow.draft','flow.test'].map(cap=>`<label><input type="checkbox" name="${cap}" value="yes" ${capabilities.includes(cap)?'checked':''}>${cap==='flow.read'?'Read selected flows':cap==='flow.draft'?'Edit flow drafts':'Test selected flows'}</label>`).join('')}<fieldset><legend>Permitted flows</legend>${flows.map(f=>`<label><input type="checkbox" name="flow-${e(f.id)}" value="yes" ${selectedFlows.includes(f.id)?'checked':''}>${e(f.name)}</label>`).join('')||'<p>Create a flow before granting flow access.</p>'}</fieldset><fieldset><legend>Permitted greetings</legend>${prompts.map(p=>`<label><input type="checkbox" name="prompt-${e(p.id)}" value="yes" ${selected.includes(p.id)?'checked':''}>${e(p.name)}</label>`).join('')||'<p>Create a prompt before creating a role.</p>'}</fieldset><label><input type="checkbox" name="confirm" value="approve exact custom role" required>I approve this exact role and scope</label><button>${prefix}</button>`
 return consolePage('Custom role settings',`<link rel="stylesheet" href="/handset-flows.css"><p><a href="/app/prompts">Greetings and prompts</a></p><p>Assign active members to selected greetings and existing flows. Greeting access permits upload or recording of a draft. Flow read, draft and native test capabilities are separate. Flow access covers only queues, group members and exact prompt pins already referenced by that flow. Publication and role administration still require an owner. Owners separately review and approve the exact audio. Changing a role suspends its assignments until explicitly assigned again. Changing a person or issuing owner’s native authority also suspends access.</p>${notice?`<p role="alert">${e(notice)}</p>`:''}<section class="hnd-panel"><h2>Create custom role</h2><form method="post" action="/app/prompts/access">${hidden('revision',0)}<label>Role name<input name="name" required maxlength="80"></label>${fields('Create custom role',['greeting.draft'])}</form></section>${roles.map(r=>`<section class="hnd-panel"><h2>${e(r.name)}</h2><p>Revision ${r.revision}</p><form method="post" action="/app/prompts/access/${e(r.id)}">${hidden('revision',r.revision)}<label>Role name<input name="name" value="${e(r.name)}" required maxlength="80"></label>${fields('Save role revision',JSON.parse(r.capabilities),JSON.parse(r.prompt_ids),JSON.parse(r.flow_ids))}</form><h3>Assigned members</h3><ul>${members.filter(m=>m.role_id===r.id).map(m=>`<li>${e(m.display_name)} · ${e(m.state)}</li>`).join('')||'<li>No assigned members.</li>'}</ul><form method="post" action="/app/prompts/access/${e(r.id)}/assign">${hidden('revision',r.revision)}<label for="role-member-${e(r.id)}">Member</label><select id="role-member-${e(r.id)}" name="personChoice" required><option value="">Choose an active member</option>${people.map(p=>`<option value="${e(p.id)}:${p.version}">${e(p.display_name)}</option>`).join('')}</select><label><input type="checkbox" name="confirm" value="assign exact custom role" required>I approve this exact member and role revision</label><button>Assign custom role</button></form></section>`).join('')}`,status)
}

export async function roleDoor(request:Request,env:Bindings,actor:Session,v?:ObjectValue){
 const url=new URL(request.url),html=url.pathname.startsWith('/app/'),base=html?'/app/prompts/access':'/api/handset/prompts/access',path=url.pathname.slice(base.length)
 if(html&&actor.operator.role!=='owner')return consolePage('Custom roles need an owner','<p role="alert">Ask an owner to review roles and assignments.</p><p><a href="/app/prompts">Return to greeting drafts</a></p>',403)
 owner(actor)
 if(url.search)throw new Fault('unexpected_role_query')
 if(request.method==='GET'&&path==='')return html?view(env,actor):json(await roleSnapshot(env,actor))
 if(request.method!=='POST'||!v)throw new Fault('method_not_allowed',405)
 try{
  const match=path.match(/^\/([0-9a-f-]{36})(\/assign)?$/)
  if(path&&!match)throw new Fault('not_found',404)
  let body=v
  if(html){
   if(match?.[2]){const [personId,personVersion]=String(v.personChoice).split(':');body={personId,personVersion:Number(personVersion),revision:Number(v.revision),confirm:v.confirm}}
   else body={name:v.name,revision:Number(v.revision),capabilities:[...(v.draft==='yes'?['greeting.draft']:[]),...['flow.read','flow.draft','flow.test'].filter(cap=>v[cap]==='yes')],promptIds:Object.keys(v).filter(k=>k.startsWith('prompt-')&&v[k]==='yes').map(k=>k.slice(7)),flowIds:Object.keys(v).filter(k=>k.startsWith('flow-')&&v[k]==='yes').map(k=>k.slice(5)),confirm:v.confirm}
  }
  const result=match?.[2]?await assignRole(env,actor,body,match[1]):await saveRole(env,actor,body,match?.[1])
  return html?new Response(null,{status:303,headers:{location:base}}):json(result,match?.[2]?200:201)
 }catch(error){if(html&&error instanceof Fault)return view(env,actor,error.code.replaceAll('_',' '),error.status);throw error}
}
