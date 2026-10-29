import { ToolRefusal, type ToolContext, type Principal } from '../../modules/agent-door/index.ts'
import type { Bindings } from '../../auth.server'
import { applicationAuth, currentGrant } from '../authority/application'
import { grantById, type Grant } from '../authority/store'
import type { Definition, Tool } from '../authority/model'
import { Fault } from '../core'

export const nativeNames = {
 'handset.cases.read': 'case.read', 'handset.comments.draft': 'comment.draft',
 'handset.calls.prepare': 'call.paid', 'handset.messages.prepare': 'message.send',
 'handset.campaigns.prepare': 'campaign.launch', 'handset.numbers.prepare_release': 'number.release',
 'handset.flows.prepare_publish': 'flow.publish',
} as const
export function grantScopes(g: Grant): string[] {
 const d = JSON.parse(g.definition) as Definition
 return Object.entries(nativeNames).filter(([, name]) => d.tools.includes(name)).map(([name]) => name)
}
export async function nativeGrant(env: Bindings, args: Record<string, unknown>, ctx: ToolContext, tool: Tool) {
 try {
  const g = await grantById(env.DB, String(args.grantId))
  // A selected native grant is a restriction, never authority obtained by knowing its id.
  if (g.created_by !== ctx.person.id || ctx.clientId?.startsWith('handset-grant:') && ctx.clientId !== 'handset-grant:'+g.id) throw new Fault('grant_not_available', 403)
  const d = JSON.parse(g.definition) as Definition
  const caseId=args.caseId??(args.state&&typeof args.state==='object'?(args.state as Record<string,unknown>).caseId:undefined)
  if(typeof caseId!=='string'||!d.records.includes(caseId))throw new Fault('record_not_available',403)
  if (!d.tools.includes(tool)) throw new Fault('tool_out_of_scope',403)
  await currentGrant(env,g)
  return g
 } catch(error) { if(error instanceof Fault)throw new ToolRefusal(error.code); throw error }
}
export async function localCredential(env: Bindings, request: Request) {
 if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(request.headers.get('authorization') ?? '')) return null
 try {
  const g = await applicationAuth(request,env)
  return { sponsor:{id:g.created_by}, agent:{id:g.id,name:g.name,specialist:'front-office-phone-operator'}, clientId:'handset-grant:'+g.id, scopes:grantScopes(g) }
 } catch { return null }
}
export async function currentScopes(env: Bindings, principal: Principal) {
 if (!principal.clientId?.startsWith('handset-grant:')) return principal.scopes
 try {
  const g = await grantById(env.DB,principal.clientId.slice(14))
  if (g.created_by!==principal.person.id || g.revoked_at || g.expires_at<=Date.now() || g.credential_expires_at<=Date.now()) return []
  await currentGrant(env,g)
  return grantScopes(g)
 } catch { return [] }
}
