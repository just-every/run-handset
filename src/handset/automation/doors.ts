import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { Fault, json, keys, owner, text, choice, type ObjectValue } from '../core'
import { commit } from '../audit/store'
import { eventRecord, pause, preview, publish, triggers } from './rules'
export async function rulesDoor(request: Request, env: Bindings, actor: Session, value?: ObjectValue): Promise<Response | null> {
 const path = new URL(request.url).pathname, base = '/api/handset/rules'
 if (path !== base && !path.startsWith(base + '/')) return null
 owner(actor)
 if (path === base && request.method === 'GET') return json({ rules: (await env.DB.prepare('SELECT * FROM hnd_rules ORDER BY created_at LIMIT 100').all()).results, runs: (await env.DB.prepare('SELECT * FROM hnd_rule_runs ORDER BY created_at DESC,id LIMIT 200').all()).results, limits: { rules: 100, runs: 200 }, customerContact: 'held' })
 if (request.method !== 'POST' || !value) throw new Fault('method_not_allowed', 405)
 if (path === base + '/preview') return json(await preview(env, actor, value), 201)
 if (path === base + '/publish') return json(await publish(env, actor, value), 201)
 if (path === base + '/pause') return json(await pause(env, actor, value))
 if (path === base + '/events') {
  keys(value, ['recordId','trigger'])
  const trigger = choice(value.trigger, triggers, 'trigger'), record = await eventRecord(env, text(value.recordId, 'recordId'), trigger)
  await commit(env, actor, 'automation.event', record.id, 'completed', [env.DB.prepare('INSERT INTO hnd_rule_events VALUES (?,?,?) ON CONFLICT(record_id) DO UPDATE SET created_at=excluded.created_at').bind(record.id, trigger, Date.now())])
  return json({ recordId: record.id, queued: true, effectOccurred: false }, 202)
 }
 throw new Fault('not_found', 404)
}
