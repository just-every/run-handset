import { escape as e } from '../core'
import type { liveReport } from './store'

export function sourceEntriesBody(report:Awaited<ReturnType<typeof liveReport>>) {
 // Retained snapshots from before call linkage keep their original entry IDs.
 if(!report.sourceEntries)return report.sourceEntryIds.map(source=>`<li>${e(source)}</li>`).join('')||'<li>No entries in this interval.</li>'
 return report.sourceEntries.map(source=>{
  const wait=source.answeredAt!==undefined?(source.answeredAt-source.enteredAt)/1000:source.abandonedAt!==undefined?(source.abandonedAt-source.enteredAt)/1000:null
  const call=source.canonicalCallId?`<a href="/app/records/${e(source.canonicalCallId)}">${e(source.canonicalCallId)}</a>`:e(source.callId)+' (supplied identity; no matching canonical call in this selection)'
  return `<li>${e(source.id)} · ${call} · ${e(source.kind)}${source.parentEntryId?' · Parent entry '+e(source.parentEntryId):''}<p>Wait: ${wait===null?'Provisional':wait+' seconds'} · Talk ${source.talkSeconds}s · Hold ${source.holdSeconds}s · Wrap ${source.wrapSeconds}s · ${source.answeredAt!==undefined?'Answered':source.abandonedAt!==undefined?'Abandoned':'Provisional'}</p></li>`
 }).join('')||'<li>No entries in this interval.</li>'
}
