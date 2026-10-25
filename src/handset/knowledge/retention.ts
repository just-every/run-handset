import type { Bindings } from '../../auth.server'

/** Remove cached text, retaining only the source reference and consent history. */
export async function expireKnowledge(env: Bindings) {
 return env.DB.prepare(`UPDATE hnd_knowledge_sources SET body='',state='unavailable'
 WHERE body<>'' AND (expires_at<=? OR NOT EXISTS (
 SELECT 1 FROM oa_operators o WHERE o.id=owner_id AND o.version=owner_version
 AND o.role='owner' AND o.status='active'))`).bind(Date.now()).run()
}
