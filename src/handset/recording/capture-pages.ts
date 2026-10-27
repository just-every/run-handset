import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { consolePage, escape as e, field, hidden, Fault, type ObjectValue } from '../core'
import { captureDoor } from './capture-doors'

type CaptureSession = {
 id:string;call_id:string;state:string;revision:number;jurisdiction:string;participants:string
 announced_revision:number|null;recording_sid:string|null;retain_until:number|null;hold:number
}
type CaptureCall = {id:string;name:string}
const base='/app/recordings/capture',api='/api/handset/recordings/capture'
const review='review exact call participants',announce='I heard the announcement finish for these exact participants'
const start='start this consented recording',retention='review this exact retention and hold'
const erase='erase this exact recording and supplied text'
const confirm=(value:string,label:string)=>`<label><input type="checkbox" name="confirm" value="${e(value)}" required> ${e(label)}</label>`
function participantFields(jurisdiction='unknown',participants='[]') {
 const current=JSON.parse(participants) as {id:string;consent:string}[]
 const rows=[...current,...Array.from({length:Math.max(1,2-current.length)},()=>({id:'',consent:'unknown'}))]
 return `<label for="capture-jurisdiction">Participant jurisdiction policy</label><select id="capture-jurisdiction" name="jurisdiction"><option value="unknown"${jurisdiction==='unknown'?' selected':''}>Unknown jurisdiction — capture blocked</option><option value="all-party"${jurisdiction==='all-party'?' selected':''}>Reviewed all-party policy</option></select><p>Review every participant. A refusal or unknown consent blocks capture. Include a new participant before recording them.</p>${rows.map((p,i)=>`<fieldset><legend>Participant ${i+1}${i>=2?' (optional additional participant)':''}</legend>${field('Participant '+(i+1)+' reference','participant'+i,p.id,'text',i<2)}<label for="capture-consent-${i}">Participant ${i+1} consent</label><select id="capture-consent-${i}" name="consent${i}">${['unknown','yes','no'].map(c=>`<option value="${c}"${p.consent===c?' selected':''}>${c==='yes'?'Explicit consent':c==='no'?'Refused':'Unknown'}</option>`).join('')}</select></fieldset>`).join('')}`
}
const announcementBoundary='<p>Audio announcement is unqualified. A human must hear the recording and AI disclosure finish for these exact participants. Saving an attestation does not play audio or prove anyone heard it.</p>'
const rights='<p>Capture permission grants no playback, download or transcript access. Existing exact-person recording approvals remain separate.</p>'
function form(s:CaptureSession,action:string,label:string,body='') {
 return `<form method="post" action="${base}/${e(s.id)}/${action}">${hidden('revision',s.revision)}${body}<button>${e(label)}</button></form>`
}
function status(s:CaptureSession) {
 const descriptions:Record<string,string>={
  blocked:'Capture is blocked. Unknown jurisdiction, refusal or missing consent cannot authorize recording.',
  ready:'Capture is ready for consent review and a human announcement attestation. Capture has not started.',
  capturing:'The provider reported capture in progress. This control observation does not qualify the audible consent boundary or captured media.',
  paused:'The provider reported capture paused. A fresh human announcement attestation is required before resuming. Real audio, model feeds, streams and downstream copies remain unqualified.',
  stopped:'The provider reported capture stopped. Completion and available media require their own provider evidence.',
  uncertain:'The provider outcome is uncertain. Do not assume capture started, paused, resumed or stopped. Review the provider state before proceeding.',
  erasing:'Erasure is pending. Do not treat provider media or supplied text as erased until completion is confirmed.',
  erased:'The explicit erasure operation completed. Delivered or downloaded external copies cannot be recalled.',
 }
 return `<p role="status">Capture state: ${e(s.state)}. ${e(descriptions[s.state]??'Capture state needs review.')}</p>`
}
function controls(s:CaptureSession) {
 let html=''
 if(['ready','paused'].includes(s.state)) {
  html+=`<section><h2>Announcement boundary</h2>${announcementBoundary}${form(s,'announcement','Record human announcement attestation',confirm(announce,announce))}</section>`
  const action=s.state==='paused'?'resume':'start'
  html+=form(s,action,action==='resume'?'Resume consented recording':'Start consented recording',confirm(start,'I approve capture for this exact consented participant set'))
  if(s.announced_revision!==s.revision)html+='<p>Starting or resuming is refused until the human announcement attestation matches this revision.</p>'
 }
 if(s.state==='capturing')html+=form(s,'pause','Pause sensitive capture')
 if(['capturing','paused'].includes(s.state))html+=form(s,'stop','Stop recording')
 return html
}
function settings(s:CaptureSession) {
 if(['uncertain','erasing','erased'].includes(s.state))return ''
 const consent=['ready','blocked','capturing','paused','stopped'].includes(s.state)?`<h3>Exact participant review</h3>${form(s,'consent','Save participant consent',participantFields(s.jurisdiction,JSON.stringify(JSON.parse(s.participants),null,2))+confirm(review,'I reviewed these exact call participants and their consent'))}`:''
 const retainUntil=s.retain_until===null?'':new Date(s.retain_until).toISOString().slice(0,16)
 const retain=`<h3>Retention and legal hold</h3><p>Retention dates record an explicit review. They do not schedule automatic deletion. A legal hold refuses erasure.</p>${form(s,'retention','Save retention and hold',field('Retain until (UTC; blank keeps no scheduled end)','retainUntil',retainUntil,'datetime-local',false)+`<label><input type="checkbox" name="hold" value="yes"${s.hold?' checked':''}> Keep a legal hold on this recording</label>`+confirm(retention,'I reviewed this exact retention date and legal hold'))}`
 const erasure=s.state==='stopped'?`<h3>Explicit erasure</h3>${s.hold?'<p role="status">Legal hold is active. Erasure is refused.</p><button disabled>Erase recording and supplied text</button>':form(s,'erase','Erase recording and supplied text',confirm(erase,'I approve irreversible erasure of this exact recording and supplied text'))}`:''
 return `<details class="hs-tertiary"><summary>Settings: capture consent and retention</summary>${consent}${retain}${erasure}</details>`
}
async function read(request:Request,env:Bindings,actor:Session,path:string) {
 const response=await captureDoor(new Request(new URL(path,request.url)),env,actor)
 if(!response)throw new Fault('not_found',404)
 return response
}
function formValue(value:ObjectValue,action:string|undefined):ObjectValue {
 const v={...value}
 if(action)v.revision=Number(v.revision)
 if(!action||action==='consent') {
  const participants=[]
  for(let i=0;i<33;i++){
   if(v['participant'+i]===undefined)break
   const participant=v['participant'+i],consent=v['consent'+i]
   if(typeof participant!=='string')throw new Fault('invalid_participant')
   if(participant.trim())participants.push({id:participant.trim(),consent})
   delete v['participant'+i];delete v['consent'+i]
  }
  v.participants=participants
 }
 if(action==='retention') {
  if(typeof v.retainUntil!=='string')throw new Fault('invalid_retainUntil')
  v.retainUntil=v.retainUntil===''?null:Date.parse(v.retainUntil+'Z')
  if(v.retainUntil!==null&&!Number.isFinite(v.retainUntil))throw new Fault('invalid_retainUntil')
  v.hold=v.hold==='yes'
 }
 return v
}
export async function capturePage(request:Request,env:Bindings,actor:Session,value?:ObjectValue):Promise<Response|null> {
 const path=new URL(request.url).pathname
 const match=path.match(/^\/app\/recordings\/capture(?:\/([0-9a-f-]{36})(?:\/(consent|announcement|start|pause|resume|stop|retention|erase))?)?$/)
 if(!match)return null
 if(actor.operator.role!=='owner')return consolePage('Recording permission required','<p role="alert">Recording permission refused. Only an owner can review participants or control recording capture.</p><button disabled>Review recording capture</button><p><a href="/app/recordings">Return to recordings</a></p>',403)
 const [,sessionId,action]=match
 if(request.method==='POST') {
  if(sessionId&&!action||!value)throw new Fault('not_found',404)
  const response=await captureDoor(new Request(new URL(api+(sessionId?'/'+sessionId+'/'+action:''),request.url),{method:'POST'}),env,actor,formValue(value,action))
  if(!response)throw new Fault('not_found',404)
  if(!response.ok)return response
  const result=await response.json() as {session:CaptureSession}
  return new Response(null,{status:303,headers:{location:base+'/'+result.session.id,'cache-control':'no-store'}})
 }
 if(request.method!=='GET'||action)throw new Fault('not_found',404)
 const response=await read(request,env,actor,api+(sessionId?'/'+sessionId:''))
 if(!response.ok)return response
 if(!sessionId) {
  const {sessions,calls}=await response.json() as {sessions:CaptureSession[];calls:CaptureCall[]}
  const create=calls.length?`<form method="post" action="${base}"><label for="capture-call">Native call</label><select id="capture-call" name="callId">${calls.map(c=>`<option value="${e(c.id)}">${e(c.name)} · ${e(c.id)}</option>`).join('')}</select>${participantFields()}${confirm(review,'I reviewed these exact call participants and their consent')}<button>Review capture session</button></form>`:'<p>No native calls are available for capture review.</p><button disabled>Review capture session</button>'
  return consolePage('Recording capture',`<p><a href="/app/recordings">Return to recordings</a></p>${rights}<h2>Review a call</h2>${create}<h2>Capture sessions</h2><ul>${sessions.map(s=>`<li><a href="${base}/${e(s.id)}">Review capture ${e(s.id)}</a> · ${e(s.state)} · revision ${s.revision}</li>`).join('')||'<li>No capture sessions.</li>'}</ul>`)
 }
 const {session:s}=await response.json() as {session:CaptureSession}
 return consolePage('Capture review',`<p><a href="${base}">Return to capture sessions</a></p>${status(s)}<dl><dt>Call</dt><dd>${e(s.call_id)}</dd><dt>Revision</dt><dd>${s.revision}</dd><dt>Jurisdiction policy</dt><dd>${e(s.jurisdiction)}</dd><dt>Participants and consent</dt><dd><ul>${(JSON.parse(s.participants) as {id:string;consent:string}[]).map(p=>`<li>${e(p.id)} · ${e(p.consent)}</li>`).join('')}</ul></dd><dt>Human announcement revision</dt><dd>${s.announced_revision===null?'Not attested':s.announced_revision}</dd><dt>Legal hold</dt><dd>${s.hold?'Active':'No hold'}</dd><dt>Retention review</dt><dd>${s.retain_until===null?'No scheduled end':e(new Date(s.retain_until).toISOString())}</dd></dl>${rights}${controls(s)}${settings(s)}`)
}
