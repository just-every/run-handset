import { Fault } from '../core'
import type { List, QualificationDefinition } from './model'
import { sql, type Context } from './storage'
export async function observations(ctx:Context,l:List,p:QualificationDefinition){
 const since=Date.now()-p.reportWindowDays*86400000
 const row=await sql(ctx,`SELECT count(*) AS attempts,COALESCE(sum(CASE WHEN ended_at IS NOT NULL THEN 1 ELSE 0 END),0) AS terminal,
 COALESCE(sum(CASE WHEN answer_at IS NOT NULL THEN 1 ELSE 0 END),0) AS answered,
 COALESCE(sum(CASE WHEN answer_at IS NOT NULL AND (bridge_observed_at IS NULL OR bridge_observed_at-answer_at>?) THEN 1 ELSE 0 END),0) AS unproven_or_late_bridge,
 COALESCE(sum(CASE WHEN disposition='human_connected' AND bridge_observed_at IS NOT NULL THEN 1 ELSE 0 END),0) AS human_connected,
 COALESCE(avg(CASE WHEN disposition='human_connected' AND ended_at>bridge_observed_at THEN ended_at-bridge_observed_at END),0) AS mean_agent_handle_ms,
 COALESCE(sum(CASE WHEN disposition='abandoned' OR reason IN ('agent_unavailable_message','connect_deadline_breach') THEN 1 ELSE 0 END),0) AS abandoned,
 COALESCE(sum(CASE WHEN ended_at IS NOT NULL AND (disposition='' OR disposition='unknown') THEN 1 ELSE 0 END),0) AS unknown_outcomes
 FROM hnd_dialer_attempts WHERE list_id=? AND state<>'held' AND created_at>=?`,p.maxConnectMs,l.id,since).first<{attempts:number;terminal:number;answered:number;unproven_or_late_bridge:number;human_connected:number;mean_agent_handle_ms:number;abandoned:number;unknown_outcomes:number}>()
 return {...row!,windowStart:since,windowDays:p.reportWindowDays,humanAnswerDenominator:row!.human_connected+row!.abandoned,abandonmentBps:row!.human_connected+row!.abandoned?Math.ceil(row!.abandoned*10000/(row!.human_connected+row!.abandoned)):null,answerRate:row!.terminal?row!.human_connected/row!.terminal:null,qualifier:'provider connected is not a human answer; human dispositions are explicitly attributed; unknown outcomes block prediction'}
}
export async function safeguard(ctx:Context,l:List,p:QualificationDefinition,predictive=false){
 const data=await observations(ctx,l,p)
 if(data.abandoned&&(data.abandonmentBps===null||data.abandonmentBps>p.maxAbandonBps))throw new Fault('abandonment_safeguard_breach',409,data)
 if(data.unproven_or_late_bridge)throw new Fault('connection_safeguard_unproven',409,data)
 if(data.unknown_outcomes)throw new Fault('observed_outcomes_incomplete',409,data)
 if(predictive&&(data.human_connected<p.minimumSamples||data.answerRate===null||!data.mean_agent_handle_ms))throw new Fault('predictive_observations_insufficient',409,data)
 return data
}
