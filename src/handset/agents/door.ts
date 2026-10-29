import { createAgentDoor, type Trust } from '../../modules/agent-door/index.ts'
import { runtimeBindings, type Bindings } from '../../auth.server'
import { handsetPeople } from './people'
import { handsetTools } from './tools'
import { localCredential, currentScopes } from './grants'

function trust(env: Bindings):Trust|null {
 if (!env.RER_BUSINESS_TRUST) return null
 const raw=JSON.parse(env.RER_BUSINESS_TRUST) as {issuer:string;audience:string;subject:string;keys:Trust['publicKeys']}
 const value:Trust={issuer:raw.issuer,appOrigin:raw.audience,installationId:raw.subject,publicKeys:raw.keys}
 if(value.appOrigin!==env.AUTH_ORIGIN)throw new Error('Agent trust origin mismatch')
 return value
}
export function handsetAgentDoor(original: Bindings) {
 const env=runtimeBindings(original)
 const door=createAgentDoor({seed:'handset',name:'Handset',specialist:'front-office-phone-operator',db:env.DB,origin:env.AUTH_ORIGIN,trust:trust(env),
  capabilities:['tools','policy','pause','audit','idempotency'],people:handsetPeople(env),tools:handsetTools(env),
  paths:['/api/handset/application/mcp','/api/handset/v1/mcp'],
  localCredentials:request=>localCredential(env,request),currentScopes:principal=>currentScopes(env,principal),
  notTools:[{clauses:['HND-008','HND-082'],reason:'device'},{clauses:['HND-064'],reason:'screen'},{clauses:['HND-025'],reason:'connector'},{clauses:['HND-026'],reason:'import-door'},{clauses:['HND-063','HND-065'],reason:'installation'}],
 })
 return {...door,async handle(request:Request){
  const url=new URL(request.url)
  const owned=url.pathname==='/mcp'||url.pathname.startsWith('/agents')||url.pathname==='/api/rer/agent-policy'||url.pathname.startsWith('/.well-known/oauth-protected-resource')||['/api/handset/application/mcp','/api/handset/v1/mcp'].includes(url.pathname)
  if(owned&&(url.origin!==env.AUTH_ORIGIN||request.headers.has('host')&&request.headers.get('host')?.toLowerCase()!==url.host.toLowerCase()))return Response.json({code:'invalid_host'},{status:403,headers:{'cache-control':'no-store'}})
  return door.handle(request)
 }}
}
