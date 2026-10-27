import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit, denied } from '../audit/store'
import { Fault, integer, json, owner, page, type ObjectValue } from '../core'
import { searchNumbers } from './catalog'
import { numbersConsole } from './console'
import { getNumber, listNumbers, purchase, reconcilePurchase } from './store'
import { cancelRelease, releaseNumber, reviewRelease } from './release'

export async function numbersDoor(request:Request,env:Bindings,actor:Session,v?:ObjectValue):Promise<Response>{
 const path=new URL(request.url).pathname,html=path.startsWith('/app/'),base=html?'/app/numbers':'/api/handset/numbers'
 try{owner(actor)}catch(error){await denied(env,actor,'number.request');throw error}
 if(request.method==='GET'&&path===base){await commit(env,actor,'number.read','installation','completed');const numbers=await listNumbers(env);return html?page('Numbers',numbersConsole(numbers)):json({numbers})}
 if(request.method!=='POST'||!v)throw new Fault('method_not_allowed',405)
 if(path===base+'/search'){
  const found=await searchNumbers(env,actor,v)
  return html?page('Numbers',numbersConsole(await listNumbers(env),found.quotes,found.quotes.length?'Availability received; no number has been purchased.':'No matching numbers. Change your search.')):json(found)
 }
 if(path===base+'/purchase'){
  const result=await purchase(env,actor,v)
  return html?page('Numbers',numbersConsole(await listNumbers(env),[],result.replay?'Existing purchase request retained. No second paid request.':'Purchase outcome: '+result.number.state)):json(result,result.replay?200:201)
 }
 const match=path.slice(base.length).match(/^\/([0-9a-f-]{36})\/(review|cancel|release|reconcile)$/)
 if(!match)throw new Fault('not_found',404)
 const n=await getNumber(env,match[1]),value={...v}
 if(html&&match[2]==='review'){
  const [key,revision]=String(value.replacementChoice??'').split(':');delete value.replacementChoice;value.replacementId=key;value.replacementRevision=Number(revision)
 }
 if(html&&'revision' in value)value.revision=integer(Number(value.revision),'revision',1)
 const result=match[2]==='review'?await reviewRelease(env,actor,n,value):match[2]==='cancel'?await cancelRelease(env,actor,n,value):match[2]==='release'?await releaseNumber(env,actor,n,value):await reconcilePurchase(env,actor,n)
 return html?page('Numbers',numbersConsole(await listNumbers(env),[],`${match[2]} recorded. Current number state: ${result.state}`)):json({number:result})
}
