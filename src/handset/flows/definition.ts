import { Fault, choice, keys, object, text } from '../core'
import { validateHours, validateGroup, type FlowHours, type GroupSelectionConfig } from './evaluation'

export type FlowNode = {id:string;kind:string;next:string[];queueId?:string;language?:string;hours?:FlowHours;group?:GroupSelectionConfig}
export type FlowDefinition = {name:string;entry:string;nodes:FlowNode[];timezone:string;overrides:{date:string;entry:string}[]}
export function definition(raw:unknown):FlowDefinition {
 const v=object(raw);keys(v,['name','entry','nodes','timezone','overrides'])
 const timezone=text(v.timezone,'timezone');try{new Intl.DateTimeFormat('en-US',{timeZone:timezone})}catch{throw new Fault('invalid_timezone')}
 if(!Array.isArray(v.nodes)||!v.nodes.length||v.nodes.length>50)throw new Fault('invalid_flow_nodes')
 const nodes=v.nodes.map(raw=>{const n=object(raw);keys(n,['id','kind','next','queueId','language','hours','group']);if(!Array.isArray(n.next)||n.next.length>10)throw new Fault('invalid_branches');return {id:text(n.id,'nodeId'),kind:choice(n.kind,['hours','menu','queue','receptionist','end'],'nodeKind'),next:n.next.map(x=>text(x,'destination')), ...(n.queueId?{queueId:text(n.queueId,'queueId')}:{}),...(n.language?{language:choice(n.language,['en','es'],'language')}:{}),...(n.hours!==undefined?{hours:validateHours(n.hours)}:{}),...(n.group!==undefined?{group:validateGroup(n.group)}:{})}})
 const ids=new Set(nodes.map(n=>n.id)),entry=text(v.entry,'entry');if(ids.size!==nodes.length||!ids.has(entry))throw new Fault('duplicate_or_missing_entry')
 for(const n of nodes){if(n.group&&n.kind!=='queue')throw new Fault('group_requires_queue');if(n.next.some(x=>!ids.has(x))||new Set(n.next).size!==n.next.length)throw new Fault('orphaned_destination');if(['hours','menu'].includes(n.kind)&&n.next.length<2||['queue','receptionist','end'].includes(n.kind)&&n.next.length)throw new Fault('empty_or_invalid_branches');if(n.hours&&(n.kind!=='hours'||n.next.length!==2))throw new Fault('invalid_hours_branches');if(n.kind==='queue'&&!n.queueId)throw new Fault('queue_required')}
 const visited=new Set<string>(),active=new Set<string>();function visit(target:string){if(active.has(target))throw new Fault('cyclic_flow');if(visited.has(target))return;active.add(target);for(const next of nodes.find(n=>n.id===target)!.next)visit(next);active.delete(target);visited.add(target)}visit(entry)
 if(visited.size!==nodes.length)throw new Fault('unreachable_node_or_language')
 if(!Array.isArray(v.overrides)||v.overrides.length>100)throw new Fault('invalid_overrides')
 const dates=new Set<string>(),overrides=v.overrides.map(raw=>{const o=object(raw);keys(o,['date','entry']);const date=text(o.date,'date'),target=text(o.entry,'entry');if(!/^\d{4}-\d\d-\d\d$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||!ids.has(target)||dates.has(date))throw new Fault('invalid_dated_override');dates.add(date);return {date,entry:target}})
 return {name:text(v.name,'name'),entry,nodes,timezone,overrides}
}
