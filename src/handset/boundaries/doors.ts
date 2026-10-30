import { Fault, choice, json, keys, type ObjectValue, page } from '../core'
import { boundariesPage } from './pages'

// Information destinations only. A link conveys no account or purchasing authority.
export const categories = ['payroll', 'consumer-cellular', 'video', 'enterprise-workforce'] as const
export type Category = typeof categories[number]
export type Handoff = {
 category: Category
 label: string
 product: string
 operator: string
 destination: string | null
 destinationKind: 'project' | 'provider-information' | 'unavailable'
 unavailableReason: string | null
 qualification: string
}
const handoffs: readonly Handoff[] = [
 { category: 'payroll', label: 'Payroll', product: 'Envelope', operator: 'Envelope installation operator', destination: 'https://github.com/just-every/run-envelope', destinationKind: 'project', unavailableReason: null, qualification: 'Project information only. No payroll installation or purchasing account is connected.' },
 { category: 'consumer-cellular', label: 'Consumer cellular plan', product: 'Separate consumer cellular carrier', operator: 'Your chosen consumer cellular carrier', destination: null, destinationKind: 'unavailable', unavailableReason: 'No consumer carrier destination is configured. Choose and contact a carrier independently.', qualification: 'Handset business phone numbers do not provide a consumer cellular plan.' },
 { category: 'video', label: 'Video meeting service', product: 'Zoom Workplace', operator: 'Zoom', destination: 'https://www.zoom.com/en/products/virtual-meetings/', destinationKind: 'provider-information', unavailableReason: null, qualification: 'Public provider information only. No video account, subscription or partner connection is configured.' },
 { category: 'enterprise-workforce', label: 'Enterprise workforce suite', product: 'NICE Workforce Management', operator: 'NICE', destination: 'https://www.nice.com/products/workforce-management', destinationKind: 'provider-information', unavailableReason: null, qualification: 'Public provider information only. No enterprise workforce account or staffing feed is configured.' },
]
export const categoryHandoffs = () => handoffs
export function categoryRequest(value: ObjectValue): Handoff {
 keys(value, ['category'])
 const category = choice(value.category, categories, 'category')
 return handoffs.find(item => item.category === category)!
}

// Mounted only after productResponse has checked the current native session.
// Selection neither contacts a provider nor persists a native business outcome.
export async function boundariesDoor(request: Request, value?: ObjectValue): Promise<Response> {
 const path = new URL(request.url).pathname, html = path === '/app/partners'
 if (!html && path !== '/api/handset/partners') throw new Fault('not_found', 404)
 if (!['GET', 'POST'].includes(request.method)) throw new Fault('method_not_allowed', 405)
 const selected = request.method === 'POST' ? categoryRequest(value ?? {}) : undefined
 if (html) return page('Partner handoffs', boundariesPage(handoffs, selected))
 return json(selected ? { handoff: selected, nativeExecution: 'none' } : { handoffs, nativeExecution: 'none' })
}
