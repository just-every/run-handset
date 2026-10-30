import { deliveryItemForms, type DeliveryView } from './delivery-pages'
import { consolePage, escape as e, field, hidden, type ObjectValue } from '../core'
import type { Item, ListedBox, MailboxView } from './doors'

export type Refusal={code:string;status:number;values:ObjectValue;action:string}
const base='/app/voicemail'
const boxPath=(id:string)=>base+'/'+encodeURIComponent(id)
const form=(action:string,label:string,body='')=>`<form method="post" action="${e(action)}">${body}<button>${e(label)}</button></form>`
const select=(label:string,name:string,options:[string,string][],value:unknown='')=>`<label>${e(label)}<select aria-label="${e(label)}" name="${e(name)}" required>${options.map(([v,l])=>`<option value="${e(v)}"${v===value?' selected':''}>${e(l)}</option>`).join('')}</select></label>`
const area=(label:string,name:string,value:unknown='',max=2000)=>`<label>${e(label)}<textarea aria-label="${e(label)}" name="${e(name)}" rows="4" maxlength="${max}" required>${e(value)}</textarea></label>`
const kind=(v:string)=>v==='personal'?'Personal · Private':v==='group'?'Group':'Shared'
const state=(item:Item)=>item.state==='handled'?'Handled':'Open'
const name=(view:MailboxView,id:string|null)=>id?view.people.find(p=>p.id===id)?.display_name??'Former mailbox member':'Unclaimed'
const qualification='<p>Supplied observations only. Capture and transcription are unqualified; audio playback, scheduled greetings and notices are unavailable.</p>'
function refusalView(refusal?:Refusal,current?:number){
 if(!refusal)return ''
 return `<section role="alert"><h2>Action refused</h2><p>${e(refusal.code.replaceAll('_',' '))}. Your draft is retained beside the current history. Compare before submitting a fresh revision, or reload the mailbox.</p>${refusal.values.revision!==undefined?`<p>Submitted revision: ${e(refusal.values.revision)} · Current revision: ${e(current??'unavailable')}</p>`:''}</section>`
}
export function mailboxUnavailable(status=403,reload=base){
 return consolePage('Mailbox unavailable',`<p role="alert">${status>=500?'Mailbox could not be loaded. Reload to try again.':'You no longer have access to this mailbox.'}</p><p><a href="${e(reload)}">Reload mailbox</a> · <a href="${base}">Return to voicemail</a></p>`,status)
}
export function mailboxList(boxes:ListedBox[],settings=false){
 const rows=boxes.filter(b=>!settings||b.capabilities.admin)
 return consolePage(settings?'Mailbox settings':'Voicemail',`<nav><a href="${base}">Voicemail</a><a href="${base}/settings">Mailbox settings</a></nav>${settings?`<p><a href="${base}/settings/new">New mailbox</a></p>`:''}<section><h2>${settings?'Manage mailboxes':'Your mailboxes'}</h2>${rows.length?`<ul>${rows.map(b=>`<li><a href="${settings?base+'/settings/'+encodeURIComponent(b.id):boxPath(b.id)}">${e(b.name)}</a><p>${kind(b.kind)} · <span>${e(b.dueCount)} due</span>${b.capabilities.work?'':' · Read only'}</p></li>`).join('')}</ul>`:`<p>${settings?'No shared mailboxes to administer.':'No mailboxes available.'}</p><a href="${base}/settings/new">Create a personal mailbox</a>`}</section>`)
}
export function mailboxCreate(isOwner:boolean,refusal?:Refusal){
 const raw=refusal?.values??{}
 return consolePage('New mailbox',`<nav><a href="${base}/settings">Mailbox settings</a></nav>${refusalView(refusal)}<section><h2>Create a mailbox</h2><p>Personal boxes are private and cannot be shared. Shared and group boxes require explicit readership and work permissions.</p>${form(base+'/settings/new','Create mailbox',field('Mailbox name','name',String(raw.name??''))+select('Mailbox kind','kind',isOwner?[['personal','Personal'],['shared','Shared'],['group','Group']]:[['personal','Personal']],raw.kind??'personal'))}</section>`,refusal?.status??200)
}
function observationForm(view:MailboxView,refusal?:Refusal){
 if(!view.capabilities.observe)return ''
 const raw=refusal?.action==='observations'?refusal.values:{}
 return `<details${refusal?.action==='observations'?' open':''}><summary>Add supplied observation</summary><p>Enter previously supplied text. This does not capture audio, transcribe speech or authorize contact.</p>${form(boxPath(view.box.id)+'/observations','Add observation',field('Source reference','sourceId',String(raw.sourceId??''))+area('Observation text','text',raw.text,10000)+select('Observation language','language',[['en','English'],['es','Spanish']],raw.language??'en'))}</details>`
}
function history(view:MailboxView,item?:Item){
 const entries=view.history.filter(h=>!item||h.item_id===item.id)
 return `<section><h2>Retained history</h2>${entries.length?`<ol>${entries.map(h=>`<li><strong>${e(h.action)}</strong> · ${e(name(view,h.actor))} · ${e(new Date(h.created_at).toISOString())} · Revision ${e(h.revision)}${h.note?`<p>${e(h.note)}</p>`:''}</li>`).join('')}</ol>`:'<p>No history yet.</p>'}</section>`
}
function observations(view:MailboxView,refusal?:Refusal){
 const path=boxPath(view.box.id),due=view.items.filter(i=>view.due.includes(i.id)),handled=view.items.filter(i=>i.state==='handled')
 const list=(items:Item[])=>`<ul>${items.map(i=>`<li><strong>${e(i.observation)}</strong><p>${i.language==='es'?'Spanish':'English'} · ${state(i)} · ${e(name(view,i.claimant))}</p><a href="${path}/items/${encodeURIComponent(i.id)}">Open observation</a></li>`).join('')}</ul>`
 return `<section><h2>Due observations</h2>${due.length?list(due):'<p>No due observations.</p>'}${observationForm(view,refusal)}</section>${handled.length?`<section><details><summary>Handled observations</summary>${list(handled)}</details></section>`:''}`
}
export function mailboxDetail(view:MailboxView,itemId?:string,refusal?:Refusal,delivery?:DeliveryView){
 const {box,capabilities:caps}=view,path=boxPath(box.id),item=itemId?view.items.find(i=>i.id===itemId):undefined
 if(itemId&&!item)return consolePage('Observation unavailable',`<p role="alert">This observation is not in the current mailbox.</p><a href="${path}">Reload mailbox</a>`,404)
 const actions=item?itemActions(view,item,refusal):''
 const content=item?`<section><h2>Supplied observation</h2><p>${e(item.observation)}</p><p>${item.language==='es'?'Spanish':'English'} · <span>${state(item)}</span> · ${e(name(view,item.claimant))} · Revision ${e(item.revision)}</p><details><summary>Source reference</summary><p>${e(item.source_id)}</p></details>${actions}</section>${deliveryItemForms(view,item.id,delivery)}`:observations(view,refusal)
 return consolePage(box.name,`<nav><a href="${base}">All mailboxes</a>${item?`<a href="${path}">Mailbox observations</a>`:''}<a href="${path}${item?'/items/'+encodeURIComponent(item.id):''}">Reload mailbox</a>${box.owner_id===view.actorId?`<a href="${base}/settings/${encodeURIComponent(box.id)}/delivery">Delivery settings</a>`:''}${caps.admin?`<a href="${base}/settings/${encodeURIComponent(box.id)}">Mailbox settings</a>`:''}</nav><p role="status">${kind(box.kind)} · <span>${view.due.length} due</span> · Box owner: ${e(name(view,box.owner_id))}</p>${qualification}${refusalView(refusal,item?.revision??box.revision)}${content}${history(view,item)}`,refusal?.status??200)
}
function itemActions(view:MailboxView,item:Item,refusal?:Refusal){
 const path=boxPath(view.box.id)+'/items/'+encodeURIComponent(item.id),caps=view.capabilities
 const reconcile=refusal?.action==='note'&&refusal.status===409
 const revision=(action:string)=>hidden('revision',refusal?.action===action&&!reconcile?refusal.values.revision:item.revision)
 const raw=(action:string)=>refusal?.action===action?refusal.values:{}
 const canHandle=caps.work&&(item.claimant===view.actorId||view.box.owner_id===view.actorId)
 return `${caps.work&&item.state==='open'&&!item.claimant?form(path+'/claim','Claim item',revision('claim')):''}${canHandle?form(path+(item.state==='open'?'/handle':'/reopen'),item.state==='open'?'Mark handled':'Reopen item',revision(item.state==='open'?'handle':'reopen')):''}${caps.work?`<details${refusal?.action==='note'?' open':''}><summary>Add a note</summary>${form(path+'/note','Add note',revision('note')+area('Note','note',raw('note').note)+(reconcile?'<label><input type="checkbox" name="confirm" value="compared current history" required> I compared my draft with the current history</label>':''))}</details>`:''}${caps.assign&&item.state==='open'?`<details${refusal?.action==='assign'?' open':''}><summary>Assignment</summary>${form(path+'/assign','Assign item',revision('assign')+select('Assign to','personId',view.people.filter(p=>p.can_work).map(p=>[p.id,p.display_name]),raw('assign').personId??item.claimant))}</details>`:''}`
}
export function mailboxSettings(view:MailboxView,refusal?:Refusal){
 const {box}=view,path=base+'/settings/'+encodeURIComponent(box.id),raw=refusal?.values??{}
 return consolePage('Mailbox settings',`<nav><a href="${base}/settings">All mailbox settings</a><a href="${boxPath(box.id)}">${e(box.name)}</a></nav>${refusalView(refusal,box.revision)}<section><h2>${e(box.name)}</h2><p>Readership, work and assignment are separate. Only the original mailbox administrator can change membership. Personal mailboxes cannot be shared.</p><ul>${view.people.map(p=>`<li>${e(p.display_name)} · ${p.can_work?'Work':'Read only'}${p.can_assign?' · Assignment':''}${p.is_owner?' · Box owner':''}<details><summary>Person reference</summary><p>${e(p.id)}</p></details>${p.id!==box.admin_id?form(path+'/members','Withdraw member',hidden('revision',box.revision)+hidden('personId',p.id)+hidden('enabled',0)):''}</li>`).join('')}</ul></section><section><h2>Add or update membership</h2>${form(path+'/members','Add or update member',hidden('revision',refusal?.action==='members'?raw.revision:box.revision)+hidden('enabled',1)+field('Person reference','personId',String(raw.personId??''))+select('Readership and work','capability',[['read','Read only'],['work','Read and work'],['assign','Read and assign'],['work_assign','Read, work and assign']],raw.capability??'read'))}</section><section><h2>Designate box owner</h2><p>The designated owner must be a current worker in this exact box. This grants no membership administration.</p>${form(path+'/owner','Set box owner',hidden('revision',refusal?.action==='owner'?raw.revision:box.revision)+select('Box owner','personId',view.people.filter(p=>p.can_work).map(p=>[p.id,p.display_name]),raw.personId??box.owner_id))}</section>`,refusal?.status??200)
}
