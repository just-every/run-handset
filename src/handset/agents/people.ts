import { operatorAuthPeople } from '../../modules/agent-door/index.ts'
import { authConfig, operatorAuth, type Bindings } from '../../auth.server'

/** Business subjects resolve to the existing operator store, never by token email. */
export function handsetPeople(env: Bindings) {
  const people = operatorAuthPeople({
    db: env.DB,
    allowList: authConfig(env).allowList,
    session: request => operatorAuth(env).getSession(request),
  })
  return {
    ...people,
    // Business authority needs a settings row that positively reads as running; no row is no pairing.
    businessStopped: async () => (await env.DB.prepare('SELECT stopped FROM bs_settings WHERE singleton=1').first<{ stopped: number }>())?.stopped !== 0,
  }
}
