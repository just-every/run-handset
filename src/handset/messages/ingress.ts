import type { Bindings } from '../../auth.server'
import { append } from '../audit/store'
import { sourcePolicy } from '../audit/policy'
import { id, Fault } from '../core'
import { sourceFence, type Source } from '../providers/sources'
import type { Thread } from './model'

/** Called only after canonical signed ingress committed its immutable receipt. */
export async function observeMessage(env:Bindings,source:Source&{e164:string},p:URLSearchParams,occurredAt:number) {
 const sid=p.get('MessageSid');if(!sid)return
 const from=p.get('From')!,to=p.get('To')!,inbound=to===source.e164,peer=inbound?from:to
 const status=p.get('MessageStatus')??p.get('SmsStatus')??'received'
 // Programmable Messaging has no group delivery. Retain only its documented
 // two-party metadata; an undeclared group must never be flattened and sent.
 if(p.has('ConversationSid')||p.has('GroupSid')||p.has('Participants'))throw new Fault('group_route_unqualified',409)
 let t=await env.DB.prepare('SELECT * FROM hnd_message_threads WHERE source_id=? AND peer=?').bind(source.id,peer).first<Thread>()
 const old=await env.DB.prepare('SELECT id FROM hnd_inbox_messages WHERE thread_id=? AND provider_sid=?').bind(t?.id??'',sid).first<{id:string}>()
 const jobs=await env.DB.prepare('SELECT id FROM hnd_message_jobs WHERE provider_sid=?').bind(sid).first()
 if(!inbound&&jobs)return // Outbound jobs use independent provider readback.
 if(old)return // Canonical status history remains append-only in native records.
 if(!inbound&&!['received','receiving'].includes(status))return
 const key=t?.id??id(),now=Date.now(),media=[]
 for(let n=0;n<Number(p.get('NumMedia')??0);n++)media.push({providerUrl:p.get('MediaUrl'+n),mime:p.get('MediaContentType'+n),content:'metadata only; not fetched'})
 const statements=[sourceFence(env,source)]
 if(!t)statements.push(env.DB.prepare('INSERT INTO hnd_message_threads(id,source_id,business,peer,owner_id,revision,custody,updated_at) VALUES (?,?,?,?,NULL,1,\'handset\',?)').bind(key,source.id,source.e164,peer,now))
 statements.push(env.DB.prepare('INSERT INTO hnd_inbox_messages VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id(),key,sid,inbound?'inbound':'outbound',p.get('Body')??'',JSON.stringify(media),JSON.stringify([source.e164,peer]),'received','not applicable',occurredAt))
 statements.push(env.DB.prepare('UPDATE hnd_message_threads SET updated_at=? WHERE id=?').bind(now,key),env.DB.prepare('INSERT INTO hnd_message_history VALUES (?,?,?,NULL,?)').bind(id(),key,'Inbound message received',now))
 await append(env,source.id,'message.receive',key,'completed',statements,null,sourcePolicy(source))
}
