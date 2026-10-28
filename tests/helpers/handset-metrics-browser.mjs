import assert from 'node:assert/strict'

// Read the displayed report and source legs at the browser door.
export async function renderedQueueMetrics(page){
 return page.locator('main').evaluate(main=>{
  const pairs=dl=>[...dl.querySelectorAll('dt')].map(dt=>[dt.textContent.trim(),dt.nextElementSibling.textContent.trim()])
  const paragraphs=[...main.querySelectorAll('p')].map(p=>p.textContent.trim())
  const sourceHeading=[...main.querySelectorAll('h2')].find(h=>h.textContent==='Source entries')
  const agentHeading=[...main.querySelectorAll('h3')].find(h=>h.textContent==='synthetic-handset-agent-1')
  return {
   version:paragraphs.find(p=>p.startsWith('Finalized entries ·')),
   formula:paragraphs.find(p=>p.startsWith('Service level:')),
   measures:pairs(main.querySelector('dl')),
   agent:agentHeading?pairs(agentHeading.nextElementSibling):[],
   sources:sourceHeading?[...sourceHeading.nextElementSibling.querySelectorAll('li')].map(li=>li.textContent.trim()):[],
   provenance:paragraphs.find(p=>p.startsWith('Source revisions:')),
  }
 })
}
export function assertKnownRenderedQueueMetrics(report){
 assert.ok(report.version?.includes('Configuration'),'rendered formula and configuration versions')
 assert.match(report.formula,/include-abandons; answer target T 20s; short threshold S 5s/)
 const measures=Object.fromEntries(report.measures),agent=Object.fromEntries(report.agent)
 assert.equal(measures['Service level'],'40.00% (2 / 5)')
 assert.equal(measures['Average speed of answer (seconds)'],'17.5 (70 / 4)')
 assert.equal(measures['Eligible abandonment'],'20.00% (1 / 5)')
 assert.equal(measures['Mean eligible abandon wait (seconds)'],'40 (40 / 1)')
 assert.equal(measures['Average handled time (seconds)'],'60 (240 / 4)')
 assert.deepEqual([measures['talk Seconds'],measures['hold Seconds'],measures['wrap Seconds']],['160','40','40'])
 assert.deepEqual([agent['Staffed seconds'],agent['Logged-in seconds'],agent['Answered / missed offers'],agent.Occupancy],['600','630','4 / 1','40.00% (240 / 600)'])
 for(const [state,seconds] of Object.entries({available:200,ringing:60,talk:160,hold:40,wrap:40,break:30,unavailable:100,'logged-out':60}))assert.equal(agent[state],seconds+' seconds')
 assert.equal(report.sources.length,6)
 for(let index=1;index<=6;index++)assert.ok(report.sources.some(source=>source.startsWith('synthetic-handset-entry-'+index+' · ')))
 assert.ok(report.provenance?.includes('synthetic-handset-dataset-1'),'rendered original source identity')
}
