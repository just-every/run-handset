import { statement, type Context } from './storage'
import type { Entry } from './model'

export interface Visit {id:string;entry_id:string;queue_id:string;ordinal:number;arrived_at:number|null;left_at:number|null;state:string;outcome_basis:string}
export function visitState(ctx:Context,row:Entry,state:string,at:number,terminal=false,basis='native observation'){
 return statement(ctx,'UPDATE hnd_queue_visits SET state=?,left_at=CASE WHEN ?=1 THEN ? ELSE left_at END,outcome_basis=? WHERE id=?',state,terminal?1:0,at,basis,row.current_visit_id)
}
export function newVisit(ctx:Context,visitId:string,entryId:string,queueId:string,ordinal:number,at:number){
 return statement(ctx,"INSERT INTO hnd_queue_visits VALUES (?,?,?,?,?,NULL,'waiting','native arrival')",visitId,entryId,queueId,ordinal,at)
}
