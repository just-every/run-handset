import type { Bindings } from '../../auth.server'
import type { ToolContext } from '../../modules/agent-door/index.ts'
import { Fault } from '../core'

/** Bind the native commit to the admitted policy and current revocation state.
 * The native grant fence remains separate; company policy never replaces it. */
export async function agentEffectFence(env: Bindings, ctx: ToolContext):Promise<D1PreparedStatement> {
 const admission=await env.DB.prepare(`SELECT row FROM agent_door_audit WHERE
 json_extract(row,'$.operation_id')=? AND agent=? ORDER BY sequence DESC LIMIT 1`).bind(ctx.operationId,ctx.agent.id).first<{row:string}>()
 if(!admission)throw new Fault('agent_admission_unavailable',403)
 const revision=(JSON.parse(admission.row) as {revision:number|null}).revision
 return env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM agent_door_state s
 WHERE s.id=1 AND s.local_paused=0 AND NOT EXISTS(SELECT 1 FROM agent_door_agents a WHERE a.id=? AND a.revoked<>0)
 AND ${env.RER_BUSINESS_TRUST?`json_extract(s.envelope,'$.revision') IS ? AND json_extract(s.envelope,'$.paused')=0
 AND json_extract(s.envelope,'$.exp')*1000>? AND json_extract(s.envelope,'$.document') IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM json_each(s.envelope,'$.revoked.agents') WHERE value=?)
 AND NOT EXISTS(SELECT 1 FROM json_each(s.envelope,'$.revoked.consents') WHERE value=?)`:`s.local_revision IS ? AND s.local_document IS NOT NULL`}`)
 .bind(ctx.agent.id,revision,...(env.RER_BUSINESS_TRUST?[Date.now(),ctx.agent.id,ctx.consent??null]:[]))
}
