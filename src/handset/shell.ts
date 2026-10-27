import { fontHead } from '../base/font-head'
import { iconHead } from '../base/icon-head'
import branding from '../branding.json'

// The signed-in app frame (owner-approved look A, 26 Oct 2026): a black bar with the
// handset tile, the daily-work tabs and Settings, over a white page with the outline title.
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

// Daily work stays in the bar; configuration and oversight live under Settings.
export const work = [
 ['/app/followups', 'Follow-ups'], ['/app/cases', 'Cases'], ['/app/recovery', 'Recovery'], ['/app/callbacks', 'Callbacks'],
 ['/app/queues', 'Queues'], ['/app/front-desk', 'Front desk'], ['/app/recordings', 'Recordings'], ['/app/receptionist', 'Caller outcomes'],
] as const
export const settings = [
 ['/app/numbers', 'Numbers'],
 ['/app/queues/settings', 'Queue setup'], ['/app/queues/media', 'Media routes'], ['/app/flows', 'Call flows'], ['/app/front-desk/settings', 'Front desk setup'], ['/app/receptionist/settings', 'Caller outcome limits'], ['/app/callbacks/settings', 'Callback policy'],
 ['/app/rules', 'Rules'], ['/app/operations', 'Continuity'], ['/app/dialer', 'Dialer'], ['/app/protection', 'Protection'],
 ['/app/sources', 'Sources'], ['/app/grants', 'Application grants'], ['/app/admin/templates', 'Templates'], ['/app/admin/bulk', 'Bulk administration'],
 ['/app/reports/queues', 'Queue reports'], ['/app/audit', 'Audit'], ['/app/import', 'Move in'], ['/auth/settings/identity', 'Account'],
] as const

const fontPreloads = ['/fonts/ibm-plex-sans/ibm-plex-sans-latin-wght.woff2', '/fonts/archivo/archivo-latin-wght.woff2']
 .map(href => `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin="anonymous">`).join('')

const bar = `<header class="hs-bar"><a class="hs-brand" href="/app"><img src="/brand/mark-keyline.svg" alt="" width="36" height="36"><span data-rer-name>${escape(branding.name)}</span></a>`
 + `<nav class="hs-tabs" aria-label="Handset">${work.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}</nav>`
 + `<details class="hs-menu"><summary>Settings</summary><nav aria-label="Settings">${settings.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}</nav></details></header>`

export const appHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'strict-origin', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'content-type': 'text/html; charset=utf-8' }
export const appPolicy = "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; style-src 'self'; font-src 'self'; img-src 'self'"

/** One signed-in document: the bar, then the page's own title and body inside main. */
export function appDocument(title: string, body: string, status = 200): Response {
 return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ${escape(branding.name)}</title>${fontHead}${fontPreloads}${iconHead}<link rel="stylesheet" href="/handset-app.css"></head><body class="hs">${bar}<main class="hs-main"><h1>${escape(title)}</h1>${body}</main></body></html>`,
  { status, headers: { ...appHeaders, 'content-security-policy': appPolicy } })
}

/** Marks the bar entry for the current path; a page under Settings marks Settings itself. */
export async function markCurrent(path: string, response: Response): Promise<Response> {
 if (!response.headers.get('content-type')?.startsWith('text/html') || !response.body) return response
 const within = (href: string) => path === href || path.startsWith(href + '/')
 // A setup page under a daily tab (Queue setup under Queues) belongs to Settings.
 const setting = settings.find(([href]) => within(href)), tab = setting ? undefined : work.find(([href]) => within(href))
 if (!tab && !setting) return response
 // The bar precedes main, so each first occurrence is the bar's own entry.
 let html = await response.text()
 if (tab) html = html.replace(`<a href="${tab[0]}">`, `<a href="${tab[0]}" aria-current="page">`)
 else if (setting) html = html.replace('<summary>Settings</summary>', '<summary data-current>Settings</summary>').replace(`<a href="${setting[0]}">`, `<a href="${setting[0]}" aria-current="page">`)
 // A page's own section tabs mark the link to this exact page too.
 const main = html.indexOf('<main'), own = `<a href="${path}">`
 if (main > 0) html = html.slice(0, main) + html.slice(main).replaceAll(own, () => `<a href="${path}" aria-current="page">`)
 return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers })
}
