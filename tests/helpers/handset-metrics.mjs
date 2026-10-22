export const metricStart=Date.parse('2026-07-15T15:00:00Z')
export function metricDataset(){
 const start=metricStart
 const answered=[5,10,25,30].map((wait,index)=>({id:`synthetic-handset-entry-${index+1}`,callId:`synthetic-handset-call-${index+1}`,queueId:'queue-A',kind:'inbound',enteredAt:start,answeredAt:start+wait*1000,closedAt:start+(wait+60)*1000,talkSeconds:40,holdSeconds:10,wrapSeconds:10,agentId:'synthetic-handset-agent-1'}))
 const abandons=[3,40].map((wait,index)=>({id:`synthetic-handset-entry-${index+5}`,callId:`synthetic-handset-call-${index+5}`,queueId:'queue-A',kind:'inbound',enteredAt:start,abandonedAt:start+wait*1000,closedAt:start+wait*1000,talkSeconds:0,holdSeconds:0,wrapSeconds:0}))
 const related=[{id:'synthetic-handset-entry-7',callId:answered[0].callId,queueId:'queue-B',kind:'transfer',parentEntryId:answered[0].id,enteredAt:start+95000,answeredAt:start+97000,closedAt:start+107000,talkSeconds:10,holdSeconds:0,wrapSeconds:0},{id:'synthetic-handset-entry-8',callId:answered[1].callId,queueId:'queue-B',kind:'overflow',parentEntryId:answered[1].id,enteredAt:start+110000,abandonedAt:start+120000,closedAt:start+120000,talkSeconds:0,holdSeconds:0,wrapSeconds:0},{id:'synthetic-handset-entry-9',callId:answered[2].callId,queueId:'queue-B',kind:'callback',parentEntryId:answered[2].id,enteredAt:start+130000,answeredAt:start+140000,closedAt:start+145000,talkSeconds:5,holdSeconds:0,wrapSeconds:0}]
 let offset=0,index=0
 const segment=(state,seconds,offerOutcome)=>{const value={id:'synthetic-handset-segment-'+(++index),agentId:'synthetic-handset-agent-1',startAt:start+offset*1000,endAt:start+(offset+seconds)*1000,state,...(offerOutcome?{offerOutcome}:{})};offset+=seconds;return value}
 const agents=[segment('available',200),...Array.from({length:4},()=>segment('ringing',12,'answered')),segment('ringing',12,'missed'),segment('talk',160),segment('hold',40),segment('wrap',40),segment('unavailable',100),segment('break',30),segment('logged-out',60)]
 return {id:'synthetic-handset-dataset-1',name:'Austin support / Atención al cliente',entries:[...answered,...abandons,...related],agents}
}
export const metricConfig=(queueId='queue-A',revision=0,overrides={})=>({queueId,revision,targetSeconds:20,shortSeconds:5,method:'include-abandons',excludeShort:true,startAt:metricStart,endAt:metricStart+1200000,timezone:'America/Chicago',...overrides})
