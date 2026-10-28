import assert from 'node:assert/strict'

// Read only rendered report content, independently of the report API and calculator.
export async function readMetricReport(page) {
 return page.locator('main').evaluate(main => {
  const definitions = list => list ? Object.fromEntries([...list.querySelectorAll(':scope > dt')].map(term => [term.textContent.trim(), term.nextElementSibling?.textContent.trim()])) : null
  const paragraphs = [...main.querySelectorAll(':scope > p')].map(p => p.textContent.trim())
  const version = paragraphs.find(p => p.startsWith('Finalized entries · '))?.match(/^Finalized entries · (.+) · Configuration (\d+)$/)
  const agent = [...main.querySelectorAll('h3')].find(h => h.textContent === 'synthetic-handset-agent-1')
  const sources = [...main.querySelectorAll('h2')].find(h => h.textContent === 'Source entries')?.nextElementSibling
  return {
   formulaVersion: version?.[1], configuration: version ? Number(version[2]) : null,
   interval: paragraphs.find(p => p.includes('Display timezone:')),
   policy: paragraphs.find(p => p.startsWith('Service level:')),
   metrics: definitions(main.querySelector('dl')),
   agent: definitions(agent?.nextElementSibling),
   exclusions: paragraphs.find(p => p.startsWith('Excluded from staffed denominator:')),
   sources: sources ? [...sources.children].map(li => li.textContent.trim()) : null,
   provenance: paragraphs.find(p => p.startsWith('Source revisions:')),
  }
 })
}

export function assertKnownMetricReport(report, { configuration, serviceLevel = '40.00% (2 / 5)', abandonment = '20.00% (1 / 5)', abandonWait = '40 (40 / 1)', method = 'include-abandons', target = 20, short = 5 } = {}) {
 assert.ok(report.formulaVersion, 'The completed report discloses its formula version')
 if (configuration !== undefined) assert.equal(report.configuration, configuration)
 else assert.ok(report.configuration > 0, 'The completed report discloses its configuration version')
 assert.match(report.interval, /^2026-07-15T15:00:00\.000Z to 2026-07-15T15:20:00\.000Z, end excluded\. Display timezone: America\/Chicago\./)
 assert.ok(report.policy.startsWith(`Service level: ${method}; answer target T ${target}s; short threshold S ${short}s; short abandons excluded.`))
 assert.deepEqual(report.metrics, {
  'Service level': serviceLevel,
  'Average speed of answer (seconds)': '17.5 (70 / 4)',
  'Eligible abandonment': abandonment,
  'Mean eligible abandon wait (seconds)': abandonWait,
  'Average handled time (seconds)': '60 (240 / 4)',
  offered: '6', arrivals: '6', transfers: '0', overflows: '0', callbacks: '0', answered: '4', abandoned: '2',
  'eligible Abandons': short === 0 ? '2' : '1', 'short Abandons': short === 0 ? '0' : '1',
  'within Target': target === 30 ? '4' : '2', 'completed Handled': '4',
  'talk Seconds': '160', 'hold Seconds': '40', 'wrap Seconds': '40',
 })
 assert.deepEqual(report.agent, {
  Occupancy: '40.00% (240 / 600)', 'Staffed seconds': '600', 'Logged-in seconds': '630', 'Answered / missed offers': '4 / 1',
  available: '200 seconds', ringing: '60 seconds', talk: '160 seconds', hold: '40 seconds', wrap: '40 seconds',
  break: '30 seconds', unavailable: '100 seconds', 'logged-out': '60 seconds',
 })
 assert.equal(report.exclusions, 'Excluded from staffed denominator: break, logged-out.')
 assert.deepEqual(report.sources, [5, 10, 25, 30, 3, 40].map((wait, index) =>
  `synthetic-handset-entry-${index + 1} · synthetic-handset-call-${index + 1} (supplied identity; no matching canonical call in this selection) · inboundWait: ${wait} seconds · Talk ${index < 4 ? 40 : 0}s · Hold ${index < 4 ? 10 : 0}s · Wrap ${index < 4 ? 10 : 0}s · ${index < 4 ? 'Answered' : 'Abandoned'}`))
 assert.ok(report.provenance.includes('synthetic-handset-dataset-1 v'), 'Source dataset revision is disclosed')
 assert.match(report.provenance, /Source hash: [a-f0-9]{64}\./)
}
