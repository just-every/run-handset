import type { Bindings } from '../../auth.server'
import { origin, send, bearer, held, rejected, uncertain, instant, type EdgeResult } from './edge'
import type { Service } from './model'

// Dial owns availability, booking pages and reminders. Reads use its public booking-page
// availability; creation uses its operator booking API, whose creation key replays one booking.
const base = (env: Bindings) => env.HANDSET_DIAL_TOKEN ? origin(env.HANDSET_DIAL_ORIGIN, 'dial_origin') : null
export async function dialAvailability(env: Bindings, service: Service, timezone: string): Promise<{ state: 'ok'; slots: string[] } | { state: 'held' | 'uncertain'; reason: string }> {
 const o = base(env)
 if (!o) return { state: 'held', reason: 'dial_connector_unconfigured' }
 const wire = await send(`${o}/api/public/book/${service.bookingPage}/availability?inviteeTimezone=${encodeURIComponent(timezone)}&durationMinutes=${service.minutes}`, { method: 'GET', headers: { accept: 'application/json' } })
 if (!wire || wire.status !== 200) return { state: 'uncertain', reason: 'dial_availability_unreadable' }
 if (wire.body.state !== 'available' || !Array.isArray(wire.body.slots)) return { state: 'uncertain', reason: 'dial_availability_unavailable' }
 const slots = wire.body.slots.map(slot => (slot as { startAt?: unknown })?.startAt).filter((value): value is string => !Number.isNaN(instant(value))).map(value => new Date(Date.parse(value)).toISOString())
 return { state: 'ok', slots }
}
interface Request { idempotencyKey: string; eventTypeId: string; startAt: string; inviteeTimezone: string; name: string; email: string; answers: Record<string, string>; durationMinutes: number }
async function readback(env: Bindings, o: string, id: string, request: Request): Promise<EdgeResult> {
 const wire = await send(`${o}/api/app/bookings/${encodeURIComponent(id)}`, { method: 'GET', headers: { ...bearer(env.HANDSET_DIAL_TOKEN), accept: 'application/json' } })
 if (!wire) return uncertain('dial_readback_unavailable')
 const b = wire.body
 if (wire.status !== 200 || b.id !== id || instant(b.startAt) !== Date.parse(request.startAt) || b.state === 'cancelled') return uncertain('dial_readback_mismatch')
 return { state: 'confirmed', externalId: id, readback: { id, startAt: new Date(Date.parse(request.startAt)).toISOString(), state: b.state ?? 'confirmed' }, reason: 'readback_matched' }
}
export async function dialBook(env: Bindings, request: Request, known?: string | null): Promise<EdgeResult> {
 const o = base(env)
 if (!o) return held('dial_connector_unconfigured')
 if (known) return readback(env, o, known, request)
 const wire = await send(`${o}/api/app/bookings`, { method: 'POST', headers: { ...bearer(env.HANDSET_DIAL_TOKEN), 'content-type': 'application/json' }, body: JSON.stringify(request) })
 if (!wire) return uncertain('dial_response_lost')
 if ([200, 201].includes(wire.status) && typeof wire.body.id === 'string') return readback(env, o, wire.body.id, request)
 if (wire.status === 409 || wire.status === 422) return rejected(String((wire.body.error as { code?: string } | undefined)?.code ?? 'slot_unavailable'))
 if (wire.status === 401 || wire.status === 403) return rejected('dial_credential_refused')
 return uncertain('dial_answer_unrecognised')
}
