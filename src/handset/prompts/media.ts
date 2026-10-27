import { boundedBody, Fault } from '../core'
import { maxUploadBytes } from './audio'

/** Only a successful audio response may enter prompt normalization. */
export async function readPromptAudio(response:Response){
 if(response.status!==200||!/^audio\/(wav|wave|x-wav)(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){
  await response.body?.cancel()
  throw new Fault('prompt_audio_unavailable',502)
 }
 return boundedBody(response,maxUploadBytes,'prompt_audio_too_large')
}
