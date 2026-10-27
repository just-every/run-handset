import assert from 'node:assert/strict'
import { post, signIn } from './handset-auth.mjs'

const groupNames={hour:'Calls by hour',person:'Calls by person (case owner)',number:'Calls by number',team:'Calls by reporting team',location:'Calls by reporting location'}
const groupRows=(page,dimension)=>page.getByRole('heading',{name:groupNames[dimension],exact:true}).locator('xpath=following-sibling::ul[1]')
const nativeTotals=page=>page.getByRole('heading',{name:'Customer calls',exact:true}).locator('xpath=following-sibling::dl[1]')
const total=(page,name)=>nativeTotals(page).locator('dt').filter({hasText:new RegExp('^'+name+'$')}).locator('xpath=following-sibling::dd[1]').innerText()
const sourceDetails=page=>page.locator('details').filter({has:page.getByText('Source calls and recovery cases',{exact:true})})
const dashboardForm=page=>page.locator('form[action="/app/reports/queues/dashboards"]')

async function openSources(page){
 const details=sourceDetails(page)
 if(!await details.evaluate(element=>element.open))await details.locator('summary').click()
 return details
}

async function assertSources(page,calls){
 const details=await openSources(page)
 const hrefs=await details.locator('a[href^="/app/records/"]').evaluateAll(links=>links.map(link=>link.getAttribute('href')))
 assert.deepEqual(new Set(hrefs),new Set(calls.map(call=>'/app/records/'+call.recordId)))
 assert.equal(hrefs.length,calls.length,'each selected customer call appears once despite transfer legs')
 return details
}

async function checkSelection(page,groups,metrics){
 const form=dashboardForm(page)
 for(const group of Object.keys(groupNames))assert.equal(await form.locator(`[name="group_${group}"]`).isChecked(),groups.includes(group),'retained group '+group)
 for(const metric of ['volume','answered','missed'])assert.equal(await form.locator(`[name="metric_${metric}"]`).isChecked(),metrics.includes(metric),'retained measure '+metric)
}

async function setSelection(page,groups,metrics){
 const form=dashboardForm(page)
 for(const group of Object.keys(groupNames))await form.getByLabel(group==='person'?'Person (case owner)':group,{exact:true}).setChecked(groups.includes(group))
 for(const metric of ['volume','answered','missed'])await form.getByLabel(metric,{exact:true}).setChecked(metrics.includes(metric))
}

async function assertFiltered(page,calls){
 assert.equal(await total(page,'volume'),'5')
 assert.equal(await total(page,'answered'),'0')
 assert.equal(await total(page,'missed'),'5')
 assert.equal(await total(page,'legs'),'0')
 assert.equal(await total(page,'Recovery cases with confirmed booking'),'1 of 2')
 const filters=page.locator('main p').filter({hasText:/^Customer-call filters:/})
 for(const filter of ['outcome: missed','team: Support','location: Austin'])assert.ok((await filters.innerText()).includes(filter))
 await assertSources(page,calls)
}

export async function reportingDashboardJourney({runtime,page,proof,click,cookie,analytics,configRevision=1}){
 assert.ok(cookie,'parent supplies the refreshed owner session after fixture time travel')
 const competingSession=await signIn(runtime)
 const allCalls=analytics.calls.slice(0,6),missedCalls=allCalls.filter((_,index)=>index!==2)
 const root=runtime.origin+'/app/reports/queues',live=root+'/live?queueId=*'
 const capture=async name=>{
  assert.equal(await page.locator('main input:not([type="hidden"]), main select, main textarea, main button, main a, main summary').evaluateAll(controls=>controls.every(control=>{
   const declared=control.getAttribute('aria-label')||control.getAttribute('title')||control.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' ')
   if(declared?.trim())return true
   if(control.matches('input, select, textarea'))return [...(control.labels??[])].some(label=>label.textContent.trim())
   return Boolean(control.textContent.trim())
  })),true,name+' controls have labels')
  await proof(name)
 }

 await page.goto(root)
 await page.getByRole('link',{name:'Reporting groups',exact:true}).click()
 await page.getByLabel('Business number (E.164)',{exact:true}).fill('+15125550125')
 await page.getByLabel('Reporting team',{exact:true}).fill('Support')
 await page.getByLabel('Reporting location',{exact:true}).fill('Austin')
 await click('Assign business number')
 const assignment=page.locator('form').filter({has:page.getByRole('button',{name:'Save assignment version',exact:true})})
 assert.equal(await assignment.getByLabel('Reporting team',{exact:true}).inputValue(),'Support')
 assert.equal(await assignment.getByLabel('Reporting location',{exact:true}).inputValue(),'Austin')
 await capture('reporting-groups-assigned')
 await assignment.getByLabel('Reporting team',{exact:true}).fill('Draft support')
 await assignment.getByLabel('Reporting location',{exact:true}).fill('Draft Austin')
 const competingAssignment=await post(runtime,'/api/handset/metrics/groups',{number:'+15125550125',team:'Concurrent support',location:'Concurrent Austin',revision:1},{cookie:competingSession.cookie})
 assert.equal(competingAssignment.status,201)
 const [groupConflict]=await Promise.all([
  page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===root.replace(runtime.origin,'')+'/groups'),
  click('Save assignment version'),
 ])
 assert.equal(groupConflict.status(),409)
 await page.getByRole('heading',{name:'Review assignment draft',exact:true}).waitFor()
 assert.equal(await page.getByLabel('Reporting team',{exact:true}).inputValue(),'Draft support')
 assert.equal(await page.getByLabel('Reporting location',{exact:true}).inputValue(),'Draft Austin')
 const assignmentComparison=page.locator('details').filter({has:page.getByText('Compare current assignment',{exact:true})})
 assert.ok((await assignmentComparison.innerText()).includes('Concurrent support'))
 assert.ok((await assignmentComparison.innerText()).includes('Concurrent Austin'))
 await capture('reporting-group-stale-draft-preserved')
 await page.getByLabel('Reporting team',{exact:true}).fill('Support')
 await page.getByLabel('Reporting location',{exact:true}).fill('Austin')
 await click('Save reviewed assignment')
 assert.equal(await assignment.getByLabel('Reporting team',{exact:true}).inputValue(),'Support')
 assert.equal(await assignment.getByLabel('Reporting location',{exact:true}).inputValue(),'Austin')
 await capture('reporting-group-reconciled')

 await page.goto(live)
 assert.equal(await total(page,'volume'),'6')
 assert.equal(await total(page,'Recovery cases with confirmed booking'),'1 of 2')
 for(const dimension of ['team','location'])assert.match(await groupRows(page,dimension).innerText(),/6 calls; 1 answered; 5 missed/)
 assert.match(await groupRows(page,'team').innerText(),/Support/)
 assert.match(await groupRows(page,'location').innerText(),/Austin/)
 const hours=await groupRows(page,'hour').innerText()
 assert.ok(hours.includes('GMT-05:00'));assert.ok(hours.includes('GMT-06:00'))
 assert.equal(await page.locator('form[action="/app/reports/queues/finalize"] input[name="configRevision"]').inputValue(),String(configRevision))
 await assertSources(page,allCalls)
 await capture('reporting-known-week-groups')

 await page.getByRole('link',{name:'Show missed',exact:true}).click()
 await groupRows(page,'team').getByRole('link',{name:'Support',exact:true}).click()
 await groupRows(page,'location').getByRole('link',{name:'Austin',exact:true}).click()
 await assertFiltered(page,missedCalls)
 const filteredUrl=page.url(),selected=new URL(filteredUrl).searchParams
 assert.equal(selected.get('outcome'),'missed');assert.equal(selected.get('team'),'Support');assert.equal(selected.get('location'),'Austin')
 await capture('reporting-filtered-missed')
 await sourceDetails(page).getByRole('link',{name:missedCalls[1].recordId,exact:true}).click()
 assert.equal(new URL(page.url()).pathname,'/app/records/'+missedCalls[1].recordId)
 await page.getByRole('heading',{name:'Source record',exact:true}).waitFor()
 assert.ok((await page.locator('main').innerText()).includes(missedCalls[1].caseId))
 await capture('reporting-source-drilldown')
 await page.goBack();await assertFiltered(page,missedCalls)

 const name='Austin missed customer calls',editedName='Austin missed recovery dashboard'
 await page.getByLabel('Dashboard name',{exact:true}).fill(name)
 await setSelection(page,['hour','team','location'],['volume','missed'])
 await click('Save dashboard')
 const dashboardUrl=page.url(),dashboardId=new URL(dashboardUrl).pathname.split('/').at(-1)
 assert.match(new URL(dashboardUrl).pathname,/^\/app\/reports\/queues\/dashboards\/[^/]+$/)
 await page.reload()
 assert.equal(await page.getByLabel('Dashboard name',{exact:true}).inputValue(),name)
 await checkSelection(page,['hour','team','location'],['volume','missed'])
 assert.equal(await page.getByRole('heading',{name:groupNames.person,exact:true}).count(),0)
 assert.equal(await page.getByRole('heading',{name:groupNames.number,exact:true}).count(),0)
 assert.match(await groupRows(page,'team').innerText(),/5 calls; 5 missed/)
 await assertFiltered(page,missedCalls)
 await capture('reporting-dashboard-saved')
 await page.getByRole('link',{name:'All queue reports',exact:true}).click()
 await page.getByRole('link',{name,exact:true}).click()
 assert.equal(page.url(),dashboardUrl)

 await page.getByLabel('Dashboard name',{exact:true}).fill(editedName)
 await setSelection(page,['person','team','location'],['missed'])
 const currentResponse=await runtime.request('/api/handset/metrics/dashboards/'+dashboardId,{headers:{cookie}})
 assert.equal(currentResponse.status,200)
 const current=(await currentResponse.json()).dashboard,competingName='Austin concurrent review'
 const competing=await post(runtime,'/api/handset/metrics/dashboards',{...current,name:competingName},{cookie:competingSession.cookie})
 assert.equal(competing.status,201)
 const [refused]=await Promise.all([
  page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/app/reports/queues/dashboards'),
  click('Update dashboard'),
 ])
 assert.equal(refused.status(),409,'a competing save refuses the stale browser draft')
 await page.getByRole('heading',{name:'Review dashboard draft',exact:true}).waitFor()
 assert.equal(await page.getByLabel('Dashboard name',{exact:true}).inputValue(),editedName)
 await checkSelection(page,['person','team','location'],['missed'])
 const comparison=page.locator('details').filter({has:page.getByText('Compare current dashboard',{exact:true})})
 assert.equal(await comparison.isVisible(),true)
 assert.ok((await comparison.innerText()).includes(competingName))
 assert.equal(await page.getByRole('button',{name:'Save reviewed dashboard',exact:true}).isVisible(),true)
 await capture('reporting-dashboard-stale-draft-preserved')
 await click('Save reviewed dashboard')
 assert.equal(page.url(),dashboardUrl)
 await page.reload()
 assert.equal(await page.getByLabel('Dashboard name',{exact:true}).inputValue(),editedName)
 await checkSelection(page,['person','team','location'],['missed'])
 assert.equal(await page.getByRole('heading',{name:groupNames.hour,exact:true}).count(),0)
 assert.equal(await page.getByRole('heading',{name:groupNames.person,exact:true}).count(),1)
 assert.match(await groupRows(page,'team').innerText(),/Support — 5 missed/)
 await assertFiltered(page,missedCalls)
 await capture('reporting-dashboard-edited')

 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Export customer call CSV',exact:true}).click()])
 const stream=await download.createReadStream(),chunks=[]
 for await(const chunk of stream)chunks.push(chunk)
 const csv=Buffer.concat(chunks).toString('utf8'),lines=csv.trimEnd().split('\r\n')
 assert.equal(lines.length,missedCalls.length+1,'download contains exactly the selected native source calls')
 assert.ok(lines[0].includes('"team","location"'))
 for(const call of missedCalls)assert.equal(lines.slice(1).filter(line=>line.includes(call.recordId)).length,1)
 for(const call of [allCalls[2],analytics.calls[6]])assert.ok(!csv.includes(call.recordId))
 for(const line of lines.slice(1))assert.ok(line.includes('"Support","Austin"'))

 await click('Save final report')
 const historyUrl=page.url()
 assert.match(new URL(historyUrl).pathname,/^\/app\/reports\/queues\/history\/[^/]+$/)
 await assertFiltered(page,missedCalls)
 assert.equal(await page.getByRole('heading',{name:groupNames.hour,exact:true}).count(),0)
 assert.equal(await page.getByRole('heading',{name:groupNames.person,exact:true}).count(),1)
 assert.match(await groupRows(page,'team').innerText(),/Support — 5 missed/)
 await capture('reporting-dashboard-retained-history')

 await page.goto(root+'/groups')
 await assignment.getByLabel('Reporting team',{exact:true}).fill('Care')
 await assignment.getByLabel('Reporting location',{exact:true}).fill('Dallas')
 await click('Save assignment version')
 await page.goto(live)
 assert.match(await groupRows(page,'team').innerText(),/Care — 6 calls/)
 assert.match(await groupRows(page,'location').innerText(),/Dallas — 6 calls/)
 await page.goto(historyUrl);await assertFiltered(page,missedCalls)
 assert.match(await groupRows(page,'team').innerText(),/Support — 5 missed/)
 assert.match(await groupRows(page,'location').innerText(),/Austin — 5 missed/)
 await capture('reporting-history-keeps-captured-groups')

 await page.goto(dashboardUrl)
 assert.equal(await total(page,'volume'),'0','saved customer-call filters remain exact after assignment changes')
 const recoveredName='Recovered Austin review'
 await page.getByLabel('Dashboard name',{exact:true}).fill(recoveredName)
 await setSelection(page,['hour','number'],['answered','missed'])
 const beforeDeletion=await runtime.request('/api/handset/metrics/dashboards/'+dashboardId,{headers:{cookie:competingSession.cookie}})
 assert.equal(beforeDeletion.status,200)
 const deleted=await post(runtime,'/api/handset/metrics/dashboards/'+dashboardId+'/delete',{revision:(await beforeDeletion.json()).dashboard.revision},{cookie:competingSession.cookie})
 assert.equal(deleted.status,200)
 const [deletedConflict]=await Promise.all([
  page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/app/reports/queues/dashboards'),
  click('Update dashboard'),
 ])
 assert.equal(deletedConflict.status(),409)
 await page.getByRole('heading',{name:'Review dashboard draft',exact:true}).waitFor()
 assert.equal(await page.getByLabel('Dashboard name',{exact:true}).inputValue(),recoveredName)
 await checkSelection(page,['hour','number'],['answered','missed'])
 assert.match(await page.getByRole('alert').innerText(),/deleted/)
 assert.equal(await dashboardForm(page).locator('input[name="id"]').count(),0)
 await capture('reporting-deleted-dashboard-draft-preserved')
 await click('Save as new dashboard')
 const recoveredUrl=page.url()
 assert.notEqual(recoveredUrl,dashboardUrl)
 await page.reload()
 assert.equal(await page.getByLabel('Dashboard name',{exact:true}).inputValue(),recoveredName)
 await checkSelection(page,['hour','number'],['answered','missed'])
 assert.equal(await total(page,'volume'),'0','recovered dashboard retains its exact customer-call filters')
 const original=await runtime.request('/api/handset/metrics/dashboards/'+dashboardId,{headers:{cookie}})
 assert.equal(original.status,404,'recovery creates a new dashboard without reviving the deleted identity')
 await capture('reporting-deleted-dashboard-recovered')
 await click('Delete saved dashboard')
 assert.equal(new URL(page.url()).pathname,'/app/reports/queues')
 assert.equal(await page.getByRole('link',{name:editedName,exact:true}).count(),0)
 await capture('reporting-dashboard-deleted')
 await page.goto(historyUrl);await assertFiltered(page,missedCalls)
 await capture('reporting-history-survives-dashboard-deletion')
 return {dashboardId,historyUrl,filteredUrl}
}
