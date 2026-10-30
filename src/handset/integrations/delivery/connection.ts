import type { Bindings } from '../../../auth.server'
import { digest } from '../../core'
import { origin } from '../../receptionist/edge'

export type Connector = 'dial' | 'stripe' | 'orbit' | 'helpdesk'
/** Private equality key: changing either endpoint or credential invalidates old observations. */
export async function receivingConnection(env: Bindings, connector: Connector) {
 const token = connector === 'stripe' ? env.HANDSET_STRIPE_KEY : connector === 'dial' ? env.HANDSET_DIAL_TOKEN : connector === 'orbit' ? env.HANDSET_ORBIT_TOKEN : env.HANDSET_HELPDESK_TOKEN
 let base: string | null = null
 try { base = connector === 'stripe' ? 'https://api.stripe.com' : origin(connector === 'dial' ? env.HANDSET_DIAL_ORIGIN : connector === 'orbit' ? env.HANDSET_ORBIT_ORIGIN : env.HANDSET_HELPDESK_ORIGIN, connector + '_origin') } catch { /* Inventory must remain readable for an invalid installation binding. */ }
 return { base, token, key: base && token ? await digest([connector, base, token]) : null }
}
