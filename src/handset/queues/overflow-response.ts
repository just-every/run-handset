import { escape as e, Fault } from '../core'
import { entryGuard, event, guard, statement, write, type Context } from './storage'
import { activeOverflow, overflowUrl, routeReady } from './media-policy'
import type { Entry } from './model'

export async function overflowInstructions(ctx:Context,row:Entry){
 if(row.state!=='overflow')throw new Fault('queue_entry_not_overflow',409)
 if(row.overflow_kind==='queue')throw new Fault('queue_overflow_target_full',409)
 const route=await activeOverflow(ctx,row.queue_id,row.overflow_kind??'')
 if(!route)throw new Fault('queue_overflow_route_unqualified',409,{queueId:row.queue_id})
 const url=overflowUrl(route.url,ctx.env.AUTH_ORIGIN)
 await write(ctx,row.id,[entryGuard(ctx,row),
  guard(ctx,`SELECT count(*) FROM hnd_queue_overflow_routes r JOIN oa_operators o ON o.id=r.approved_by WHERE r.queue_id=? AND r.revision=? AND r.kind=? AND r.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=r.owner_version`,row.queue_id,route.revision,row.overflow_kind),
  event(ctx,'overflow.instructions',row.queue_id,row.id,null,{kind:route.kind,routeRevision:route.revision,transport:'instructions_emitted',delivery:'unconfirmed'}),
 ])
 // Redirect continues this same inbound call at the owner's exact pre-existing
 // route. It neither creates an outbound leg nor claims destination receipt.
 return `<Redirect method="POST">${e(url)}</Redirect>`
}
export { routeReady }
