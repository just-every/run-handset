import { operatorAuth, runtimeBindings, type Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { append, commit } from './store'

const actionFor=(path:string)=>{
 if(['/auth/confirm','/auth/owner-signin','/auth/owner-claim'].includes(path) || /^\/auth\/oidc\/[^/]+\/callback$/.test(path))return 'auth.signin'
 if(path==='/auth/signout')return 'auth.signout'
 if(/^\/auth\/(operator\/|invite|domain-rules|providers|settings)/.test(path))return 'auth.permission'
 if(['/auth/email','/auth/display-name'].includes(path))return 'auth.profile'
 return 'auth.session'
}
export async function observeAuth(request:Request,original:Bindings,handle:()=>Promise<Response|null>){
 const env=runtimeBindings(original),path=new URL(request.url).pathname
 if(!path.startsWith('/auth/') || path.startsWith('/auth/dependencies/'))return handle()
 let actor:Session|null=null
 try{actor=await operatorAuth(env).getSession(request)}catch{/* unsigned auth */}
 const response=await handle()
 if(!response || request.method==='GET' && !['/auth/session','/auth/operators','/auth/sessions'].includes(path))return response
 if(!actor && response.headers.has('set-cookie')){
  const headers=new Headers(request.headers)
  headers.set('cookie',response.headers.get('set-cookie')!.split(';')[0])
  try{actor=await operatorAuth(env).getSession(new Request(request.url,{headers}))}catch{/* no valid admission */}
 }
 const outcome=response.status<400?'completed':response.status<500?'refused':'failed'
 // Fixed action vocabulary; no URL query, mail address, raw body or token.
 if(actor)await commit(env,actor,request.method==='GET'?'auth.access':actionFor(path),'installation',outcome,[],false)
 else await append(env,'anonymous',actionFor(path),'installation',outcome)
 return response
}
