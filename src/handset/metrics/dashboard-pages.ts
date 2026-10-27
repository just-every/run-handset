import { escape as e, field, hidden } from '../core'
import { dashboardGroups, dashboardMetrics, type Dashboard } from './dashboards'
import type { liveReport } from './store'

export function dashboardEditor(report:Awaited<ReturnType<typeof liveReport>>,draft?:Partial<Dashboard>,current?:Dashboard,deleted=false) {
 const d=draft??report.dashboard,c=report.config,saved=Boolean(d?.id)
 return `<h2>${saved?'Edit saved dashboard':'Save a custom dashboard'}</h2><p>A dashboard retains this exact formula revision and customer-call filters. Opening or exporting it checks your current report permissions. Queue formulas retain the complete configured queue interval.</p><form method="post" action="/app/reports/queues/dashboards">${saved?hidden('id',d!.id):''}${hidden('revision',d?.revision??0)}${hidden('queueId',c.queueId)}${hidden('configRevision',c.revision)}${hidden('filters',JSON.stringify(d?.filters??report.native.filters))}${field('Dashboard name','name',d?.name??'')}<fieldset><legend>Group customer calls</legend>${dashboardGroups.map(group=>`<label><input type="checkbox" name="group_${group}" value="${group}" ${(d?.groups??dashboardGroups).includes(group)?'checked':''}>${e(group==='person'?'Person (case owner)':group)}</label>`).join('')}</fieldset><fieldset><legend>Measures in each group</legend>${dashboardMetrics.map(metric=>`<label><input type="checkbox" name="metric_${metric}" value="${metric}" ${(d?.metrics??dashboardMetrics).includes(metric)?'checked':''}>${e(metric)}</label>`).join('')}</fieldset><button>${deleted?'Save as new dashboard':saved?'Update dashboard':'Save dashboard'}</button>${current?`<details open><summary>Compare current dashboard</summary><p>Your submitted draft is kept above. Review the current saved definition before replacing it.</p>${comparisonValues(current)}<button name="revision" value="${current.revision}">Save reviewed dashboard</button></details>`:''}</form>${saved&&!draft?`<form method="post" action="/app/reports/queues/dashboards/${e(d!.id)}/delete">${hidden('revision',d!.revision)}<button>Delete saved dashboard</button></form>`:''}`
}
export function dashboardList(rows:Dashboard[]) {
 return `<h2>Saved dashboards</h2><ul>${rows.map(d=>`<li><a href="/app/reports/queues/dashboards/${e(d.id)}">${e(d.name)}</a> · ${e(d.queueId)} · formula ${d.configRevision}</li>`).join('')||'<li>No saved dashboards. Open a configured report to save one.</li>'}</ul>`
}

function comparisonValues(current:Dashboard) {
 const values=[['Name',current.name],['Queue',current.queueId],['Formula revision',current.configRevision],['Customer-call filters',Object.entries(current.filters).map(([key,value])=>key+': '+value).join('; ')||'All calls'],['Groups',current.groups.join(', ')],['Group measures',current.metrics.join(', ')]]
 return `<dl>${values.map(([label,value])=>`<dt>${e(label)}</dt><dd>${e(value)}</dd>`).join('')}</dl>`
}
