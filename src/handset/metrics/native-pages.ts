import { escape as e } from '../core'
import type { NativeFilters } from './filters'
import type { liveReport } from './store'
type Report=Awaited<ReturnType<typeof liveReport>>
export function reportQuery(report:Report,filters:NativeFilters=report.native.filters) {
 return new URLSearchParams({queueId:report.config.queueId,configRevision:String(report.config.revision),...filters}).toString()
}
export function nativeBody(report:Report,interactive=false){
 const n=report.native
 if(!n)return ''
 const selected=report.dashboard
 const active=Object.entries(n.filters??{}).map(([key,v])=>`${key}: ${v}`).join('; ')
 const link=(filters:NativeFilters,label:string)=>`<a href="/app/reports/queues/live?${e(reportQuery(report,filters))}">${e(label)}</a>`
 const dimensions=selected?.groups??['hour','person','number','team','location']
 const metrics=selected?.metrics??['volume','answered','missed']
 const labels={hour:'Calls by hour',person:'Calls by person (case owner)',number:'Calls by number',team:'Calls by reporting team',location:'Calls by reporting location'}
 const groups={hour:n.byHour,person:n.byPerson,number:n.byNumber,team:n.byTeam??[],location:n.byLocation??[]}
 return `<h2>Customer calls</h2><p>${e(n.basis)}</p><p>Captured ${e(new Date(n.capturedAt).toISOString())}. Recovery and survey outcomes reflect this snapshot.</p><p>Customer-call filters: ${e(active||'All calls in this interval')}. Queue formulas and agent timelines retain the complete configured queue interval.</p>${interactive?`<p>${(['answered','missed','unknown'] as const).map(outcome=>link({...n.filters,outcome},'Show '+outcome)).join(' · ')} · ${link({},'Clear customer-call filters')}</p>`:''}<dl>${Object.entries(n.totals).map(([name,total])=>`<dt>${e(name)}</dt><dd>${total}</dd>`).join('')}<dt>First-call resolution</dt><dd>${n.fcr.value===null?'Unavailable':(100*n.fcr.value).toFixed(2)+'%'} (${n.fcr.numerator} of ${n.fcr.denominator})</dd><dt>Recovery cases with confirmed booking</dt><dd>${n.recovery.confirmed} of ${n.recovery.cases}</dd><dt>Survey response rate</dt><dd>${n.csat.responseRate===null?'Unavailable':(100*n.csat.responseRate).toFixed(2)+'%'} (${n.csat.responses} responses; ${n.csat.eligibleDelivered} eligible delivered; ${n.csat.invitations} invitations)</dd><dt>Customer rating</dt><dd>${n.csat.mean===null?'Unavailable':n.csat.mean.toFixed(2)+' of 5'}</dd></dl><p>${e(n.fcr.basis)}</p><p>FCR exclusions: ${n.fcr.excluded.immature} immature; ${n.fcr.excluded.unknownIdentity} unknown identity; ${n.fcr.excluded.repeatContact} repeat contacts.</p><p>${e(n.csat.basis)}</p>${dimensions.map(key=>`<h3>${labels[key]}</h3><ul>${groups[key].map(row=>`<li>${interactive?link({...n.filters,[key]:row.label},row.label):e(row.label)} — ${metrics.map(metric=>`${row[metric]} ${metric==='volume'?'calls':metric}`).join('; ')}</li>`).join('')||'<li>No calls in this interval.</li>'}</ul>`).join('')}<details><summary>Source calls and recovery cases</summary><ul>${n.sourceCalls.map(c=>`<li><a href="/app/records/${e(c.id)}">${e(c.id)}</a> · ${e(c.status)} · ${e(c.team)} · ${e(c.location)}${c.caseId?` · <a href="/app/cases/${e(c.caseId)}">Recovery case ${e(c.caseId)}</a>`:''}</li>`).join('')||'<li>No matching source calls.</li>'}</ul><p>Confirmed recovery case IDs: ${e(n.recovery.confirmedCaseIds.join(', ')||'None')}</p></details>`
}
