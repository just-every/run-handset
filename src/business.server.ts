import { createBusinessSettings } from './modules/business-settings/index.ts'
import { authConfig, type Bindings } from './auth.server'
import { createOperatorAuth } from './modules/operator-auth/index.mjs'
import { operatorMail } from './mail.server.mjs'

/** Signed Business identity binding uses native invitation and account policy. */
export function businessSettings(env: Bindings) {
  const native = createOperatorAuth({
    db: env.DB,
    config: authConfig(env),
    mailSender: operatorMail(env),
    clientIp: request => request.headers.get('CF-Connecting-IP') ?? '',
  })
  return createBusinessSettings({
    db: env.DB,
    trust: env.RER_BUSINESS_TRUST,
    business: { settings: 1, values: ['display_name'], team: { roles: { admin: 'admin', member: 'member' } } },
    team: native.businessTeam,
  })
}
