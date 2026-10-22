import { escape as e, Fault } from '../core'
import { entryGuard, event, guard, statement, write, type Context } from './storage'
import { activeOverflow, overflowUrl, routeReady } from './media-policy'
import type { Entry } from './model'

export async function overflowInstructions(ctx:Context,row:Entry){
 if(row.state!=='overflow')throw new Fault('queue_entry_not_overflow',409)
 if(row.overflow_kind==='native')return unavailableEnding(ctx,row,'overflow_route_unavailable')
 if(row.overflow_kind==='queue')return unavailableEnding(ctx,row,'overflow_queue_full')
 const route=await activeOverflow(ctx,row.queue_id,row.overflow_kind??'')
 if(!route)return unavailableEnding(ctx,row,'overflow_route_unavailable')
 const url=overflowUrl(route.url,ctx.env.AUTH_ORIGIN)
 await write(ctx,row.id,[entryGuard(ctx,row),
  guard(ctx,`SELECT count(*) FROM hnd_queue_overflow_routes r JOIN oa_operators o ON o.id=r.approved_by WHERE r.queue_id=? AND r.revision=? AND r.kind=? AND r.revoked_at IS NULL AND o.status='active' AND o.role='owner'`,row.queue_id,route.revision,row.overflow_kind),
  event(ctx,'overflow.instructions',row.queue_id,row.id,null,{kind:route.kind,routeRevision:route.revision,transport:'instructions_emitted',delivery:'unconfirmed'}),
 ])
 // Redirect continues this same inbound call at the owner's exact pre-existing
 // route. It neither creates an outbound leg nor claims destination receipt.
 return `<Redirect method="POST">${e(url)}</Redirect>`
}
export { routeReady }

export async function unavailableEnding(ctx:Context,row:Entry,reason:string){
 await write(ctx,row.id,[
  statement(ctx,"INSERT INTO hnd_queue_alerts(id,queue_id,entry_id,reason,created_at) VALUES (?,?,?,?,?) ON CONFLICT(entry_id,reason) DO NOTHING",crypto.randomUUID(),row.queue_id,row.id,reason,Date.now()),
  event(ctx,'route.unavailable',row.queue_id,row.id,null,{reason,ending:'native_message_hangup',delivery:'instructions_emitted'}),
 ])
 return `<Say language="${row.language.startsWith('es')?'es-MX':'en-US'}">${row.language.startsWith('es')?'No podemos conectar su llamada en este momento. Por favor, vuelva a llamar más tarde.':'We cannot connect your call right now. Please call again later.'}</Say><Hangup/>`
}
