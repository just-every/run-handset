import type { Bindings } from '../../auth.server'

/** Only exact canonical call identities may contribute business outcomes. */
export async function handlingSources(env:Bindings,capturedAt:number) {
 const handlers=await env.DB.prepare(`SELECT e.call_id,o.id AS offer_id,o.agent_id,o.child_call_sid,o.connected_at,o.completed_at,o.service_seconds
   FROM hnd_queue_entries e JOIN hnd_queue_offers o ON o.entry_id=e.id
   JOIN hnd_record_sources rs ON rs.record_id=e.call_id AND rs.source_kind='twilio' AND rs.source_id=o.source_id
   JOIN hnd_source_objects so ON so.record_id=e.call_id AND so.source_id=o.source_id AND so.external_id=o.parent_call_sid
   WHERE o.state='completed' AND o.provider_status='completed' AND o.child_call_sid IS NOT NULL
   AND o.connected_at IS NOT NULL AND o.completed_at IS NOT NULL AND o.observed_at<=?`).bind(capturedAt).all<{call_id:string;offer_id:string;agent_id:string;child_call_sid:string;connected_at:number;completed_at:number;service_seconds:number}>()
 return handlers.results
}

export const containmentBasis='Native booking containment denominator: terminal inbound calls with receptionist work linked by exact canonical call ID and case. Numerator: completed calls with a read-back confirmed booking and no recorded human assignment, handoff, escalation or unfinished step. Distinct calls, never outcome or step rows. This observes native work only; absent observations do not certify caller audio or external human intervention. Unlinked outcomes and open calls are excluded.'
export const conversionBasis='Conversion is an independently read-back confirmed booking tied to this exact canonical call and case within the declared repeat-contact window. Denominator: distinct inbound calls with an owner-assigned tracking source and a complete observation window. Unattributed, unknown identity and immature windows are excluded. Case closure, another call in the same case and inferred sentiment never count. Source labels are current business-number reporting assignments, not advertising-platform verification.'
