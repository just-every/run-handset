import type { Session } from '../../modules/operator-auth/index.mjs'
import type { Bindings } from '../../auth.server'

export type Context={env:Bindings;actor:Session}
export interface Grant {
 id:string; operator_id:string; operator_version:number; queue_id:string; can_intervene:number;
 issued_by:string; issuer_version:number; created_at:number; expires_at:number; revoked_at:number|null
}
export const grantLifetimeMs=86400000
export const refreshAfterMs=3000
export const staleAfterMs=7000
export const grantConfirmation='approve supervision scope'
export const operations=['listen','whisper','barge','takeover'] as const
export interface Overview {
 queues:{id:string;name:string;canIntervene:boolean;expiresAt:number}[];
 grants?:(Grant&{operator_name:string;issuer_name:string;queue_name:string;current:number})[];
 queuesAvailableForGrant?:{id:string;name:string}[];
 people?:{id:string;display_name:string}[];
 refreshAfterMs:number;staleAfterMs:number
}
export interface TimelineEvent {
 id:string;actor:string;occurred_at:number;reason:string;from_state:string;to_state:string;
 revision:number;agent_id:string;agentName:string|null;actorName:string|null
}
