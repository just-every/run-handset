import { choice, Fault, integer, keys, object, text, timestamp } from '../core'

export const formulaVersion = 'queue-formulas-v1'
export const agentStates = ['available','ringing','talk','hold','wrap','break','unavailable','logged-out'] as const
export interface Entry {
 id:string; callId:string; queueId:string; kind:'inbound'|'transfer'|'overflow'|'callback'; parentEntryId?:string
 enteredAt:number; answeredAt?:number; abandonedAt?:number; closedAt?:number
 talkSeconds:number; holdSeconds:number; wrapSeconds:number; agentId?:string
}
export interface Segment { id:string; agentId:string; startAt:number; endAt:number; state:typeof agentStates[number]; offerOutcome?:'answered'|'missed' }
export interface Dataset { id:string; name:string; entries:Entry[]; agents:Segment[] }
export interface Config { repeatWindowHours:number; queueId:string; revision:number; targetSeconds:number; shortSeconds:number; method:'exclude-abandons'|'include-abandons'; excludeShort:boolean; startAt:number; endAt:number; timezone:string }
const list=(value:unknown,name:string,max:number)=>{if(!Array.isArray(value)||value.length>max)throw new Fault('invalid_'+name);return value}
export function parseEntry(value:unknown):Entry {
 const v=object(value)
 keys(v,['id','callId','queueId','kind','parentEntryId','enteredAt','answeredAt','abandonedAt','closedAt','talkSeconds','holdSeconds','wrapSeconds','agentId'])
 const entry:Entry={id:text(v.id,'entryId'),callId:text(v.callId,'callId'),queueId:text(v.queueId,'queueId'),kind:choice(v.kind,['inbound','transfer','overflow','callback'],'entryKind'),enteredAt:timestamp(v.enteredAt,'enteredAt'),talkSeconds:integer(v.talkSeconds??0,'talkSeconds',0,86400),holdSeconds:integer(v.holdSeconds??0,'holdSeconds',0,86400),wrapSeconds:integer(v.wrapSeconds??0,'wrapSeconds',0,86400)}
 for(const name of ['answeredAt','abandonedAt','closedAt'] as const)if(v[name]!==undefined)entry[name]=timestamp(v[name],name)
 for(const name of ['agentId','parentEntryId'] as const)if(v[name]!==undefined)entry[name]=text(v[name],name)
 if(entry.answeredAt!==undefined&&entry.abandonedAt!==undefined)throw new Fault('answered_and_abandoned')
 const outcome=entry.answeredAt??entry.abandonedAt
 if(outcome!==undefined&&outcome<entry.enteredAt||entry.closedAt!==undefined&&(outcome===undefined||entry.closedAt<outcome))throw new Fault('invalid_entry_timeline')
 if(entry.abandonedAt!==undefined&&entry.closedAt===undefined)throw new Fault('abandoned_entry_requires_close')
 if(entry.answeredAt===undefined&&(entry.talkSeconds+entry.holdSeconds+entry.wrapSeconds>0)||entry.closedAt!==undefined&&entry.answeredAt!==undefined&&entry.talkSeconds+entry.holdSeconds+entry.wrapSeconds>(entry.closedAt-entry.answeredAt)/1000)throw new Fault('invalid_handled_components')
 if(entry.kind!=='inbound'&&!entry.parentEntryId)throw new Fault('parent_entry_required')
 return entry
}
export function parseSegment(value:unknown):Segment {
 const v=object(value);keys(v,['id','agentId','startAt','endAt','state','offerOutcome'])
 const segment:Segment={id:text(v.id,'segmentId'),agentId:text(v.agentId,'agentId'),startAt:timestamp(v.startAt,'startAt'),endAt:timestamp(v.endAt,'endAt'),state:choice(v.state,agentStates,'agentState')}
 if(segment.endAt<=segment.startAt)throw new Fault('invalid_segment_interval')
 if(v.offerOutcome!==undefined){segment.offerOutcome=choice(v.offerOutcome,['answered','missed'] as const,'offerOutcome');if(segment.state!=='ringing')throw new Fault('offer_outcome_requires_ringing')}
 return segment
}
export function validateCorrelation(entries:Entry[],segments:Segment[]) {
 const ids=new Map(entries.map(e=>[e.id,e]))
 if(ids.size!==entries.length||new Set(segments.map(s=>s.id)).size!==segments.length)throw new Fault('duplicate_metric_identity')
 for(const e of entries)if(e.parentEntryId){const parent=ids.get(e.parentEntryId);if(!parent||parent.callId!==e.callId||parent.enteredAt>e.enteredAt||e.kind==='inbound'||e.kind!=='callback'&&parent.queueId===e.queueId||parent.id===e.id)throw new Fault('invalid_queue_correlation')}
 for(const start of entries){const seen=new Set<string>();let e:Entry|undefined=start;while(e){if(seen.has(e.id))throw new Fault('cyclic_queue_correlation');seen.add(e.id);e=e.parentEntryId?ids.get(e.parentEntryId):undefined}}
 const ordered=[...segments].sort((a,b)=>a.agentId.localeCompare(b.agentId)||a.startAt-b.startAt)
 for(let i=1;i<ordered.length;i++)if(ordered[i].agentId===ordered[i-1].agentId&&ordered[i].startAt<ordered[i-1].endAt)throw new Fault('overlapping_agent_states')
}
export function parseDataset(value:unknown):Dataset {
 const v=object(value);keys(v,['id','name','entries','agents'])
 const dataset={id:text(v.id,'datasetId'),name:text(v.name,'datasetName'),entries:list(v.entries,'entries',1000).map(parseEntry),agents:list(v.agents??[],'agents',2000).map(parseSegment)}
 validateCorrelation(dataset.entries,dataset.agents)
 return dataset
}
export function parseConfig(value:unknown):Config {
 const v=object(value);keys(v,['queueId','revision','targetSeconds','shortSeconds','method','excludeShort','startAt','endAt','timezone','repeatWindowHours'])
 const timezone=text(v.timezone,'timezone',100)
 try{new Intl.DateTimeFormat('en-US',{timeZone:timezone}).format(0)}catch{throw new Fault('invalid_timezone')}
 if(typeof v.excludeShort!=='boolean')throw new Fault('invalid_excludeShort')
 const config:Config={repeatWindowHours:integer(v.repeatWindowHours??168,'repeatWindowHours',1,720),queueId:text(v.queueId,'queueId'),revision:integer(v.revision??0,'revision'),targetSeconds:integer(v.targetSeconds,'targetSeconds',0,86400),shortSeconds:integer(v.shortSeconds,'shortSeconds',0,86400),method:choice(v.method,['exclude-abandons','include-abandons'],'method'),excludeShort:v.excludeShort,startAt:timestamp(v.startAt,'startAt'),endAt:timestamp(v.endAt,'endAt'),timezone}
 if(config.endAt<=config.startAt)throw new Fault('invalid_report_interval')
 return config
}
