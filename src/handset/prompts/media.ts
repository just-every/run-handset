import { boundedBody, Fault } from '../core'
import { maxUploadBytes } from './audio'

/** Bound decoded provider bytes even when Content-Length is absent or false. */
export async function audioResponse(response:Response):Promise<Uint8Array>{
 if(response.status!==200||!['audio/wav','audio/x-wav','audio/wave'].includes((response.headers.get('content-type')??'').split(';')[0].toLowerCase())||!response.body){
  await response.body?.cancel()
  throw new Fault('invalid_provider_audio',502)
 }
 return boundedBody(response,maxUploadBytes,'invalid_provider_audio',502)
}
