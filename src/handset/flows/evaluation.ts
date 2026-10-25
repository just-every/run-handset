import { Fault, integer, keys, object, text } from '../core'
import { explicitInstant, selectGroup, validateGroupState, type GroupSelection, type GroupSelectionConfig, type GroupSelectionState } from './groups'
export { validateGroup, validateGroupState, selectGroup, explicitInstant } from './groups'
export type { GroupSelection, GroupSelectionConfig, GroupSelectionState, GroupMemberState } from './groups'

// ISO weekdays start with Monday. Windows include their start and exclude their end.
export type FlowHours = {weekly:{days:number[];startMinute:number;endMinute:number}[]}
export type EvaluationNode = {id:string;kind:string;next:string[];queueId?:string;language?:string;hours?:FlowHours;group?:GroupSelectionConfig}
export type EvaluationDefinition = {entry:string;nodes:EvaluationNode[];timezone:string;overrides:{date:string;entry:string}[]}
export type EvaluationInput = {instant:string;choices?:Record<string,string>;groups?:Record<string,GroupSelectionState>}
export type EvaluationBranch = {nodeId:string;next:string;reason:'weekly_open'|'weekly_closed'|'menu_choice'}
export type FlowEvaluation = {
 instant:string;timezone:string;localDate:string;localMinute:number;weekday:number;entry:string;
 overrideApplied:boolean;path:string[];branches:EvaluationBranch[];
 terminal:{id:string;kind:string;queueId?:string;language?:string};group?:GroupSelection;liveRouting:false
}

export function validateHours(raw:unknown):FlowHours {
 const value=object(raw);keys(value,['weekly'])
 if(!Array.isArray(value.weekly)||value.weekly.length>100)throw new Fault('invalid_weekly_hours')
 const weekly=value.weekly.map(raw=>{
  const window=object(raw);keys(window,['days','startMinute','endMinute'])
  if(!Array.isArray(window.days)||!window.days.length||window.days.length>7)throw new Fault('invalid_hours_days')
  const days=window.days.map(day=>integer(day,'weekday',1,7))
  if(new Set(days).size!==days.length)throw new Fault('duplicate_hours_day')
  const startMinute=integer(window.startMinute,'startMinute',0,1439),endMinute=integer(window.endMinute,'endMinute',1,1440)
  if(startMinute>=endMinute)throw new Fault('invalid_hours_window')
  return {days,startMinute,endMinute}
 })
 return {weekly}
}

export function validateEvaluationInput(raw:unknown):EvaluationInput {
 const value=object(raw);keys(value,['instant','choices','groups'])
 const choices:Record<string,string>={},groups:Record<string,GroupSelectionState>={}
 if(value.choices!==undefined){
  const supplied=object(value.choices)
  if(Object.keys(supplied).length>50)throw new Fault('too_many_menu_choices')
  for(const [key,target] of Object.entries(supplied)){
   const nodeId=text(key,'nodeId');if(Object.hasOwn(choices,nodeId))throw new Fault('duplicate_menu_choice')
   Object.defineProperty(choices,nodeId,{value:text(target,'destination'),enumerable:true})
  }
 }
 if(value.groups!==undefined){
  const supplied=object(value.groups)
  if(Object.keys(supplied).length>50)throw new Fault('too_many_group_states')
  for(const [key,state] of Object.entries(supplied)){
   const nodeId=text(key,'nodeId');if(Object.hasOwn(groups,nodeId))throw new Fault('duplicate_group_state')
   Object.defineProperty(groups,nodeId,{value:validateGroupState(state),enumerable:true})
  }
 }
 return {instant:explicitInstant(value.instant),choices,groups}
}

export function evaluateFlow(definition:EvaluationDefinition, rawInput:EvaluationInput):FlowEvaluation {
 const input=validateEvaluationInput(rawInput)
 let parts:Intl.DateTimeFormatPart[]
 try{parts=new Intl.DateTimeFormat('en-CA',{timeZone:definition.timezone,calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(input.instant))}catch{throw new Fault('invalid_timezone')}
 const part=(type:string)=>parts.find(item=>item.type===type)!.value
 const localDate=`${part('year').padStart(4,'0')}-${part('month')}-${part('day')}`
 const weekday=(new Date(localDate+'T00:00:00Z').getUTCDay()+6)%7+1,localMinute=Number(part('hour'))*60+Number(part('minute'))
 const override=definition.overrides.find(item=>item.date===localDate),entry=override?.entry??definition.entry
 const result:FlowEvaluation={instant:input.instant,timezone:definition.timezone,localDate,localMinute,weekday,entry,overrideApplied:!!override,path:[],branches:[],terminal:{id:'',kind:''},liveRouting:false}
 const visited=new Set<string>();let target=entry
 while(true){
  const node=definition.nodes.find(item=>item.id===target)
  if(!node)throw new Fault('orphaned_destination')
  if(visited.has(node.id)||visited.size>=50)throw new Fault('cyclic_flow')
  visited.add(node.id);result.path.push(node.id)
  if(node.kind==='hours'){
   if(!node.hours)throw new Fault('hours_configuration_required')
   if(node.next.length!==2)throw new Fault('invalid_hours_branches')
   const hours=validateHours(node.hours),open=hours.weekly.some(window=>window.days.includes(weekday)&&localMinute>=window.startMinute&&localMinute<window.endMinute)
   target=node.next[open?0:1];result.branches.push({nodeId:node.id,next:target,reason:open?'weekly_open':'weekly_closed'})
  }else if(node.kind==='menu'){
   const selected=Object.hasOwn(input.choices!,node.id)?input.choices![node.id]:undefined
   if(selected===undefined)throw new Fault('menu_choice_required',400,{nodeId:node.id})
   if(!node.next.includes(selected))throw new Fault('invalid_menu_choice')
   target=selected;result.branches.push({nodeId:node.id,next:target,reason:'menu_choice'})
  }else{
   if(!['queue','receptionist','end'].includes(node.kind)||node.next.length)throw new Fault('invalid_terminal_node')
   result.terminal={id:node.id,kind:node.kind,...(node.queueId?{queueId:node.queueId}:{}),...(node.language?{language:node.language}:{})}
   if(node.group){
    if(node.kind!=='queue')throw new Fault('group_requires_queue')
    const state=Object.hasOwn(input.groups!,node.id)?input.groups![node.id]:undefined
    if(!state)throw new Fault('group_state_required')
    result.group=selectGroup(node.group,state,input.instant)
   }
   return result
  }
 }
}
