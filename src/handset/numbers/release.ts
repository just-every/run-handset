import type { Bindings } from '../../auth.server'
import type { Session } from '../../modules/operator-auth/index.mjs'
import { commit } from '../audit/store'
import { Fault, integer, keys, text, type ObjectValue } from '../core'
import { accountRoot, carrier, readCarrier } from './provider'
import { getNumber, guard, inventoryFence, sql, type Inventory } from './store'

export const releaseNotice='Twilio stops service on release. Its Console permits recovery within 10 days, with a new billing cycle; recovery is not guaranteed by Handset. The carrier recycling period is not exposed by this API. Contact the carrier for recovery. This 24-hour review hold is local and cancellable before release.'
const unbound=(env:Bindings,n:Inventory)=>guard(env,`SELECT CASE WHEN NOT EXISTS (
 SELECT 1 FROM hnd_sources s JOIN hnd_records r ON r.id=s.number_id
 WHERE json_extract(r.data,'$.e164')=? AND (s.revoked_at IS NULL OR EXISTS (
 SELECT 1 FROM hnd_number_compliance c WHERE c.source_id=s.id AND c.kind='port_pin'))
 ) THEN 1 ELSE 0 END`,n.e164)
async function safeProvider(env:Bindings,n:Inventory){
 const receipt=await readCarrier(env,n.account_id,`${accountRoot(n.account_id)}/IncomingPhoneNumbers/${encodeURIComponent(n.provider_id!)}.json`)
 if(receipt.sid!==n.provider_id||receipt.account_sid!==n.account_id||receipt.phone_number!==n.e164)throw new Fault('carrier_number_identity_mismatch',409)
 if(receipt.voice_application_sid||receipt.trunk_sid||receipt.voice_url)throw new Fault('active_carrier_route_blocks_release',409)
 if(receipt.emergency_status!=='Inactive'||receipt.emergency_address_sid||receipt.address_sid)throw new Fault('emergency_or_address_assignment_blocks_release',409)
 return receipt
}
export async function reviewRelease(env:Bindings,actor:Session,n:Inventory,v:ObjectValue){
 keys(v,['revision','replacementId','replacementRevision','confirm'])
 if(v.confirm!=='approve exact number release after reviewed reassignment')throw new Fault('exact_release_approval_required')
 const revision=integer(v.revision,'revision',1),replacementId=text(v.replacementId,'replacementId'),replacementRevision=integer(v.replacementRevision,'replacementRevision',1)
 if(n.state!=='owned'||revision!==n.revision||replacementId===n.id)throw new Fault('release_revision_conflict',409)
 const replacement=await getNumber(env,replacementId)
 if(replacement.state!=='owned'||replacement.revision!==replacementRevision||replacement.hold_until!==null)throw new Fault('owned_current_replacement_required',409)
 await safeProvider(env,n);await safeProvider(env,replacement)
 await commit(env,actor,'number.review',n.id,'completed',[inventoryFence(env,n),inventoryFence(env,replacement),unbound(env,n),unbound(env,replacement),
  sql(env,'UPDATE hnd_number_inventory SET replacement_id=?,replacement_revision=?,release_by=?,release_owner_version=?,release_revision=?,hold_until=?,revision=revision+1 WHERE id=?',replacement.id,replacement.revision,actor.operator.id,actor.operator.version,n.revision+1,Date.now()+86400000,n.id),
 ])
 return getNumber(env,n.id)
}
export async function cancelRelease(env:Bindings,actor:Session,n:Inventory,v:ObjectValue){
 keys(v,['revision']);if(n.state!=='owned'||integer(v.revision,'revision',1)!==n.revision||n.hold_until===null)throw new Fault('release_revision_conflict',409)
 await commit(env,actor,'number.cancel',n.id,'completed',[inventoryFence(env,n),sql(env,'UPDATE hnd_number_inventory SET replacement_id=NULL,replacement_revision=NULL,release_by=NULL,release_owner_version=NULL,release_revision=NULL,hold_until=NULL,revision=revision+1 WHERE id=?',n.id)])
 return getNumber(env,n.id)
}
export async function releaseNumber(env:Bindings,actor:Session,n:Inventory,v:ObjectValue){
 keys(v,['revision','confirm'])
 if(v.confirm!=='release exact number and stop carrier service')throw new Fault('exact_release_confirmation_required')
 if(n.state!=='owned'||integer(v.revision,'revision',1)!==n.revision||n.release_revision!==n.revision||!n.replacement_id)throw new Fault('release_revision_conflict',409)
 if(n.release_by!==actor.operator.id||n.release_owner_version!==actor.operator.version)throw new Fault('named_current_release_approver_required',403)
 if(n.hold_until===null||Date.now()<n.hold_until)throw new Fault('review_hold_active',409)
 const replacement=await getNumber(env,n.replacement_id)
 if(replacement.state!=='owned'||replacement.revision!==n.replacement_revision||replacement.hold_until!==null)throw new Fault('replacement_changed_review_again',409)
 await safeProvider(env,n);await safeProvider(env,replacement)
 // Atomic reservation makes a concurrent stale release fail before DELETE.
 await commit(env,actor,'number.release',n.id,'uncertain',[inventoryFence(env,n),inventoryFence(env,replacement),unbound(env,n),unbound(env,replacement),
  sql(env,"UPDATE hnd_number_inventory SET assignment=?,purpose=?,campaign=?,revision=revision+1 WHERE id=?",n.assignment,n.purpose,n.campaign,replacement.id),
  sql(env,"UPDATE hnd_number_inventory SET state='releasing',revision=revision+1 WHERE id=?",n.id),
 ])
 let confirmed=false
 try{confirmed=(await carrier(env,n.account_id,`${accountRoot(n.account_id)}/IncomingPhoneNumbers/${encodeURIComponent(n.provider_id!)}.json`,'DELETE')).status===204}catch{/* Uncertain effects require explicit carrier investigation, never a retry. */}
 await commit(env,actor,'number.release',n.id,confirmed?'completed':'uncertain',[
  sql(env,"UPDATE hnd_number_inventory SET state=?,released_at=?,revision=revision+1 WHERE id=? AND state='releasing'",confirmed?'released':'release_uncertain',confirmed?Date.now():null,n.id),
 ],false)
 return getNumber(env,n.id)
}
