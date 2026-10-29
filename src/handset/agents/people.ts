import { operatorAuthPeople } from '../../modules/agent-door/index.ts'
import { authConfig, operatorAuth, type Bindings } from '../../auth.server'

/** Business subjects resolve to the existing operator store, never by token email. */
export function handsetPeople(env: Bindings) {
  return operatorAuthPeople({
    db: env.DB,
    allowList: authConfig(env).allowList,
    session: request => operatorAuth(env).getSession(request),
  })
}
