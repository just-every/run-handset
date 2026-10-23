import { dollars, localTime, type Language, type Policy } from './model'

type Vars = { when?: string; amount?: number; business?: string; callbackAt?: number; item?: string }
/** The only caller-facing text the receptionist may speak. Each line is chosen
 * from a confirmed readback or an honest pending state, never from agent output. */
const lines = {
 en: {
  booking_confirmed: (v: Vars) => `Your appointment is confirmed for ${v.when}.`,
  booking_pending: () => 'I could not confirm the appointment yet. I have not promised it, and the team will confirm it with you.',
  booking_rejected: () => 'That time is no longer available. I can offer another time.',
  deposit_confirmed: (v: Vars) => `Your ${dollars(v.amount!)} deposit to ${v.business} is paid and recorded.`,
  deposit_pending: (v: Vars) => `I could not confirm your ${dollars(v.amount!)} deposit yet. Do not pay again; the team will confirm what was charged.`,
  deposit_declined: () => 'I have not charged anything.',
  deposit_failed: () => 'The payment did not go through and nothing was charged. The team will follow up.',
  handoff_pending: (v: Vars) => `I could not confirm that the ${v.item} was recorded yet; the team will check.`,
  handoff_done: (v: Vars) => `The ${v.item} is recorded for the team.`,
  escalated: (v: Vars) => `I cannot decide that myself. ${v.business} has been given your exact request, and you will hear back by ${v.when}.`,
  emergency: (v: Vars) => `If anyone is in danger, hang up and call 911 now. I cannot dispatch anyone myself. ${v.business} has been alerted and will call you by ${v.when}.`,
  held: () => 'That system is not connected yet, so I have recorded your request for the team instead of completing it.',
  refund_confirmed: (v: Vars) => `A ${dollars(v.amount!)} refund was approved by a person and has been issued.`,
 },
 es: {
  booking_confirmed: (v: Vars) => `Su cita está confirmada para ${v.when}.`,
  booking_pending: () => 'Todavía no pude confirmar la cita. No la he prometido y el equipo la confirmará con usted.',
  booking_rejected: () => 'Ese horario ya no está disponible. Puedo ofrecerle otro.',
  deposit_confirmed: (v: Vars) => `Su depósito de ${dollars(v.amount!)} a ${v.business} está pagado y registrado.`,
  deposit_pending: (v: Vars) => `Todavía no pude confirmar su depósito de ${dollars(v.amount!)}. No vuelva a pagar; el equipo confirmará lo que se cobró.`,
  deposit_declined: () => 'No he cobrado nada.',
  deposit_failed: () => 'El pago no se completó y no se cobró nada. El equipo le dará seguimiento.',
  handoff_pending: (v: Vars) => `Todavía no pude confirmar que ${v.item} quedó registrado; el equipo lo revisará.`,
  handoff_done: (v: Vars) => `${v.item} quedó registrado para el equipo.`,
  escalated: (v: Vars) => `No puedo decidir eso yo misma. ${v.business} recibió su solicitud exacta y le responderán antes de ${v.when}.`,
  emergency: (v: Vars) => `Si alguien está en peligro, cuelgue y llame al 911 ahora. Yo no puedo enviar ayuda. ${v.business} fue alertado y le llamará antes de ${v.when}.`,
  held: () => 'Ese sistema todavía no está conectado, así que registré su solicitud para el equipo en lugar de completarla.',
  refund_confirmed: (v: Vars) => `Una persona aprobó un reembolso de ${dollars(v.amount!)} y ya fue emitido.`,
 },
} as const
export type SayKey = keyof typeof lines.en
export const itemNames = { en: { crm: 'sales record', support: 'support note' }, es: { crm: 'el registro de ventas', support: 'la nota de soporte' } } as const
export function say(p: Policy, language: Language, key: SayKey, v: Vars = {}) {
 const text = lines[language][key]({ business: p.businessName, ...v, when: v.callbackAt ? localTime(p, language, v.callbackAt) : v.when })
 return { key, language, text }
}
