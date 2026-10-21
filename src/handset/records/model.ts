import { choice, object, keys, text, timestamp, integer, Fault, type ObjectValue } from '../core'

// Current records originate in explicit native owner entry. Provider adapters
// must add their own verified source door; this API cannot fabricate receipts.
export const kinds = ['company','location','number','person','endpoint','flow_version','call_session','call_leg','queue_entry','callback','conversation','message','media','consent','recording','transcript','disposition','promise','provider_attempt','usage','comment'] as const
export type Kind = typeof kinds[number]
const definitions: Record<Kind, { required: string[]; optional?: string[] }> = {
 company: { required: ['name'] }, location: { required: ['name','timezone'] },
 number: { required: ['e164'], optional: ['purpose'] }, person: { required: ['name'] },
 endpoint: { required: ['name','platform'] }, flow_version: { required: ['name','revision'] },
 call_session: { required: ['direction','state'] }, call_leg: { required: ['state'], optional: ['transferFrom'] },
 queue_entry: { required: ['state'] }, callback: { required: ['state','dueAt'] },
 conversation: { required: ['subject'] }, message: { required: ['channel','direction','state'], optional: ['text'] },
 media: { required: ['name','mime'], optional: ['sizeBytes'] }, consent: { required: ['purpose','state'] },
 recording: { required: ['name','state'] }, transcript: { required: ['text','language'] },
 disposition: { required: ['text'] }, promise: { required: ['text','dueAt'] },
 provider_attempt: { required: ['operation','state'] }, usage: { required: ['amountCents','currency'] },
 comment: { required: ['text'], optional: ['mention'] },
}
export interface RecordRow {
 id: string; kind: Kind; source: string; source_id: string; occurred_at: number; received_at: number;
 case_id: string | null; parent_id: string | null; supersedes_id: string | null; data: string; actor_id: string
}
export function recordInput(value: ObjectValue) {
 keys(value, ['kind','sourceId','occurredAt','caseId','parentId','supersedesId','data','links'])
 const kind = choice(value.kind, kinds, 'kind'), data = object(value.data)
 const definition = definitions[kind]
 keys(data, [...definition.required, ...(definition.optional ?? [])])
 for (const key of definition.required) if (!(key in data)) throw new Fault(`missing_${key}`)
 for (const [key, value] of Object.entries(data)) {
  if (key === 'dueAt') timestamp(value, key)
  else if (['amountCents','sizeBytes'].includes(key)) integer(value, key, 0, 1000000000)
  else text(value, key, ['text'].includes(key) ? 4000 : 200)
 }
 if (kind === 'number' && !/^\+[1-9]\d{7,14}$/.test(String(data.e164))) throw new Fault('invalid_e164')
 if (kind === 'location') { try { new Intl.DateTimeFormat('en-US', { timeZone: String(data.timezone) }) } catch { throw new Fault('invalid_timezone') } }
 if (kind === 'usage' && data.currency !== 'USD') throw new Fault('invalid_currency')
 if (['call_session','message'].includes(kind)) choice(data.direction, ['inbound','outbound'], 'direction')
 if (kind === 'message') choice(data.channel, ['sms','mms','voicemail'], 'channel')
 if ('state' in data) {
  // Manual transport entries are explicitly unverified. Delivery/answer/cost
  // receipts belong to the future verified carrier/media doors.
  const allowed = ['call_session','call_leg','message','provider_attempt','usage','recording'].includes(kind)
   ? ['unknown','uncertain','draft'] : ['pending','declined','open','held','unknown','uncertain']
  choice(data.state, allowed, 'state')
 }
 let links: { targetId: string; relation: string }[] = []
 if (value.links !== undefined) {
  if (!Array.isArray(value.links) || value.links.length > 30) throw new Fault('invalid_links')
  links = value.links.map(value => { const link = object(value); keys(link, ['targetId','relation']); return { targetId: text(link.targetId, 'targetId'), relation: choice(link.relation, ['company','location','number','person','endpoint','flow','session','leg','conversation','media','consent','attempt','usage','mentions'], 'relation') } })
  if (new Set(links.map(link => `${link.targetId}:${link.relation}`)).size !== links.length) throw new Fault('duplicate_link')
 }
 return { kind, data: Object.fromEntries(Object.entries(data).sort(([a],[b])=>a.localeCompare(b))), sourceId: text(value.sourceId, 'sourceId'), occurredAt: timestamp(value.occurredAt, 'occurredAt'), caseId: value.caseId ? text(value.caseId, 'caseId') : null, parentId: value.parentId ? text(value.parentId, 'parentId') : null, supersedesId: value.supersedesId ? text(value.supersedesId, 'supersedesId') : null, links }
}
