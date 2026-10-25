import { Fault, object, text } from '../core'

export type Provider = 'notion' | 'confluence' | 'google-drive' | 'upload'
export const maxBytes = 131072
/** Read only, bounded, fixed public API hosts. Redirects never receive a credential. */
async function read(url: string, token: string, accept = 'application/json', extra: Record<string,string> = {}) {
 let response: Response
 try { response = await fetch(url, { headers: { authorization: 'Bearer ' + token, accept, ...extra }, redirect: 'manual', signal: AbortSignal.timeout(8000) }) }
 catch { throw new Fault('knowledge_source_unavailable', 503) }
 if (!response.ok) { await response.body?.cancel(); throw new Fault(response.status === 401 || response.status === 403 || response.status === 404 ? 'knowledge_source_access_refused' : 'knowledge_source_unavailable', 409) }
 const reader = response.body?.getReader(); if (!reader) throw new Fault('knowledge_empty_source')
 const chunks: Uint8Array[] = []; let length = 0
 try {
  while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > maxBytes) throw new Fault('knowledge_source_too_large', 413); chunks.push(chunk.value) }
 } finally { await reader.cancel() }
 const bytes = new Uint8Array(length); let offset = 0
 for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
 try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Fault('knowledge_invalid_utf8') }
}
const parse = (raw: string) => { try { return object(JSON.parse(raw)) } catch { throw new Fault('knowledge_invalid_source') } }
export function extracted(raw: unknown) {
 const value = text(raw, 'document', maxBytes)
 if (new TextEncoder().encode(value).length > maxBytes) throw new Fault('knowledge_source_too_large', 413)
 if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(value)) throw new Fault('knowledge_malformed_document')
 return value
}
export async function fetchSource(provider: Provider, externalId: string, credential: string, cloudId: string) {
 if (!/^[A-Za-z0-9_-]{1,128}$/.test(externalId)) throw new Fault('knowledge_invalid_source_id')
 if (/[\r\n]/.test(credential)) throw new Fault('knowledge_invalid_credential')
 if (provider === 'notion') {
  const headers = { 'Notion-Version': '2022-06-28' }
  const page = parse(await read('https://api.notion.com/v1/pages/' + externalId, credential, 'application/json', headers))
  if (page.id !== externalId || page.archived || page.in_trash) throw new Fault('knowledge_source_access_refused', 409)
  const blocks = parse(await read('https://api.notion.com/v1/blocks/' + externalId + '/children?page_size=100', credential, 'application/json', headers))
  if (blocks.has_more || !Array.isArray(blocks.results)) throw new Fault('knowledge_incomplete_source', 409)
  const paragraphs = blocks.results.map(raw => {
   const b = object(raw), kind = String(b.type)
   if (b.has_children || !['paragraph','heading_1','heading_2','heading_3','bulleted_list_item','numbered_list_item','quote'].includes(kind)) throw new Fault('knowledge_unsupported_block', 409)
   const payload = object(b[kind]); if (!Array.isArray(payload.rich_text)) throw new Fault('knowledge_invalid_source')
   return payload.rich_text.map(raw => text(object(raw).plain_text, 'source_text', maxBytes, true)).join('')
  })
  const latest = parse(await read('https://api.notion.com/v1/pages/' + externalId, credential, 'application/json', headers))
  if (latest.id !== externalId || latest.archived || latest.in_trash || latest.last_edited_time !== page.last_edited_time) throw new Fault('knowledge_source_changed', 409)
  return { body: extracted(paragraphs.join('\n')), sourceRevision: text(page.last_edited_time, 'source_revision', 100), citation: 'https://www.notion.so/' + externalId.replaceAll('-', '') }
 }
 if (provider === 'confluence') {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(cloudId)) throw new Fault('knowledge_invalid_cloud_id')
  const page = parse(await read('https://api.atlassian.com/ex/confluence/' + cloudId + '/wiki/api/v2/pages/' + externalId + '?body-format=storage', credential))
  if (String(page.id) !== externalId || page.status !== 'current') throw new Fault('knowledge_source_access_refused', 409)
  const html = text(object(object(page.body).storage).value, 'source_text', maxBytes)
  // Complex macros, embedded content and scripts cannot silently become complete knowledge.
  if (/<(?:script|iframe|object|style|ac:|ri:)/i.test(html)) throw new Fault('knowledge_unsupported_markup', 409)
  const body = html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
  return { body: extracted(body), sourceRevision: String(object(page.version).number), citation: 'confluence:' + cloudId + ':' + externalId }
 }
 if (provider === 'google-drive') {
  const meta = parse(await read('https://www.googleapis.com/drive/v3/files/' + externalId + '?fields=id,mimeType,modifiedTime,version,trashed,webViewLink', credential))
  if (meta.id !== externalId || meta.trashed || meta.mimeType !== 'application/vnd.google-apps.document') throw new Fault('knowledge_unsupported_document', 409)
  const body = extracted(await read('https://www.googleapis.com/drive/v3/files/' + externalId + '/export?mimeType=text%2Fplain', credential, 'text/plain'))
  const latest = parse(await read('https://www.googleapis.com/drive/v3/files/' + externalId + '?fields=id,mimeType,modifiedTime,version,trashed,webViewLink', credential))
  if (latest.id !== externalId || latest.trashed || latest.version !== meta.version) throw new Fault('knowledge_source_changed', 409)
  return { body, sourceRevision: text(meta.version, 'source_revision', 100), citation: 'https://docs.google.com/document/d/' + externalId }
 }
 throw new Fault('knowledge_source_not_supported', 409)
}
