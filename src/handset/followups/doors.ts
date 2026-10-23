import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, json, owner, type ObjectValue } from '../core'
import { action, create, get, listing } from './store'
/** Native owner API. No bearer credential can manufacture a human approval. */
export async function followupDoor(request: Request, env: Bindings, actor: Session, value?: ObjectValue): Promise<Response | null> {
 const path = new URL(request.url).pathname, base = '/api/handset/followups'
 if (path !== base && !path.startsWith(base + '/')) return null
 owner(actor)
 if (path === base && request.method === 'GET') return json(await listing(env))
 if (request.method !== 'POST' || !value) throw new Fault('method_not_allowed', 405)
 if (path === base) { const r = await create(env, actor, value); return json(r, r.replay ? 200 : 201) }
 const m = path.slice(base.length).match(/^\/([0-9a-f-]{36})\/(approve|deliver|reconcile|edit|cancel|decline)$/)
 if (!m) throw new Fault('not_found', 404)
 return json({ followup: await action(env, actor, await get(env.DB, m[1]), m[2], value) })
}
