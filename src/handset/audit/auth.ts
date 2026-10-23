import { operatorAuth, runtimeBindings, type Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { id } from '../core'
import { append, commit } from './store'

const actionFor=(path:string)=>{
 if(['/auth/confirm','/auth/owner-signin','/auth/owner-claim'].includes(path) || /^\/auth\/oidc\/[^/]+\/callback$/.test(path))return 'auth.signin'
 if(path==='/auth/signout')return 'auth.signout'
 if(/^\/auth\/(operator\/|invite|domain-rules|providers|settings)/.test(path))return 'auth.permission'
 if(['/auth/email','/auth/display-name'].includes(path))return 'auth.profile'
 return 'auth.session'
}
// Unsigned attempts share one installation-wide budget across this and the previous hour: within it
// each is receipted, beyond it only counted, so anonymous traffic cannot crowd the append-only ledger.
const hour=3600000, anonymousBudget=60
async function anonymousReceipt(env:Bindings){
 const window=Math.floor(Date.now()/hour)
 const [,counted]=await env.DB.batch([
  env.DB.prepare('INSERT INTO hnd_auth_anonymous(window,attempts) VALUES (?,1) ON CONFLICT(window) DO UPDATE SET attempts=attempts+1').bind(window),
  env.DB.prepare('SELECT sum(attempts) AS attempts FROM hnd_auth_anonymous WHERE window>=?').bind(window-1),
 ])
 return (counted.results[0] as {attempts:number}).attempts<=anonymousBudget
}
export async function observeAuth(request:Request,original:Bindings,handle:()=>Promise<Response|null>){
 const env=runtimeBindings(original),path=new URL(request.url).pathname
 if(!path.startsWith('/auth/') || path.startsWith('/auth/dependencies/'))return handle()
 let actor:Session|null=null
 try{actor=await operatorAuth(env).getSession(request)}catch{/* unsigned auth */}
 const mutating=request.method!=='GET'&&request.method!=='HEAD'||/^\/auth\/oidc\/[^/]+\/callback$/.test(path),attemptId=id()
 const receipted=mutating||['/auth/session','/auth/operators','/auth/sessions'].includes(path)
 const anonymous=!actor&&receipted&&await anonymousReceipt(env)
 if(mutating){
  if(actor)await commit(env,actor,actionFor(path),attemptId,'uncertain',[],false)
  else if(anonymous)await append(env,'anonymous',actionFor(path),attemptId,'uncertain')
 }
 const response=await handle()
 if(!response || !receipted)return response
 if(!actor && response.headers.has('set-cookie')){
  const headers=new Headers(request.headers)
  headers.set('cookie',response.headers.get('set-cookie')!.split(';')[0])
  try{actor=await operatorAuth(env).getSession(new Request(request.url,{headers}))}catch{/* no valid admission */}
 }
 const outcome=response.status<400?'completed':response.status<500?'refused':'failed'
 // Fixed action vocabulary; no URL query, mail address, raw body or token.
 if(actor)await commit(env,actor,!mutating?'auth.access':actionFor(path),attemptId,outcome,[],false)
 else if(anonymous)await append(env,'anonymous',actionFor(path),attemptId,outcome)
 return response
}
