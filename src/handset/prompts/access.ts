import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { authorizePrompt, promptScope } from '../access/custom-roles'
import { Fault } from '../core'
import { sql } from '../delegation/store'
import { columns, joined } from './store'

export async function greetingCatalog(env:Bindings,actor:Session){
 const scope=await promptScope(env,actor)
 if(!scope?.length)throw new Fault('greeting_access_required',403)
 const permissions=await Promise.all(scope.map(p=>authorizePrompt(env,actor,p)))
 const placeholders=scope.map(()=>'?').join(',')
 const result=await env.DB.batch([...permissions.flatMap(p=>p.fences),
  sql(env,`SELECT id,name,purpose,shared FROM hnd_prompts WHERE id IN (${placeholders}) ORDER BY name,id`,...scope),
  sql(env,`SELECT ${columns} ${joined} WHERE v.prompt_id IN (${placeholders}) ORDER BY v.version DESC LIMIT 500`,...scope),sql(env,'DELETE FROM hnd_guard')])
 return {prompts:result.at(-3)!.results,versions:result.at(-2)!.results,extensions:[],recordings:[],tests:[]}
}
