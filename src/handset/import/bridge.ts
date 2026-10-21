import { Buffer } from 'node:buffer'
import { sha256 } from '../../modules/import-kit/src/provenance/identity'
import { Fault, text, type ObjectValue } from '../core'
import { namespace } from './source'

type Handler = (request: Request) => Promise<Response | null>
/** Plain forms are clients of the shared door, not another job/apply implementation. */
export function doorClient(request: Request, handle: Handler) {
 return async (action: string, value: unknown) => {
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  headers.set('content-type','application/json')
  headers.set('x-import-source',namespace)
  const response = await handle(new Request(new URL('/api/operator/import/'+action,request.url), {method:'POST',headers,body:JSON.stringify(value)}))
  if (!response) throw new Fault('import_route_unavailable',503)
  return { response, body:await response.json() as ObjectValue }
 }
}
export async function uploadForm(data: ObjectValue, call: ReturnType<typeof doorClient>) {
 const name=text(data.name,'name',200), sourceJson=typeof data.sourceJson==='string'?data.sourceJson:''
 const bytes = Buffer.from(sourceJson,'utf8')
 if (!bytes.length || bytes.length>2_097_152) throw new Fault('source_size_limit',413)
 const bundleSha256=sha256(bytes),totalChunks=Math.ceil(bytes.length/65_536)
 let uploadId:unknown
 for (let index=0;index<totalChunks;index++) {
  const chunk=bytes.subarray(index*65_536,(index+1)*65_536)
  const result=await call('uploads',{...(uploadId?{uploadId}:{}),name,bundleSha256,totalBytes:bytes.length,totalChunks,index,chunkSha256:sha256(chunk),base64:chunk.toString('base64')})
  if (!result.response.ok) return result
  uploadId=result.body.uploadId
 }
 return call('plan',{uploadId,...(data.catchup==='yes'?{catchup:true}:{})})
}
