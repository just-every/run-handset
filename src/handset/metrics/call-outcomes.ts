import type { Bindings } from '../../auth.server'

/** Only exact canonical call identities may contribute business outcomes. */
export async function callOutcomeSources(env:Bindings,capturedAt:number) {
 const [handlers,outcomes]=await Promise.all([
  env.DB.prepare(`SELECT e.call_id,o.id AS offer_id,o.agent_id,o.child_call_sid,o.connected_at,o.completed_at,o.service_seconds
   FROM hnd_queue_entries e JOIN hnd_queue_offers o ON o.entry_id=e.id
   JOIN hnd_record_sources rs ON rs.record_id=e.call_id AND rs.source_kind='twilio' AND rs.source_id=o.source_id
   JOIN hnd_source_objects so ON so.record_id=e.call_id AND so.source_id=o.source_id AND so.external_id=o.parent_call_sid
   WHERE o.state='completed' AND o.provider_status='completed' AND o.child_call_sid IS NOT NULL
   AND o.connected_at IS NOT NULL AND o.completed_at IS NOT NULL AND o.observed_at<=?`).bind(capturedAt).all<{call_id:string;offer_id:string;agent_id:string;child_call_sid:string;connected_at:number;completed_at:number;service_seconds:number}>(),
  env.DB.prepare(`SELECT o.id,o.call_id,o.case_id,o.created_at,
   (SELECT min(s.updated_at) FROM hnd_rx_steps s WHERE s.outcome_id=o.id AND s.kind='booking' AND s.state='confirmed' AND s.readback IS NOT NULL AND s.updated_at<=?) AS booked_at,
   EXISTS(SELECT 1 FROM hnd_rx_exceptions x WHERE x.outcome_id=o.id) AS escalated,
   EXISTS(SELECT 1 FROM hnd_rx_steps s WHERE s.outcome_id=o.id AND (s.kind IN ('crm','support','refund') OR s.state<>'confirmed')) AS unfinished_or_handoff,
   EXISTS(SELECT 1 FROM hnd_queue_entries e WHERE e.call_id=o.call_id AND e.agent_id IS NOT NULL) AS human_assignment
   FROM hnd_rx_outcomes o WHERE o.created_at<=?`).bind(capturedAt,capturedAt).all<{id:string;call_id:string;case_id:string;created_at:number;booked_at:number|null;escalated:number;unfinished_or_handoff:number;human_assignment:number}>(),
 ])
 return {handlers:handlers.results,outcomes:outcomes.results}
}

export const containmentBasis='Native booking containment denominator: terminal inbound calls with receptionist work linked by exact canonical call ID and case. Numerator: completed calls with a read-back confirmed booking and no recorded human assignment, handoff, escalation or unfinished step. Distinct calls, never outcome or step rows. This observes native work only; absent observations do not certify caller audio or external human intervention. Unlinked outcomes and open calls are excluded.'
export const conversionBasis='Conversion is an independently read-back confirmed booking tied to this exact canonical call and case within the declared repeat-contact window. Denominator: distinct inbound calls with an owner-assigned tracking source and a complete observation window. Unattributed, unknown identity and immature windows are excluded. Case closure, another call in the same case and inferred sentiment never count. Source labels are current business-number reporting assignments, not advertising-platform verification.'
