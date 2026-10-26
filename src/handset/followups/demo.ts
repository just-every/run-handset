import type { Bindings } from '../../auth.server'
import { actorRef, append } from '../audit/store'
import { prepare } from './store'

// The demo's follow-up samples: four callers, each a native case with its own contact,
// line and cited promise, then a draft follow-up made by the same checks as the
// owner's form. Nothing here is a call, a text or a carrier or Orbit result.
type Sample = { key: number; title: string; name?: string; e164: string; line: string; topic: string; callback?: boolean; promise: string; obligation: string; note: string; draft: string; target: string; dueIn: number; ago: number }
const samples: Sample[] = [
 { key: 1, title: 'Juan Tabo Blvd outage', name: 'Daniel Archuleta', e164: '+15055550164', line: 'Local', topic: 'Juan Tabo Blvd outage', callback: true, promise: 'We will call you back about the Juan Tabo Blvd outage', obligation: 'We will call you back about the Juan Tabo Blvd outage', note: 'Node JT-4 outage, fix est. 11:00 am', draft: 'Node JT-4 outage, fix est. 11:00 am. Spanish callback script drafted.', target: 'opportunities/mr-20418/handoffs/jt4-outage', dueIn: 9, ago: 14 },
 { key: 2, title: 'October bill', name: 'Linda Gallegos', e164: '+15055550148', line: 'Billing', topic: 'Double charge', promise: 'We will email the corrected October bill today', obligation: 'We will email the corrected October bill today', note: 'Billing lead approved the refund', draft: 'Corrected October bill is ready; the billing lead approved the refund.', target: 'opportunities/mr-11873/handoffs/october-bill', dueIn: 54, ago: 29 },
 { key: 3, title: 'Fiber pricing', e164: '+15055550193', line: 'Sales', topic: 'Fiber plan pricing', promise: 'We will send fiber pricing for the Montgomery Blvd address', obligation: 'We will send fiber pricing for the Montgomery Blvd address', note: 'Asked about installation dates', draft: 'Quote the 1 Gbps fiber plan; the caller also asked for installation dates.', target: 'opportunities/sales-0193/handoffs/fiber-quote', dueIn: 125, ago: 45 },
 { key: 4, title: 'Router replacement', name: 'Ray Sandoval', e164: '+15055550127', line: 'Support', topic: 'Router RX-2 failing', callback: true, promise: 'A technician will call to schedule the router swap', obligation: 'A technician will call to schedule the router swap', note: 'Replacement router RX-2 is in stock', draft: 'Router RX-2 replacement is in stock; schedule a technician visit.', target: 'opportunities/mr-30552/handoffs/router-swap', dueIn: 185, ago: 61 },
]
const caseId = (s: Sample) => `10000000-0000-4000-8000-0000000003${String(s.key).padStart(2, '0')}`
const recordId = (s: Sample, n: number) => `10000000-0000-4000-8000-${String(1000 + s.key * 10 + n).padStart(12, '0')}`

export async function followupSamples(env: Bindings, owner: { id: string; version: number }, at: number) {
 const minute = 60000, statements: D1PreparedStatement[] = []
 for (const s of samples) {
  const due = at + s.dueIn * minute, start = at - s.ago * minute
  statements.push(env.DB.prepare("INSERT INTO hnd_cases(id,title,owner_id,due_at,promise,status,handled,unread,version,actor_id,updated_at,close_reason) VALUES(?,?,?,?,?,'open',0,1,1,?,?,'') ON CONFLICT DO NOTHING").bind(caseId(s), s.title, owner.id, due, s.obligation, owner.id, start))
  const records: [string, Record<string, unknown>, number][] = [
   ...(s.name ? [['person', { name: s.name }, start] as [string, Record<string, unknown>, number]] : []),
   ['number', { e164: s.e164, purpose: s.line }, start],
   ...(s.callback ? [['callback', { state: 'pending', dueAt: due }, start] as [string, Record<string, unknown>, number]] : []),
   ['promise', { text: s.promise, dueAt: due }, start + minute],
   ['conversation', { subject: s.topic }, start + 2 * minute],
   ['comment', { text: s.note }, at - Math.round(s.ago / 3) * minute],
  ]
  for (const [n, [kind, data, occurred]] of records.entries()) statements.push(env.DB.prepare("INSERT INTO hnd_records(id,kind,source,source_id,occurred_at,received_at,case_id,data,actor_id) VALUES(?,?,'native',?,?,?,?,?,?) ON CONFLICT DO NOTHING").bind(recordId(s, n + 1), kind, `demo-followup-${s.key}-${kind}`, occurred, occurred, caseId(s), JSON.stringify(data), owner.id))
 }
 await env.DB.batch(statements)
 const pseudonym = await actorRef(env.DB, owner.id)
 for (const s of samples) {
  const source = (await env.DB.prepare("SELECT id FROM hnd_records WHERE case_id=? AND kind='promise'").bind(caseId(s)).first<{ id: string }>())!.id
  if (await env.DB.prepare('SELECT 1 FROM hnd_followups WHERE source_id=?').bind(source).first()) continue
  const made = await prepare(env, owner, { caseId: caseId(s), sourceId: source, obligation: s.obligation, dueAt: at + s.dueIn * minute, confirmationBasis: 'Orbit marks the handoff completed', target: s.target, draft: s.draft })
  if (!made.replay) await append(env, pseudonym, 'followup.create', made.followup.id, 'completed', made.statements, null, { native: { role: 'owner', version: owner.version } })
 }
}
