import { agentStates, formulaVersion, type Config, type Entry, type Segment } from './model'

const ratio=(numerator:number,denominator:number)=>({numerator,denominator,value:denominator?numerator/denominator:null})
const sum=(items:Entry[],key:'talkSeconds'|'holdSeconds'|'wrapSeconds')=>items.reduce((n,e)=>n+e[key],0)
export function calculate(entries:Entry[],segments:Segment[],config:Config) {
 // Arrival cohorts are [start,end); waits and completion retain their full leg.
 const cohort=entries.filter(e=>e.queueId===config.queueId&&e.enteredAt>=config.startAt&&e.enteredAt<config.endAt)
 const inbound=cohort.filter(e=>e.kind!=='callback'),callbacks=cohort.filter(e=>e.kind==='callback')
 const answered=inbound.filter(e=>e.answeredAt!==undefined),abandoned=inbound.filter(e=>e.abandonedAt!==undefined)
 const eligibleAbandons=abandoned.filter(e=>!config.excludeShort||(e.abandonedAt!-e.enteredAt)/1000>=config.shortSeconds)
 const within=answered.filter(e=>(e.answeredAt!-e.enteredAt)/1000<=config.targetSeconds).length
 const handled=cohort.filter(e=>e.answeredAt!==undefined&&e.closedAt!==undefined)
 const provisional=cohort.filter(e=>e.closedAt===undefined).length
 const talk=sum(handled,'talkSeconds'),hold=sum(handled,'holdSeconds'),wrap=sum(handled,'wrapSeconds')
 const agents:Record<string,ReturnType<typeof agentTotal>>={}
 for(const agentId of new Set(segments.map(s=>s.agentId)))agents[agentId]=agentTotal(segments.filter(s=>s.agentId===agentId),config)
 return {formulaVersion,config,provisional,finalized:provisional===0,cohort:'entry enteredAt in [startAt,endAt); full completed-leg components',totals:{offered:inbound.length,arrivals:inbound.filter(e=>e.kind==='inbound').length,transfers:inbound.filter(e=>e.kind==='transfer').length,overflows:inbound.filter(e=>e.kind==='overflow').length,callbacks:callbacks.length,answered:answered.length,abandoned:abandoned.length,eligibleAbandons:eligibleAbandons.length,shortAbandons:abandoned.length-eligibleAbandons.length,withinTarget:within,completedHandled:handled.length,talkSeconds:talk,holdSeconds:hold,wrapSeconds:wrap},serviceLevel:ratio(within,answered.length+(config.method==='include-abandons'?eligibleAbandons.length:0)),asaSeconds:ratio(answered.reduce((n,e)=>n+(e.answeredAt!-e.enteredAt)/1000,0),answered.length),abandonment:ratio(eligibleAbandons.length,answered.length+eligibleAbandons.length),averageAbandonSeconds:ratio(eligibleAbandons.reduce((n,e)=>n+(e.abandonedAt!-e.enteredAt)/1000,0),eligibleAbandons.length),ahtSeconds:ratio(talk+hold+wrap,handled.length),agents,sourceEntryIds:cohort.map(e=>e.id),callbackParents:callbacks.map(e=>({id:e.id,parentEntryId:e.parentEntryId,callId:e.callId}))}
}
function agentTotal(segments:Segment[],config:Config) {
 const durations=Object.fromEntries(agentStates.map(state=>[state,0])) as Record<typeof agentStates[number],number>
 let answeredOffers=0,missedOffers=0
 for(const s of segments){const seconds=Math.max(0,Math.min(config.endAt,s.endAt)-Math.max(config.startAt,s.startAt))/1000;durations[s.state]+=seconds;if(s.startAt>=config.startAt&&s.startAt<config.endAt){if(s.offerOutcome==='answered')answeredOffers++;if(s.offerOutcome==='missed')missedOffers++}}
 const loggedInSeconds=Object.entries(durations).filter(([state])=>state!=='logged-out').reduce((n,[,s])=>n+s,0),staffedSeconds=loggedInSeconds-durations.break
 return {durations,loggedInSeconds,staffedSeconds,excludedStaffedStates:['break','logged-out'],answeredOffers,missedOffers,occupancy:ratio(durations.talk+durations.hold+durations.wrap,staffedSeconds)}
}
