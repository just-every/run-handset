import type { Bindings } from '../../auth.server'
import { Fault } from '../core'
import type { Route } from './model'
export interface Source {id:string;account_id:string;number_id:string;owner_id:string;owner_version:number;revision:number}
export const sourceFence=(env:Bindings,s:Source)=>env.DB.prepare(`INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_sources s JOIN oa_operators o ON o.id=s.owner_id WHERE s.id=? AND s.account_id=? AND s.revision=? AND s.owner_id=? AND s.owner_version=? AND s.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=s.owner_version`).bind(s.id,s.account_id,s.revision,s.owner_id,s.owner_version)
export const routeFence=(env:Bindings,r:Route)=>env.DB.prepare('INSERT INTO hnd_guard(ok) SELECT count(*) FROM hnd_protection_routes WHERE source_id=? AND revision=? AND number_id=?').bind(r.source_id,r.revision,r.number_id)
// https://www.twilio.com/docs/usage/security — authenticate the exact action URL
// and every form field, including Digits. The provider key is never persisted.
export async function verifyCarrierSignature(request:Request,env:Bindings,p:URLSearchParams){
 const signature=request.headers.get('x-twilio-signature')
 if(!env.HANDSET_TWILIO_AUTH_TOKEN||!signature||!/^[A-Za-z0-9+/]{27}=$/.test(signature))throw new Fault('invalid_source_proof',403)
 let raw:Uint8Array;try{raw=Uint8Array.from(atob(signature),c=>c.charCodeAt(0))}catch{throw new Fault('invalid_source_proof',403)}
 let payload=request.url
 for(const name of [...new Set(p.keys())].sort())for(const value of [...new Set(p.getAll(name))].sort())payload+=name+value
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.HANDSET_TWILIO_AUTH_TOKEN),{name:'HMAC',hash:'SHA-1'},false,['verify'])
 if(!await crypto.subtle.verify('HMAC',key,new Uint8Array(raw).buffer,new TextEncoder().encode(payload)))throw new Fault('invalid_source_proof',403)
 for(const name of p.keys())if(p.getAll(name).length!==1)throw new Fault('duplicate_source_field')
}
