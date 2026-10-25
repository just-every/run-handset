import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { consolePage, escape as e, field, hidden, Fault, type ObjectValue } from '../core'
import { transcriptDoor } from './doors'

type Moment = {id:string;speaker:string;language:string;startMs:number;endMs:number;text:string;lowConfidence?:boolean}
type Annotation = {segment_id:string;kind:string;text:string;owner_id:string|null;due_state:string|null;due_at:number|null}
type Result = {id:string;recordingId:string;recordedAt:number;state:string;reason:string|null;provenance:string;segments:Moment[];annotations:Annotation[];revision:number;original:Moment[];corrections:{revision:number;segment_id:string;replacement:string;created_by:string;created_at:number}[];historyBounded:boolean;annotationsBounded:boolean}
const base='/app/transcripts'
const moment=(s:Moment)=>`${e(s.speaker)} · ${e(s.language)} · ${(s.startMs/1000).toFixed(1)}–${(s.endMs/1000).toFixed(1)} seconds`
const notice='<p>Owner-supplied text. Speech accuracy and capture consent are unqualified. Playback permission is separate.</p>'
export async function transcriptPage(request:Request,env:Bindings,actor:Session,value?:ObjectValue):Promise<Response>{
 const url=new URL(request.url),suffix=url.pathname.slice(base.length),api=new URL('/api/handset/transcripts'+suffix+url.search,url)
 for(const [key,val] of [...api.searchParams])if(val==='')api.searchParams.delete(key)
 if(request.method==='POST'){
  if(!/^\/[0-9a-f-]{36}\/corrections$/.test(suffix)||!value)throw new Fault('not_found',404)
  const response=await transcriptDoor(new Request(api,{method:'POST'}),env,actor,{...value,revision:Number(value.revision)})
  if(!response?.ok)throw new Fault('correction_unavailable',409)
  return new Response(null,{status:303,headers:{location:base+suffix.replace('/corrections',''),'cache-control':'no-store'}})
 }
 if(request.method!=='GET')throw new Fault('method_not_allowed',405)
 const response=await transcriptDoor(new Request(api),env,actor)
 if(!response)throw new Fault('not_found',404)
 if(!suffix){
  const result=await response.json() as {matches:Result[]}
  const cards=result.matches.map(item=>`<article><h2><a href="${base}/${e(item.id)}">${e(new Date(item.recordedAt).toISOString())}</a></h2><p>${e(item.provenance)}</p>${item.state==='missing'?`<p role="status">Missing transcript: ${e(item.reason)}</p>`:item.segments.map(s=>`<p><a href="${base}/${e(item.id)}#moment-${e(s.id)}">${moment(s)}</a>: ${e(s.text)}</p>`).join('')}<p>${item.annotations.length} cited annotations</p></article>`).join('')
  return consolePage('Transcript evidence search',notice+`<form method="get" action="${base}">${field('Search permitted text','q',url.searchParams.get('q')??'','search',false)}${field('From epoch milliseconds','from',url.searchParams.get('from')??'','number',false)}${field('Through epoch milliseconds','to',url.searchParams.get('to')??'','number',false)}${field('Number ID','numberId',url.searchParams.get('numberId')??'','text',false)}${field('Follow-up owner ID','ownerId',url.searchParams.get('ownerId')??'','text',false)}<button>Search transcripts</button></form><p role="status">${result.matches.length} permitted results. Searches inspect at most 50 currently granted recordings, with five matching moments per result.</p>${cards||'<p>No permitted matches.</p>'}`)
 }
 const item=await response.json() as Result
 const annotations=item.annotations.map(a=>`<li>${e(a.kind)}: ${e(a.text)} · cited moment ${e(a.segment_id)}${a.owner_id?` · Owner ${e(a.owner_id)} · ${e(a.due_state)}${a.due_at?` · ${e(new Date(a.due_at).toISOString())}`:''}`:''}</li>`).join('')
 const segments=item.segments.map(s=>`<article id="moment-${e(s.id)}"><h2>${moment(s)}</h2><p>${e(s.text)}</p>${s.lowConfidence?'<p role="status">Low confidence supplied text</p>':''}${actor.operator.role==='owner'?`<form method="post" action="${base}/${e(item.id)}/corrections">${hidden('segmentId',s.id)}${hidden('revision',item.revision)}<label>Correct ${e(s.language)} text<textarea name="text" required rows="3">${e(s.text)}</textarea></label><button>Save ${e(s.language)} correction</button></form>`:''}</article>`).join('')
 return consolePage('Transcript moments',`<p><a href="${base}">Return to transcript search</a></p>${notice}<p>${e(new Date(item.recordedAt).toISOString())} · Recording ${e(item.recordingId)}</p>${item.state==='missing'?`<p role="status">Missing transcript: ${e(item.reason)}</p><p>No commitments can be created from missing text.</p>`:segments}<h2>Cited follow-ups and annotations</h2><ul>${annotations||'<li>No cited annotations.</li>'}</ul><h2>Original supplied text</h2>${item.original.map(s=>`<p>${e(s.language)}: ${e(s.text)}</p>`).join('')}<h2>Correction history</h2><ol>${item.corrections.map(c=>`<li>Revision ${c.revision} · ${e(c.created_by)} · ${e(new Date(c.created_at).toISOString())}: ${e(c.replacement)}</li>`).join('')||'<li>No corrections.</li>'}</ol>${item.historyBounded||item.annotationsBounded?'<p role="status">History display is bounded to the latest 200 entries.</p>':''}`)
}
