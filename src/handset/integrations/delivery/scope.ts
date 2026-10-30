import type { Bindings } from '../../../auth.server'
/** A recorded scope refusal requires a fresh inspection before another dependent write. */
export function deliveryScopeFence(env: Bindings, connector: string, target: string) {
 return env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT CASE WHEN COALESCE((SELECT state FROM hnd_delivery_checks
  WHERE connector=? AND target=? ORDER BY sequence DESC LIMIT 1),'not_checked') IN ('credential_refused','scope_removed') THEN 0 ELSE 1 END`).bind(connector, target)
}
