import { Fault, choice, integer, keys, object, text } from '../core'

export type GroupSelectionConfig = {strategy:'simultaneous'|'sequential'|'round_robin'|'longest_idle';members:string[]}
export type GroupMemberState = {id:string;eligible:boolean;idleSince?:string}
export type GroupSelectionState = {members:GroupMemberState[];cursor?:number}
export type GroupSelection = {strategy:GroupSelectionConfig['strategy'];eligible:string[];selected:string[];nextCursor:number|null}

export function explicitInstant(raw:unknown, name = 'instant'):string {
 const value=text(raw,name,40),match=value.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
 const date=match&&Date.parse(match[1]+'T00:00:00Z'),millis=Date.parse(value)
 if(!match||!Number.isFinite(date)||new Date(date!).toISOString().slice(0,10)!==match[1]||!Number.isFinite(millis)||/T24:/.test(value))throw new Fault(`invalid_${name}`)
 return new Date(millis).toISOString()
}

export function validateGroup(raw:unknown):GroupSelectionConfig {
 const value=object(raw);keys(value,['strategy','members'])
 if(!Array.isArray(value.members)||!value.members.length||value.members.length>100)throw new Fault('invalid_group_members')
 const members=value.members.map(member=>text(member,'memberId'))
 if(new Set(members).size!==members.length)throw new Fault('duplicate_group_member')
 return {strategy:choice(value.strategy,['simultaneous','sequential','round_robin','longest_idle'],'group_strategy'),members}
}

export function validateGroupState(raw:unknown):GroupSelectionState {
 const value=object(raw);keys(value,['members','cursor'])
 if(!Array.isArray(value.members)||value.members.length>100)throw new Fault('invalid_group_state')
 const members=value.members.map(raw=>{
  const member=object(raw);keys(member,['id','eligible','idleSince'])
  if(typeof member.eligible!=='boolean')throw new Fault('invalid_member_eligibility')
  return {id:text(member.id,'memberId'),eligible:member.eligible,...(member.idleSince!==undefined?{idleSince:explicitInstant(member.idleSince,'idleSince')}:{})}
 })
 if(new Set(members.map(member=>member.id)).size!==members.length)throw new Fault('duplicate_member_state')
 return {members,...(value.cursor!==undefined?{cursor:integer(value.cursor,'cursor')}:{})}
}

export function selectGroup(rawConfig:GroupSelectionConfig, rawState:GroupSelectionState, instant:string):GroupSelection {
 const config=validateGroup(rawConfig),state=validateGroupState(rawState),now=Date.parse(explicitInstant(instant))
 if(state.members.length!==config.members.length||state.members.some(member=>!config.members.includes(member.id)))throw new Fault('group_state_members_mismatch')
 if(config.strategy==='round_robin'&&state.cursor===undefined)throw new Fault('group_cursor_required')
 if(state.cursor!==undefined&&state.cursor>=config.members.length)throw new Fault('invalid_cursor')
 const ordered=config.members.map(id=>state.members.find(member=>member.id===id)!)
 if(ordered.some(member=>member.idleSince!==undefined&&Date.parse(member.idleSince)>now))throw new Fault('future_idle_since')
 let eligible=ordered.filter(member=>member.eligible)
 if(config.strategy==='longest_idle'){
  if(eligible.some(member=>member.idleSince===undefined))throw new Fault('idle_since_required')
  eligible.sort((a,b)=>Date.parse(a.idleSince!)-Date.parse(b.idleSince!))
 }
 if(config.strategy==='round_robin'){
  const cursor=state.cursor!
  eligible=[...ordered.slice(cursor),...ordered.slice(0,cursor)].filter(member=>member.eligible)
 }
 const selected=(config.strategy==='simultaneous'?eligible:eligible.slice(0,1)).map(member=>member.id)
 const nextCursor=config.strategy==='round_robin'?(selected.length?(config.members.indexOf(selected[0])+1)%config.members.length:state.cursor!):null
 return {strategy:config.strategy,eligible:eligible.map(member=>member.id),selected,nextCursor}
}
