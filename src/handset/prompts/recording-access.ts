import type { Bindings } from '../../auth.server'
import { Fault } from '../core'
import { guard, sql } from '../delegation/store'
import { sourceFence, type Source } from '../providers/sources'

export interface RecordingAuthority {id:string;author_id:string;author_version:number;destination:string}
export function recordingFences(env:Bindings,source:Source,rec:RecordingAuthority){
 return [sourceFence(env,source),guard(env,`SELECT CASE WHEN EXISTS(
  SELECT 1 FROM hnd_prompt_recordings r JOIN oa_operators p ON p.id=r.author_id
  JOIN hnd_extensions x ON x.operator_id=p.id AND x.destination=r.destination AND x.active=1
  WHERE r.id=? AND r.author_id=? AND r.author_version=? AND p.version=r.author_version
  AND p.role='owner' AND p.status='active' AND r.expires_at>?
  AND r.state IN ('awaiting_call','authenticated')) THEN 1 ELSE 0 END`,rec.id,rec.author_id,rec.author_version,Date.now())]
}
export async function checkRecordingAuthority(env:Bindings,source:Source,rec:RecordingAuthority){
 try{await env.DB.batch([...recordingFences(env,source,rec),sql(env,'DELETE FROM hnd_guard')])}
 catch(error){if(String(error).includes('CHECK constraint failed'))throw new Fault('recording_authority_changed',409);throw error}
}
